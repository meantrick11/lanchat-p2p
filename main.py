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
    get_download_path,
    get_messages,
    list_contacts,
    load_config,
    load_progress,
    save_config,
    save_progress,
    upsert_contact,
)

# ============================================================
# 配置初始化
# ============================================================


def get_local_ip() -> str:
    """获取本机局域网 IP"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
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

MY_UUID: str = config["uuid"]
MY_NAME: str = config.get("name", socket.gethostname())
MY_IP: str = get_local_ip()
NETWORK_SEGMENT: str = ".".join(MY_IP.split(".")[:3]) + ".0/24"

# 找到可用端口
WS_PORT: int = find_available_port()

# 清理过期进度文件
cleanup_expired_progress(max_age_hours=24)

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
    init_contacts = list_contacts()
    online_peers_list = discovery.get_peers()
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

            elif msg_type == "chat_message":
                await _handle_chat_message_from_browser(msg)

            elif msg_type == "save_message":
                # 浏览器请求保存一条消息到本地 contacts（发/收消息时调用）
                await _handle_save_message(msg)

            elif msg_type == "save_contact":
                # 浏览器请求保存联系人的基本信息（连接建立后调用）
                uuid = msg.get("uuid", "")
                name = msg.get("name", "")
                ip_addr = msg.get("ip", "")
                if uuid:
                    upsert_contact(uuid, name, ip_addr)

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
        # 发送确认给对方
        try:
            await peer_ws.send_json({"type": "connect_accepted"})
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

    msg: {type, peer_uuid, sender, content, msg_id, timestamp}
    """
    peer_uuid = msg.get("peer_uuid", "")
    sender = msg.get("sender", "")  # "me" 或 peer_uuid
    content = msg.get("content", "")
    msg_id = msg.get("msg_id", "")
    if peer_uuid and msg_id:
        append_message(peer_uuid, sender, content, msg_id)


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
        await _safe_send(peer_ws, {
            "type": "file_response",
            "transfer_id": transfer_id,
            "accepted": True,
        })
    else:
        t["status"] = "rejected"
        delete_progress(transfer_id)
        transfers.pop(transfer_id, None)
        await _safe_send(peer_ws, {
            "type": "file_response",
            "transfer_id": transfer_id,
            "accepted": False,
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

        if not discovery.verify_token(peer_uuid, peer_token):
            await ws.send_json({"type": "connect_rejected", "reason": "invalid_token"})
            await ws.close()
            return

        # Token 通过 → 加入待确认列表（带 asyncio.Event，供 control WS 回调通知）
        with _pending_lock:
            pending_connections[peer_uuid] = {
                "ws": ws,
                "name": peer_name,
                "uuid": peer_uuid,
                "event": confirmed_event,
                "accepted": False,
            }

        # 获取发起方 IP 和端口，以便接收方同意后反向建立连接
        peer_info = discovery.get_peer(peer_uuid) or {}
        peer_ip = peer_info.get("ip", "")
        peer_ws_port = peer_info.get("ws_port", 50002)

        await _notify_browser({
            "type": "incoming_connection",
            "uuid": peer_uuid,
            "name": peer_name,
            "ip": peer_ip,
            "ws_port": peer_ws_port,
        })
        await _notify_pending_update()

        # 等待用户通过 control WS 发来 connection_response
        await confirmed_event.wait()

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
        upsert_contact(peer_uuid, peer_name, peer_ip)

        await _notify_browser({
            "type": "connection_established",
            "uuid": peer_uuid,
            "name": peer_name,
            "ip": peer_ip,
        })
        await _notify_pending_update()

        while True:
            msg = await ws.receive_json()
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
        if peer_uuid:
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
        file_name = msg.get("file_name", "")
        file_size = msg.get("file_size", 0)
        resume = msg.get("resume", False)
        existing_progress = load_progress(transfer_id)

        transfers[transfer_id] = {
            "transfer_id": transfer_id,
            "file_name": file_name,
            "file_size": file_size,
            "total_chunks": msg.get("total_chunks", 0),
            "chunk_size": msg.get("chunk_size", 65536),
            "from_uuid": peer_uuid,
            "from_name": peer_name,
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
            # 新传输 → 弹窗
            await _notify_browser({
                "type": "incoming_file_request",
                "transfer_id": transfer_id,
                "file_name": file_name,
                "file_size": file_size,
                "from_uuid": peer_uuid,
                "from_name": peer_name,
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

    try:
        chunk_data = base64.b64decode(chunk_data_b64)
    except Exception:
        raise HTTPException(400, "无效的 Base64 数据")

    chunk_size = t.get("chunk_size", 65536)
    part_path = get_download_path(t["file_name"])
    part_path = part_path.with_suffix(part_path.suffix + ".part")

    lock = transfer_locks.setdefault(transfer_id, threading.Lock())
    with lock:
        with open(part_path, "ab") as f:
            f.seek(chunk_index * chunk_size)
            f.write(chunk_data)

        t.setdefault("received_chunks", []).append(chunk_index)
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
