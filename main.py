"""
LanChat 主程序 —— FastAPI 后端。

功能:
  - 提供 WebUI 页面
  - REST API：自身信息、在线节点、联系人列表、修改昵称
  - 控制 WS /ws/control：自己浏览器 ↔ 自己后端
  - 聊天 WS /ws/chat：其他用户浏览器 ↔ 自己后端（需 Token 验证 + 用户确认）
  - HTTP API：文件分片上传（支持断点续传、取消传输）
"""

import asyncio
import base64
import os
import socket
import threading
import time
import uuid as uuid_lib
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from discovery import Discovery, TokenManager
from storage import (
    append_message,
    cleanup_expired_progress,
    delete_contact,
    delete_progress,
    ensure_data_dir,
    get_contact,
    get_download_path,
    get_messages,
    list_contacts,
    load_config,
    load_progress,
    remove_deleted_tombstones,
    save_config,
    save_progress,
    upsert_contact,
)

# ============================================================
# 配置初始化
# ============================================================


def get_local_ip() -> str:
    """获取本机局域网 IP（优先外网探测，无外网时枚举网卡）"""
    # 方法1：通过连接外网获取（有互联网时最可靠）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip != "127.0.0.1":
            return ip
    except OSError:
        pass

    # 方法2：无外网时枚举网卡获取第一个非回环 IP（Linux）
    try:
        import fcntl
        import struct
        for iface_name, _ in socket.if_nameindex():
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                ip_bytes = fcntl.ioctl(
                    s.fileno(), 0x8915,
                    struct.pack("256s", iface_name[:15].encode())
                )[20:24]
                s.close()
                ip = socket.inet_ntoa(ip_bytes)
                if ip and ip != "127.0.0.1" and not ip.startswith("169.254."):
                    return ip
            except Exception:
                continue
    except (ImportError, OSError, AttributeError):
        pass

    # 方法3：通过 getaddrinfo 解析本机名兜底
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and ip != "127.0.0.1" and not ip.startswith("169.254."):
                return ip
    except OSError:
        pass

    # 方法4：通过系统命令获取本机 IP（Linux hostname -I / ip addr / Windows ipconfig）
    try:
        import subprocess
        import re

        # 4a. Linux: hostname -I（输出所有非回环 IP，空格分隔，最简洁可靠）
        try:
            result = subprocess.run(
                ["hostname", "-I"], capture_output=True, text=True, timeout=3
            )
            ips = result.stdout.strip().split()
            for ip in ips:
                if ip and ip != "127.0.0.1" and not ip.startswith("169.254."):
                    return ip
        except Exception:
            pass

        # 4b. Linux: ip addr show（备选，解析 inet 地址）
        try:
            result = subprocess.run(
                ["ip", "addr", "show"], capture_output=True, text=True, timeout=3
            )
            for line in result.stdout.splitlines():
                m = re.search(r'inet\s+([\d.]+)', line)
                if m:
                    ip = m.group(1)
                    if ip and ip != "127.0.0.1" and not ip.startswith("169.254."):
                        return ip
        except Exception:
            pass

        # 4c. Windows: ipconfig（适配虚拟机仅主机模式等场景）
        try:
            result = subprocess.run(
                ["ipconfig"], capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.splitlines():
                m = re.search(r'IPv4[^:]*?:\s*([\d.]+)', line)
                if m:
                    ip = m.group(1)
                    if ip and ip != "127.0.0.1" and not ip.startswith("169.254."):
                        return ip
        except Exception:
            pass

    except Exception:
        pass

    return "127.0.0.1"


def find_available_port(start: int = 50002, max_tries: int = 10) -> int:
    """从 start 开始查找可用端口，最多尝试 max_tries 次"""
    for offset in range(max_tries):
        port = start + offset
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("0.0.0.0", port))
            s.close()
            return port
        except OSError:
            continue
    return start  # 全部被占用，返回原始端口（启动时会自然报错）


# 加载或创建本机配置
ensure_data_dir()
config = load_config()

if not config.get("uuid"):
    # 首次启动：生成 UUID，默认昵称取主机名
    config["uuid"] = uuid_lib.uuid4().hex[:12]
    config["name"] = socket.gethostname()
    save_config(config)

# 找到可用端口（必须在 MY_UUID 之前，因为 UUID 需要带上端口防同机冲突）
# 如果设置了 LANCHAT_PORT 环境变量则直接使用，否则自动查找（同机多实例需手动指定避免竞态）
_env_port = os.environ.get("LANCHAT_PORT", "")
WS_PORT: int = int(_env_port) if _env_port else find_available_port()

MY_UUID: str = f"{config['uuid']}_{WS_PORT}"  # 端口后缀确保同机多实例 UUID 唯一
MY_NAME: str = config.get("name", socket.gethostname())
MY_IP: str = get_local_ip()
NETWORK_SEGMENT: str = ".".join(MY_IP.split(".")[:3]) + ".0/24"

# 清理过期进度文件
cleanup_expired_progress(max_age_hours=24)

# 一次性清理旧版本（v32）遗留的"墓碑"联系人记录，改回完整删除语义
remove_deleted_tombstones()

# 初始化 Token 管理器和节点发现
token_manager = TokenManager()
discovery = Discovery(
    my_uuid=MY_UUID,
    my_name=MY_NAME,
    my_ip=MY_IP,
    ws_port=WS_PORT,
    token_manager=token_manager,
)

# ============================================================
# 全局状态
# ============================================================

# 控制 WS：自己浏览器 ↔ 自己后端（只有一条）
control_ws: WebSocket | None = None

# 事件循环引用（用于从 discovery 线程回调到 asyncio）
_main_loop: asyncio.AbstractEventLoop | None = None

# 活跃的聊天连接：uuid → WebSocket（其他用户浏览器连进来的）
active_chats: dict[str, WebSocket] = {}

# 待确认的连接请求：uuid → {ws, name, uuid}
pending_connections: dict[str, dict] = {}

# 文件传输状态：transfer_id → 传输元信息
transfers: dict[str, dict] = {}
transfer_locks: dict[str, threading.Lock] = {}

# 锁
_chats_lock = threading.Lock()
_pending_lock = threading.Lock()


# ============================================================
# FastAPI 应用
# ============================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动发现服务，关闭时清理"""
    global _main_loop
    _main_loop = asyncio.get_running_loop()

    # 注册 discovery 回调（包装为线程安全版本）
    discovery.on_peer_online = _make_threadsafe(_notify_peer_online)
    discovery.on_peer_offline = _make_threadsafe(_notify_peer_offline)
    discovery.start()
    # 启动后探活已存联系人（跨子网场景自动发现）
    asyncio.create_task(_probe_saved_contacts())
    print(f"[LanChat] 已启动: http://localhost:{WS_PORT}")
    print(f"  昵称: {MY_NAME}  网段: {NETWORK_SEGMENT}")
    yield
    # 关闭
    discovery.stop()
    print("[LanChat] 已停止")


def _make_threadsafe(async_func):
    """
    包装异步函数，使其能从 discovery 的后台线程中安全调用。
    通过 asyncio.run_coroutine_threadsafe 将协程调度到主事件循环。
    """
    def wrapper(data: dict):
        if _main_loop and _main_loop.is_running():
            asyncio.run_coroutine_threadsafe(async_func(data), _main_loop)
    return wrapper


async def _verify_token_via_api(uuid: str, token: str, ip: str, port: int) -> bool:
    """
    跨子网 Token 验证：通过 HTTP 反向调用发起方的 /api/me 获取真实 token 并比对。

    用于 UDP 广播到不了的场景——发起方不在本机 peer_list 中，但 TCP 可达。
    用 asyncio.to_thread 跑同步 urllib 请求，不阻塞事件循环。
    """
    import json as _json
    import urllib.request as _urllib

    try:
        def _fetch():
            url = f"http://{ip}:{port}/api/me"
            with _urllib.urlopen(url, timeout=3) as resp:
                return _json.loads(resp.read().decode("utf-8"))

        data = await asyncio.to_thread(_fetch)
        return data.get("uuid") == uuid and data.get("token") == token
    except Exception:
        return False


async def _probe_saved_contacts():
    """
    定期对历史联系人中未被 UDP 广播发现的进行 HTTP 探活。
    跨子网的联系人 UDP 广播发现不了，但 TCP 可达，通过此方式：
      1. 启动后自动发现跨子网上线
      2. 持续更新 last_seen 防止被 UDP 超时检查踢下线
    """
    import json as _json
    import urllib.request as _urllib

    await asyncio.sleep(3)  # 等 UDP 广播先跑一轮

    # 定期探活：第一轮跑完后每 30 秒一轮
    PROBE_INTERVAL = 30

    while True:
        try:
            for c in list_contacts():
                # 过滤自己
                if c.get("uuid") == MY_UUID:
                    continue
                ip = c.get("ip", "")
                if not ip or ip == "127.0.0.1":
                    continue
                # 已被 UDP 广播发现的跳过（同子网，UDP 会自动续 last_seen）
                if any(p["uuid"] == c["uuid"] for p in discovery.get_peers()):
                    continue

                try:
                    ws_port = c.get("ws_port", 50002)

                    def _fetch():
                        url = f"http://{ip}:{ws_port}/api/me"
                        with _urllib.urlopen(url, timeout=1.5) as resp:
                            return _json.loads(resp.read().decode("utf-8"))

                    data = await asyncio.to_thread(_fetch)
                    if data.get("uuid") == c["uuid"]:
                        # 在线！刷新 peer_list 中的 last_seen（阻止超时踢下线）
                        with discovery._lock:
                            existing = discovery._peers.get(c["uuid"], {})
                            discovery._peers[c["uuid"]] = {
                                "uuid": c["uuid"],
                                "name": data.get("name", c.get("name", "Unknown")),
                                "ip": ip,
                                "ws_port": data.get("ws_port", 50002),
                                "token": data.get("token", ""),
                                "previous_token": existing.get("token", ""),
                                "last_seen": time.time(),
                                "miss_count": 0,
                                "status": "online",
                            }
                            is_new_or_offline = (
                                not existing
                                or existing.get("status") != "online"
                            )
                        if is_new_or_offline:
                            await _notify_peer_online(
                                discovery._peers[c["uuid"]].copy()
                            )
                except Exception:
                    pass
        except Exception:
            pass

        await asyncio.sleep(PROBE_INTERVAL)


app = FastAPI(title="LanChat", lifespan=lifespan)

# CORS：允许跨域请求（其他节点的浏览器直接访问本机 HTTP API）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# 通知辅助函数（discovery / chat → control WS → 浏览器）
# ============================================================


async def _notify_peer_online(peer: dict):
    """discovery 回调：节点上线 → 通知浏览器（含 token，供前端建立连接时出示）"""
    # 只在历史联系人已存在时才更新 name/ip（不把 UDP 发现的每个人都写入历史联系人）
    if get_contact(peer["uuid"]):
        upsert_contact(
            peer["uuid"], peer["name"],
            peer.get("ip", ""), peer.get("ws_port", 50002),
        )
    if control_ws:
        try:
            await control_ws.send_json({
                "type": "peer_online",
                "uuid": peer["uuid"],
                "name": peer["name"],
                "ip": peer["ip"],
                "ws_port": peer.get("ws_port", 50002),
                "token": peer.get("token", ""),
            })
        except Exception:
            pass


async def _notify_peer_offline(peer: dict):
    """discovery 回调：节点离线 → 通知浏览器"""
    if control_ws:
        try:
            await control_ws.send_json({
                "type": "peer_offline",
                "uuid": peer["uuid"],
                "name": peer["name"],
            })
        except Exception:
            pass


async def _notify_browser(msg: dict):
    """向自己浏览器发送控制消息"""
    if control_ws:
        try:
            await control_ws.send_json(msg)
        except Exception:
            pass


async def _safe_send(ws: WebSocket, msg: dict):
    """安全发送 WebSocket 消息，忽略发送失败"""
    try:
        await ws.send_json(msg)
    except Exception:
        pass


async def _notify_pending_update():
    """通知浏览器待处理连接请求数量变化"""
    with _pending_lock:
        count = len(pending_connections)
    await _notify_browser({"type": "pending_update", "count": count})

# ============================================================
# REST API
# ============================================================


@app.get("/api/me")
async def api_me():
    """返回本机信息（含当前 token，前端建立连接时需出示给对方验证）"""
    return {
        "uuid": MY_UUID,
        "name": MY_NAME,
        "ip": MY_IP,
        "network": NETWORK_SEGMENT,
        "ws_port": WS_PORT,
        "token": token_manager.get_token(),
    }


@app.get("/api/peers")
async def api_peers():
    """返回当前在线节点列表"""
    return discovery.get_peers()


@app.get("/api/contacts")
async def api_contacts():
    """
    返回历史联系人列表，合并在线状态。
    在线列表里的人显示 🟢，不在的显示 🔴。
    """
    contacts = list_contacts()
    online_peers = {p["uuid"]: p for p in discovery.get_peers()}
    for c in contacts:
        c["status"] = "online" if c["uuid"] in online_peers else "offline"
    return contacts


@app.get("/api/messages/{uuid}")
async def api_messages(uuid: str):
    """返回指定联系人的聊天记录"""
    return get_messages(uuid)


@app.post("/api/config")
async def api_update_config(request: Request):
    """修改本机昵称"""
    global MY_NAME
    data = await request.json()
    new_name = data.get("name", "").strip()
    if not new_name:
        raise HTTPException(400, "名称不能为空")
    MY_NAME = new_name
    config["name"] = new_name
    save_config(config)
    discovery.my_name = new_name
    return {"status": "ok", "name": new_name}


@app.delete("/api/contacts/{uuid}")
async def api_delete_contact(uuid: str):
    """删除联系人及聊天记录"""
    delete_contact(uuid)
    return {"status": "ok"}


@app.get("/api/pending")
async def api_pending():
    """返回待处理的连接请求列表"""
    with _pending_lock:
        return [
            {"uuid": uuid, "name": info.get("name", "Unknown")}
            for uuid, info in pending_connections.items()
        ]


# ============================================================
# WebSocket：控制通道（自己浏览器 ↔ 自己后端）
# ============================================================


@app.websocket("/ws/control")
async def ws_control(ws: WebSocket):
    """
    自己的浏览器通过此通道与后端通信。

    接收浏览器的指令:
      - update_name:    修改昵称
      - connection_response: 对连接请求做出同意/拒绝
      - file_response:  对文件传输请求做出接受/拒绝
      - file_cancel:    取消正在接收的文件传输
      - chat_message:   发送聊天消息（中转给目标对端 WS）

    后端推送给浏览器的通知:
      - init:                   初始化配置
      - peer_online/offline:    节点上下线
      - incoming_connection:    有新连接请求
      - pending_update:         待处理请求数量变化
      - chat_message:           收到的聊天消息
      - incoming_file_request:  文件传输请求
      - transfer_progress:      文件接收进度
      - transfer_complete:      文件接收完成
    """
    global control_ws, MY_NAME
    await ws.accept()
    control_ws = ws

    # 发送初始化配置（含联系人 + 在线节点 + token，页面加载即刻正确显示状态）
    # 过滤掉自己的 UUID（同机多实例时各实例 UUID 不同，但以防万一）
    init_contacts = [c for c in list_contacts() if c.get("uuid") != MY_UUID]
    online_peers_list = [p for p in discovery.get_peers() if p.get("uuid") != MY_UUID]
    online_peer_ids = {p["uuid"] for p in online_peers_list}
    for c in init_contacts:
        c["status"] = "online" if c["uuid"] in online_peer_ids else "offline"

    await ws.send_json({
        "type": "init",
        "uuid": MY_UUID,
        "name": MY_NAME,
        "ip": MY_IP,
        "network": NETWORK_SEGMENT,
        "ws_port": WS_PORT,
        "token": token_manager.get_token(),
        "contacts": init_contacts,
        "online_peers": online_peers_list,
        "active_peers": list(active_chats.keys()),
    })

    try:
        while True:
            msg = await ws.receive_json()
            msg_type = msg.get("type", "")

            if msg_type == "update_name":
                new_name = msg.get("name", "").strip()
                if new_name:
                    MY_NAME = new_name
                    config["name"] = new_name
                    save_config(config)
                    discovery.my_name = new_name
                    await ws.send_json({"type": "name_updated", "name": new_name})

            elif msg_type == "connection_response":
                await _handle_connection_response(msg)

            elif msg_type == "file_response":
                await _handle_file_response(msg)

            elif msg_type == "file_cancel":
                await _handle_file_cancel(msg)

            elif msg_type == "disconnect":
                await _handle_disconnect_from_browser(msg)

            elif msg_type == "register_transfer":
                # 浏览器收到 chat WS 发来的 file_request 后，在自己后端注册 transfer
                transfer_id = msg.get("transfer_id", "")
                if transfer_id:
                    transfers[transfer_id] = {
                        "transfer_id": transfer_id,
                        "file_name": msg.get("file_name", ""),
                        "file_size": msg.get("file_size", 0),
                        "total_chunks": msg.get("total_chunks", 0),
                        "chunk_size": msg.get("chunk_size", 65536),
                        "from_uuid": msg.get("from_uuid", ""),
                        "from_name": msg.get("from_name", ""),
                        "status": "pending",
                        "created_at": datetime.now().isoformat(),
                    }

            elif msg_type == "chat_message":
                await _handle_chat_message_from_browser(msg)

            elif msg_type == "file_request":
                # 浏览器通过 control WS 转发文件请求（sendFile 回退路径）
                await _handle_file_request_from_browser(msg)

            elif msg_type == "save_message":
                # 浏览器请求保存一条消息到本地 contacts（发/收消息时调用）
                await _handle_save_message(msg)

            elif msg_type == "save_contact":
                # 浏览器请求保存联系人的基本信息（连接建立后调用）
                uuid = msg.get("uuid", "")
                name = msg.get("name", "")
                ip_addr = msg.get("ip", "")
                ws_port = msg.get("ws_port", 50002)
                if uuid:
                    upsert_contact(uuid, name, ip_addr, ws_port)

            elif msg_type == "mark_untrusted":
                # 浏览器请求将某联系人标记为不可信（对方删除了我们）
                uuid = msg.get("uuid", "")
                if uuid:
                    from storage import mark_contact_untrusted
                    mark_contact_untrusted(uuid)
                    await _notify_browser({
                        "type": "contact_untrusted",
                        "uuid": uuid,
                    })

            elif msg_type == "delete_contact":
                # 浏览器请求删除联系人 → 清理所有关联数据
                uuid = msg.get("uuid", "")
                if uuid:
                    # 0. 通知对端标记我们为不可信（不删数据，只设 trusted=false）
                    #    这样后续任一方重连都需要重新验证
                    with _chats_lock:
                        peer_ws = active_chats.get(uuid)
                    if peer_ws:
                        try:
                            await _safe_send(peer_ws, {
                                "type": "contact_untrusted",
                                "uuid": MY_UUID,
                                "name": MY_NAME,
                            })
                        except Exception:
                            pass

                    # 1. 关闭与该对端的活跃聊天连接
                    with _chats_lock:
                        peer_ws = active_chats.pop(uuid, None)
                    if peer_ws:
                        try:
                            await peer_ws.close()
                        except Exception:
                            pass
                    # 2. 清理待确认的连接请求
                    with _pending_lock:
                        pending_connections.pop(uuid, None)
                    # 3. 清理进行中的文件传输
                    for tid, t in list(transfers.items()):
                        if t.get("from_uuid") == uuid or t.get("to_uuid") == uuid:
                            transfers.pop(tid, None)
                            delete_progress(tid)
                    # 4. 删除联系人及聊天记录
                    delete_contact(uuid)
                    # 5. 通知浏览器状态已清理
                    await _notify_browser({
                        "type": "contact_deleted",
                        "uuid": uuid,
                    })

    except WebSocketDisconnect:
        control_ws = None


async def _handle_connection_response(msg: dict):
    """
    浏览器对连接请求做出响应。

    msg: {type, to_uuid, accepted: bool}
    通过 asyncio.Event 通知 ws_chat 协程继续执行。
    """
    target_uuid = msg.get("to_uuid", "")
    accepted = msg.get("accepted", False)

    with _pending_lock:
        pending_info = pending_connections.get(target_uuid)

    if not pending_info:
        return

    peer_ws: WebSocket = pending_info["ws"]
    event: asyncio.Event = pending_info["event"]

    if accepted:
        # 先通过 Event 通知 ws_chat 继续（它会发送 connect_accepted + 进入消息循环）
        pending_info["accepted"] = True
        event.set()
        # 发送确认给对方（含本机身份，供跨子网手动连接方识别）
        try:
            await peer_ws.send_json({
                "type": "connect_accepted",
                "uuid": MY_UUID,
                "name": MY_NAME,
                "ip": MY_IP,
                "ws_port": WS_PORT,
            })
        except Exception:
            pass
    else:
        # 拒绝：关闭 WS
        try:
            await peer_ws.send_json({"type": "connect_rejected"})
        except Exception:
            pass
        try:
            await peer_ws.close()
        except Exception:
            pass
        event.set()


async def _handle_save_message(msg: dict):
    """
    浏览器请求保存消息到本地 contacts。
    用于 chat WS 直连收发的消息（绕过本后端的 _relay_from_peer），
    浏览器收到/发出消息后调此接口持久化。

    msg: {type, peer_uuid, sender, content, msg_id,
          msg_type: "chat"|"file",
          file_name, file_size, transfer_id, status, progress}  (文件消息专用)
    """
    peer_uuid = msg.get("peer_uuid", "")
    sender = msg.get("sender", "")  # "me" 或 peer_uuid
    content = msg.get("content", "")
    msg_id = msg.get("msg_id", "")
    msg_type = msg.get("msg_type", "chat")
    if peer_uuid and msg_id:
        extra = {}
        if msg_type == "file":
            for key in ("file_name", "file_size", "transfer_id", "status", "progress"):
                if key in msg:
                    extra[key] = msg[key]
        append_message(peer_uuid, sender, content, msg_id, msg_type=msg_type, **extra)


async def _handle_disconnect_from_browser(msg: dict):
    """
    浏览器请求主动断开与某对端的 WS 连接。
    直接关闭服务端 active_chats 中的 WS → 对端 ws.onclose 触发
    → 对端后端 ws_chat 的 finally 发送 peer_disconnected → 对端浏览器收到通知。
    msg: {type, to_uuid}
    """
    target_uuid = msg.get("to_uuid", "")
    if not target_uuid:
        return

    with _chats_lock:
        peer_ws = active_chats.pop(target_uuid, None)

    if peer_ws:
        try:
            await peer_ws.close()
        except Exception:
            pass

    # 通知自己浏览器断开成功
    await _notify_browser({
        "type": "disconnected",
        "uuid": target_uuid,
    })


async def _handle_chat_message_from_browser(msg: dict):
    """
    浏览器发来聊天消息 → 转发给目标对端的 WS 连接。

    msg: {type, to_uuid, content, msg_id}
    """
    target_uuid = msg.get("to_uuid", "")
    msg_id = msg.get("msg_id", "")
    content = msg.get("content", "")

    with _chats_lock:
        peer_ws = active_chats.get(target_uuid)

    if not peer_ws:
        await _notify_browser({
            "type": "send_failed",
            "msg_id": msg_id,
            "reason": "not_connected",
        })
        return

    try:
        await peer_ws.send_json({
            "type": "chat",
            "msg_id": msg_id,
            "from": MY_UUID,
            "from_name": MY_NAME,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        })
        # 保存自己发的消息到 contacts
        append_message(target_uuid, "me", content, msg_id)
    except Exception:
        await _notify_browser({
            "type": "send_failed",
            "msg_id": msg_id,
            "reason": "send_error",
        })


async def _handle_file_request_from_browser(msg: dict):
    """
    浏览器通过 control WS 转发文件请求（sendFile 的回退路径）。
    当浏览器端没有直接 WS 时，本后端通过 HTTP POST 到对端后端来注册传输请求。

    msg: {type, to_uuid, transfer_id, file_name, file_size, chunk_size, total_chunks}
    """
    import json as _json
    import urllib.request as _urllib

    target_uuid = msg.get("to_uuid", "")
    transfer_id = msg.get("transfer_id", "")

    # 查找对端的 IP 和端口
    peer = discovery.get_peer(target_uuid)
    if not peer:
        # 查历史联系人
        for c in list_contacts():
            if c.get("uuid") == target_uuid:
                peer = {"ip": c.get("ip", ""), "ws_port": c.get("ws_port", 50002)}
                break

    if not peer or not peer.get("ip"):
        await _notify_browser({
            "type": "file_request_response",
            "transfer_id": transfer_id,
            "accepted": False,
        })
        return

    # 优先：HTTP POST 到对端后端，由对端后端创建 transfer 并通知对端浏览器
    relayed = False
    try:
        def _post():
            url = f"http://{peer['ip']}:{peer.get('ws_port', 50002)}/api/transfer/request"
            payload = _json.dumps({
                "transfer_id": transfer_id,
                "file_name": Path(msg.get("file_name", "")).name,
                "file_size": msg.get("file_size", 0),
                "chunk_size": msg.get("chunk_size", 65536),
                "total_chunks": msg.get("total_chunks", 0),
                "from_uuid": MY_UUID,
                "from_name": MY_NAME,
                "token": token_manager.get_token(),
                "resume": msg.get("resume", False),
            }).encode("utf-8")
            req = _urllib.Request(url, data=payload, headers={"Content-Type": "application/json"})
            with _urllib.urlopen(req, timeout=5) as resp:
                return _json.loads(resp.read().decode("utf-8"))
        await asyncio.to_thread(_post)
        relayed = True
    except Exception:
        pass

    # 回退：HTTP 不通则通过 chat WS 发给对端前端（对端前端会注册 transfer 并弹窗）
    if not relayed:
        try:
            with _chats_lock:
                peer_ws = active_chats.get(target_uuid)
            if peer_ws:
                await peer_ws.send_json({
                    "type": "file_request",
                    "transfer_id": transfer_id,
                    "file_name": msg.get("file_name", ""),
                    "file_size": msg.get("file_size", 0),
                    "chunk_size": msg.get("chunk_size", 65536),
                    "total_chunks": msg.get("total_chunks", 0),
                    "resume": msg.get("resume", False),
                })
            else:
                await _notify_browser({
                    "type": "file_request_response",
                    "transfer_id": transfer_id,
                    "accepted": False,
                })
        except Exception:
            await _notify_browser({
                "type": "file_request_response",
                "transfer_id": transfer_id,
                "accepted": False,
            })


async def _handle_file_response(msg: dict):
    """
    浏览器对文件传输请求做出响应。

    msg: {type, transfer_id, accepted: bool}
    """
    transfer_id = msg.get("transfer_id", "")
    accepted = msg.get("accepted", False)
    t = transfers.get(transfer_id)

    if not t:
        return

    peer_uuid = t.get("from_uuid")
    with _chats_lock:
        peer_ws = active_chats.get(peer_uuid)

    if accepted:
        t["status"] = "receiving"
        if peer_ws:
            await _safe_send(peer_ws, {
                "type": "file_response",
                "transfer_id": transfer_id,
                "accepted": True,
            })
        else:
            # 没有来自发送方的直接 WS（发送方是被动接收方），
            # 通知自己浏览器通过 chat WS 转发响应给对端后端
            await _notify_browser({
                "type": "forward_file_response",
                "transfer_id": transfer_id,
                "accepted": True,
                "to_uuid": peer_uuid,
            })
    else:
        t["status"] = "rejected"
        delete_progress(transfer_id)
        transfers.pop(transfer_id, None)
        if peer_ws:
            await _safe_send(peer_ws, {
                "type": "file_response",
                "transfer_id": transfer_id,
                "accepted": False,
            })
        else:
            await _notify_browser({
                "type": "forward_file_response",
                "transfer_id": transfer_id,
                "accepted": False,
                "to_uuid": peer_uuid,
            })


async def _handle_file_cancel(msg: dict):
    """
    浏览器取消正在接收的文件传输。

    msg: {type, transfer_id}
    """
    transfer_id = msg.get("transfer_id", "")
    t = transfers.pop(transfer_id, None)
    if t:
        delete_progress(transfer_id)
        peer_uuid = t.get("from_uuid")
        with _chats_lock:
            peer_ws = active_chats.get(peer_uuid)
        await _safe_send(peer_ws, {
            "type": "file_cancel",
            "transfer_id": transfer_id,
        })

# ============================================================
# WebSocket：聊天通道（其他用户浏览器 → 自己后端）
# ============================================================


@app.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    """
    其他用户的浏览器连接本机聊天的入口。

    阶段1: 接收 connect_request → Token 验证 → 通知浏览器 → 等待用户确认
    阶段2: 确认后进入消息收发（聊天、文件信令）
    """
    await ws.accept()

    peer_uuid: str | None = None
    peer_name: str = "Unknown"
    confirmed_event = asyncio.Event()
    accepted_result: bool = False
    idle_closed: bool = False  # 空闲超时关闭，避免 finally 中重复通知

    try:
        # ===== 阶段1：连接请求与 Token 验证 =====
        msg = await ws.receive_json()

        if msg.get("type") != "connect_request":
            await ws.send_json({"type": "connect_rejected", "reason": "expected connect_request"})
            await ws.close()
            return

        peer_uuid = msg.get("uuid", "")
        peer_name = msg.get("name", "Unknown")
        peer_token = msg.get("token", "")
        # 发起方历史里是否还保留着我（=发起方是否曾删除过我）
        peer_has_me = msg.get("have_you", False)

        # 防止自连：拒绝连接自己
        if peer_uuid == MY_UUID:
            await ws.send_json({"type": "connect_rejected", "reason": "self_connect"})
            await ws.close()
            return

        # 发起方自己的 IP 和端口（跨子网时依赖此字段，UDP 广播到不了）
        # Starlette ws.client 返回 tuple(host, port)，不是带 .host 属性的对象
        _client_ip = ws.client[0] if ws.client else ""
        peer_ip = msg.get("ip", "") or _client_ip
        peer_ws_port = msg.get("ws_port", 50002)

        # Token 验证：优先查 UDP peer_list（同子网），失败则反向调 /api/me（跨子网）
        if not discovery.verify_token(peer_uuid, peer_token):
            if not await _verify_token_via_api(peer_uuid, peer_token, peer_ip, peer_ws_port):
                await ws.send_json({"type": "connect_rejected", "reason": "invalid_token"})
                await ws.close()
                return
            # 跨子网验证通过：将对方基本信息临时写入 peer_list，
            # 让后续 get_peer() 能查到 IP+端口，也避免下次同 UUID 再走 API 验证
            discovery._peers[peer_uuid] = {
                "uuid": peer_uuid, "name": peer_name,
                "ip": peer_ip, "ws_port": peer_ws_port,
                "token": peer_token, "previous_token": "",
                "last_seen": time.time(), "miss_count": 0, "status": "online",
            }

        # 获取发起方 IP 和端口，同子网优先用 UDP 广播里的信息（含 token）
        peer_info = discovery.get_peer(peer_uuid) or {}
        peer_ip = peer_info.get("ip", "") or peer_ip
        peer_ws_port = peer_info.get("ws_port", 50002) or peer_ws_port

        # Token 通过 → 判断是新连接还是重连
        # 双方历史里都还保留着对方 → 互信，自动接受，无需用户再次确认
        # 任一方历史里已没有对方（有一方删除过）→ 必须重新走确认流程
        existing_contact = get_contact(peer_uuid)
        if existing_contact and peer_has_me:
            accepted_result = True
            # 用联系人的最新名字（可能改过昵称）
            peer_name = existing_contact.get("name", peer_name)
            # 直接发送 connect_accepted，跳过用户确认环节
            await ws.send_json({
                "type": "connect_accepted",
                "uuid": MY_UUID,
                "name": MY_NAME,
                "ip": MY_IP,
                "ws_port": WS_PORT,
            })
        else:
            # 新连接或对方曾删除过我们 → 加入待确认列表，等待用户确认
            with _pending_lock:
                pending_connections[peer_uuid] = {
                    "ws": ws,
                    "name": peer_name,
                    "uuid": peer_uuid,
                    "event": confirmed_event,
                    "accepted": False,
                }

            await _notify_browser({
                "type": "incoming_connection",
                "uuid": peer_uuid,
                "name": peer_name,
                "ip": peer_ip,
                "ws_port": peer_ws_port,
            })
            await _notify_pending_update()

            # 等待用户通过 control WS 发来 connection_response（1分钟超时）
            try:
                await asyncio.wait_for(confirmed_event.wait(), timeout=60)
            except asyncio.TimeoutError:
                # 用户1分钟内未操作 → 拒绝连接，清理资源
                with _pending_lock:
                    pending_connections.pop(peer_uuid, None)
                await _notify_browser({
                    "type": "connection_timeout",
                    "uuid": peer_uuid,
                    "name": peer_name,
                })
                await _notify_pending_update()
                try:
                    await ws.send_json({"type": "connect_rejected", "reason": "timeout"})
                except Exception:
                    pass
                await ws.close()
                return

            # 检查是否被接受
            with _pending_lock:
                info = pending_connections.pop(peer_uuid, {})
                accepted_result = info.get("accepted", False)

            if not accepted_result:
                await ws.close()
                return

        # ===== 阶段2：正常消息收发 =====
        with _chats_lock:
            active_chats[peer_uuid] = ws

        peer_info = discovery.get_peer(peer_uuid) or {}
        peer_ip = peer_info.get("ip", "")
        peer_ws_port = peer_info.get("ws_port", 50002)
        upsert_contact(peer_uuid, peer_name, peer_ip, peer_ws_port)

        await _notify_browser({
            "type": "connection_established",
            "uuid": peer_uuid,
            "name": peer_name,
            "ip": peer_ip,
        })
        await _notify_pending_update()

        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_json(), timeout=600)
            except asyncio.TimeoutError:
                # 10分钟无消息 → 检查是否有活跃的文件传输
                has_active_transfer = any(
                    t.get("from_uuid") == peer_uuid and t.get("status") == "receiving"
                    for t in transfers.values()
                )
                if has_active_transfer:
                    continue  # 文件传输进行中，不关闭

                await _notify_browser({
                    "type": "connection_idle_close",
                    "uuid": peer_uuid,
                    "name": peer_name,
                })
                idle_closed = True
                try:
                    await ws.send_json({"type": "connection_closing", "reason": "idle_timeout"})
                except Exception:
                    pass
                break

            await _relay_from_peer(ws, peer_uuid, peer_name, msg)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # 清理
        with _pending_lock:
            pending_connections.pop(peer_uuid, None)
        with _chats_lock:
            active_chats.pop(peer_uuid, None)
        if peer_uuid and not idle_closed:
            # 空闲超时已通过 connection_idle_close 通知，避免重复
            await _notify_browser({
                "type": "peer_disconnected",
                "uuid": peer_uuid,
                "name": peer_name,
            })
        await _notify_pending_update()


async def _relay_from_peer(ws: WebSocket, peer_uuid: str, peer_name: str, msg: dict):
    """
    将对方 WebSocket 发来的消息转发给本地浏览器。

    支持的消息类型:
      - chat:          聊天消息 → 保存 + 转发浏览器 + 发 ACK
      - file_request:  文件传输请求 → 创建传输记录 + 通知浏览器
      - file_response:  对我方文件请求的响应 → 转发浏览器
      - file_cancel:   对方取消传输 → 清理 + 通知浏览器
    """
    msg_type = msg.get("type", "")

    if msg_type == "chat":
        msg_id = msg.get("msg_id", "")
        content = msg.get("content", "")
        append_message(peer_uuid, peer_uuid, content, msg_id)
        await _notify_browser({
            "type": "chat_message",
            "from": peer_uuid,
            "from_name": peer_name,
            "msg_id": msg_id,
            "content": content,
            "timestamp": msg.get("timestamp", datetime.now().isoformat()),
        })
        await _safe_send(ws, {"type": "ack", "msg_id": msg_id})

    elif msg_type == "file_request":
        transfer_id = msg.get("transfer_id", "")
        file_name = Path(msg.get("file_name", "")).name
        file_size = msg.get("file_size", 0)
        resume = msg.get("resume", False)
        existing_progress = load_progress(transfer_id)

        # 保留旧传输中已收到的分片数据（续传覆盖时不丢失进度）
        old_transfer = transfers.get(transfer_id, {})
        old_received_chunks = old_transfer.get("received_chunks", [])
        old_received_bytes = old_transfer.get("received_bytes", 0)

        transfers[transfer_id] = {
            "transfer_id": transfer_id,
            "file_name": file_name,
            "file_size": file_size,
            "total_chunks": msg.get("total_chunks", 0),
            "chunk_size": msg.get("chunk_size", 65536),
            "from_uuid": peer_uuid,
            "from_name": peer_name,
            "received_chunks": old_received_chunks,
            "received_bytes": old_received_bytes,
            "status": "receiving" if (resume and existing_progress) else "pending",
            "created_at": datetime.now().isoformat(),
        }

        if resume and existing_progress:
            # 续传，不弹窗直接确认
            await _safe_send(ws, {
                "type": "file_response",
                "transfer_id": transfer_id,
                "accepted": True,
            })
            await _notify_browser({
                "type": "transfer_resumed",
                "transfer_id": transfer_id,
                "file_name": file_name,
                "from_name": peer_name,
            })
        else:
            # 新传输或续传但进度文件丢失 → 通知浏览器
            # 若 sender 标记了 resume，浏览器应自动接受（不弹窗）
            await _notify_browser({
                "type": "incoming_file_request",
                "transfer_id": transfer_id,
                "file_name": file_name,
                "file_size": file_size,
                "from_uuid": peer_uuid,
                "from_name": peer_name,
                "resume": resume,
            })

    elif msg_type == "file_response":
        await _notify_browser({
            "type": "file_request_response",
            "transfer_id": msg.get("transfer_id", ""),
            "accepted": msg.get("accepted", False),
        })

    elif msg_type == "file_cancel":
        transfer_id = msg.get("transfer_id", "")
        transfers.pop(transfer_id, None)
        delete_progress(transfer_id)
        await _notify_browser({
            "type": "transfer_cancelled",
            "transfer_id": transfer_id,
        })

    elif msg_type == "ack":
        await _notify_browser({
            "type": "message_ack",
            "msg_id": msg.get("msg_id", ""),
        })


# ============================================================
# HTTP 文件传输 API（接收方）
# ============================================================


@app.post("/api/transfer/request")
async def api_transfer_request(request: Request):
    """
    接收来自其他后端的文件传输请求。
    对端后端通过此端点注册传输，本后端创建 transfer 并通知本端浏览器。
    这是 sendFile 控制 WS 回退路径的后端-后端 relay。
    """
    data = await request.json()
    transfer_id = data.get("transfer_id", "")
    file_name = Path(data.get("file_name", "")).name
    file_size = data.get("file_size", 0)
    from_uuid = data.get("from_uuid", "")
    from_name = data.get("from_name", "")
    from_token = data.get("token", "")
    resume = data.get("resume", False)

    if not transfer_id or not from_uuid:
        raise HTTPException(400, "缺少必要参数")

    # Token 验证：防止未认证的请求刷屏弹窗
    if not discovery.verify_token(from_uuid, from_token):
        peer_info = discovery.get_peer(from_uuid) or {}
        peer_ip = peer_info.get("ip", "")
        peer_ws_port = peer_info.get("ws_port", 50002)
        if not peer_ip or not await _verify_token_via_api(from_uuid, from_token, peer_ip, peer_ws_port):
            raise HTTPException(403, "token 验证失败")

    # 续传：已有进度文件则自动进入接收状态，跳过用户确认
    existing_progress = load_progress(transfer_id)
    status = "receiving" if (resume and existing_progress) else "pending"

    transfers[transfer_id] = {
        "transfer_id": transfer_id,
        "file_name": file_name,
        "file_size": file_size,
        "total_chunks": data.get("total_chunks", 0),
        "chunk_size": data.get("chunk_size", 65536),
        "from_uuid": from_uuid,
        "from_name": from_name,
        "status": status,
        "created_at": datetime.now().isoformat(),
    }

    await _notify_browser({
        "type": "incoming_file_request",
        "transfer_id": transfer_id,
        "file_name": file_name,
        "file_size": file_size,
        "from_uuid": from_uuid,
        "from_name": from_name,
        # 用发送方的 resume 意图（即使进度文件丢失，浏览器也应自动接受不弹窗）
        "resume": resume or status == "receiving",
    })

    return {"status": "ok"}


@app.post("/api/transfer/chunk")
async def transfer_chunk(request: Request):
    """接收文件分片（Base64 编码）。"""
    data = await request.json()
    transfer_id = data.get("transfer_id", "")
    chunk_index = data.get("chunk_index", 0)
    chunk_data_b64 = data.get("data", "")

    t = transfers.get(transfer_id)
    if not t:
        raise HTTPException(404, "传输不存在")
    if t.get("status") not in ("receiving",):
        raise HTTPException(400, f"传输状态异常: {t.get('status')}")

    # chunk 不验证 token：传输请求阶段已认证，transfer_id 不可猜测，
    # token 每 3 秒刷新会导致竞态条件（发送端取 token → 心跳刷新 → 接收端验证失败）

    try:
        chunk_data = base64.b64decode(chunk_data_b64)
    except Exception:
        raise HTTPException(400, "无效的 Base64 数据")

    chunk_size = t.get("chunk_size", 65536)
    part_path = get_download_path(t["file_name"])
    part_path = part_path.with_suffix(part_path.suffix + ".part")

    lock = transfer_locks.setdefault(transfer_id, threading.Lock())
    with lock:
        # 使用 "r+b"（已存在）或 "w+b"（新建），绝不使用 "ab"。
        # "ab" 模式下 f.seek() 对 write 无效，OS 强制所有写入追加到文件末尾，
        # 导致续传时分片被错误拼接，文件大小膨胀 → "文件校验出错"。
        _mode = "r+b" if part_path.exists() else "w+b"
        with open(part_path, _mode) as f:
            f.seek(chunk_index * chunk_size)
            f.write(chunk_data)

        # 去重：续传时发送方可能从 0 开始重发，已收到的分片不重复计数
        if chunk_index not in t.setdefault("received_chunks", []):
            t["received_chunks"].append(chunk_index)
            t["received_bytes"] = t.get("received_bytes", 0) + len(chunk_data)

        # 持久化进度
        save_progress(transfer_id, {
            "file_name": t["file_name"],
            "file_size": t["file_size"],
            "chunk_size": chunk_size,
            "received_chunks": t["received_chunks"],
            "received_bytes": t["received_bytes"],
            "total_chunks": t["total_chunks"],
            "from_uuid": t.get("from_uuid", ""),
            "from_name": t.get("from_name", ""),
            "status": "receiving",
            "created_at": t.get("created_at", ""),
            "last_update": datetime.now().isoformat(),
        })

    await _notify_browser({
        "type": "transfer_progress",
        "transfer_id": transfer_id,
        "file_name": t["file_name"],
        "received_bytes": t["received_bytes"],
        "total_bytes": t["file_size"],
    })

    return {
        "status": "ok",
        "chunk_index": chunk_index,
        "received_bytes": t["received_bytes"],
    }


@app.post("/api/transfer/complete")
async def transfer_complete(request: Request):
    """文件传输完成：校验并重命名为最终文件。"""
    data = await request.json()
    transfer_id = data.get("transfer_id", "")

    t = transfers.get(transfer_id)
    if not t:
        raise HTTPException(404, "传输不存在")

    # complete 不验证 token：传输请求阶段已认证，与 chunk 同理

    part_path = get_download_path(t["file_name"])
    part_path = part_path.with_suffix(part_path.suffix + ".part")
    final_path = get_download_path(t["file_name"])

    if part_path.exists():
        actual_size = part_path.stat().st_size
        if actual_size == t.get("file_size", 0):
            part_path.rename(final_path)
            verified = True
        else:
            verified = False
    else:
        verified = False

    delete_progress(transfer_id)
    transfers.pop(transfer_id, None)

    await _notify_browser({
        "type": "transfer_complete",
        "transfer_id": transfer_id,
        "file_name": t["file_name"],
        "verified": verified,
    })

    return {"status": "ok", "verified": verified}


@app.get("/api/transfer/status/{transfer_id}")
async def transfer_status(transfer_id: str):
    """查询传输进度（用于断点续传）。"""
    # 先查内存
    t = transfers.get(transfer_id)
    if t:
        return {
            "transfer_id": transfer_id,
            "file_name": t["file_name"],
            "file_size": t["file_size"],
            "received_bytes": t.get("received_bytes", 0),
            "received_chunks_count": len(t.get("received_chunks", [])),
            "total_chunks": t.get("total_chunks", 0),
            "status": t.get("status", "unknown"),
        }

    # 再查持久化进度文件
    progress = load_progress(transfer_id)
    if progress:
        return {
            "transfer_id": transfer_id,
            "file_name": progress.get("file_name", ""),
            "file_size": progress.get("file_size", 0),
            "received_bytes": progress.get("received_bytes", 0),
            "received_chunks_count": len(progress.get("received_chunks", [])),
            "total_chunks": progress.get("total_chunks", 0),
            "status": progress.get("status", "in_progress"),
        }

    raise HTTPException(404, "传输不存在")


# ============================================================
# 文件下载（接收完成后点击打开）
# ============================================================


@app.get("/api/downloads/{file_name:path}")
async def download_file(file_name: str):
    """
    提供已下载文件的访问，用于前端点击"打开文件"。

    安全防护：resolve() 后检查路径必须在 DOWNLOADS_DIR 内，防止路径穿越攻击。
    """
    from storage import DOWNLOADS_DIR

    file_path = (DOWNLOADS_DIR / file_name).resolve()
    allowed_base = DOWNLOADS_DIR.resolve()
    if not str(file_path).startswith(str(allowed_base)):
        raise HTTPException(403, "禁止访问")
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(file_path)


# ============================================================
# 静态文件 & 前端
# ============================================================

STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
async def index():
    """返回前端页面"""
    return FileResponse(STATIC_DIR / "index.html")


# 挂载静态资源（CSS、JS）
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ============================================================
# 入口
# ============================================================

if __name__ == "__main__":
    # 环境变量覆盖:
    #   LANCHAT_DATA_DIR - 数据目录路径（默认 ./data）
    #   LANCHAT_PORT      - 指定端口（默认自动查找 50002+）
    #   LANCHAT_NAME      - 自定义昵称
    port = int(os.environ.get("LANCHAT_PORT", "0")) or WS_PORT
    name = os.environ.get("LANCHAT_NAME", "")
    if name:
        MY_NAME = name
        config["name"] = name
        save_config(config)
        discovery.my_name = name

    print(f"[LanChat] 启动中...")
    print(f"  昵称: {MY_NAME}")
    print(f"  网段: {NETWORK_SEGMENT}")
    print(f"  端口: {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
