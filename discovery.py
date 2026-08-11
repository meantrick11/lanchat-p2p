"""
UDP 节点发现模块。

功能:
  - 向当前网段广播本机信息（每3秒）
  - 监听其他节点的广播包
  - 维护在线节点列表（含超时检测）
  - Token 管理（每3秒刷新，随心跳广播分发）
  - 多网卡支持（每个子网都广播）
"""

import json
import socket
import secrets
import threading
import time
from typing import Callable

# UDP 广播端口
BROADCAST_PORT = 50001

# 心跳间隔（秒）
HEARTBEAT_INTERVAL = 3

# 节点超时时间（秒）：10秒未收到心跳标记离线
PEER_TIMEOUT = 10

# 连续超时次数阈值（去抖动：连续3次未收到才标记离线）
MISS_THRESHOLD = 3


class TokenManager:
    """管理本机的会话 Token，每3秒自动刷新。"""

    def __init__(self):
        self.current: str = ""
        self.previous: str = ""
        self.created_at: float = 0
        self._refresh()

    def _refresh(self):
        """生成新的随机 token"""
        self.previous = self.current
        self.current = secrets.token_hex(16)  # 32字符十六进制
        self.created_at = time.time()

    def get_token(self) -> str:
        """获取当前 token，超过间隔则自动刷新"""
        if time.time() - self.created_at > HEARTBEAT_INTERVAL:
            self._refresh()
        return self.current


# 缓存：网卡信息不会频繁变化，60 秒刷新一次，避免 ipconfig 每 3 秒调一次
_cached_interfaces: list[tuple[str, str]] | None = None
_cached_interfaces_time: float = 0
_CACHE_TTL = 60  # 秒


def _get_broadcast_interfaces() -> list[tuple[str, str]]:
    """
    获取所有活跃网卡的 (广播地址, 网卡IP) 列表（带缓存）。
    每张网卡的广播包应携带该网卡自己的 IP，这样多网卡主机在
    不同子网收到广播的对端才能用正确的 IP 回连。

    Linux: 通过 ioctl 获取准确的 IP + 子网掩码 → 广播地址
    Windows/fallback: 通过 getaddrinfo 枚举 IP，按 /24 估算广播地址
    """
    global _cached_interfaces, _cached_interfaces_time

    now = time.time()
    if _cached_interfaces is not None and (now - _cached_interfaces_time) < _CACHE_TTL:
        return _cached_interfaces
    import struct
    interfaces = []

    # Linux: ioctl 获取各网卡 IP + 子网掩码，计算定向广播地址
    try:
        import fcntl
        if hasattr(socket, "if_nameindex"):
            for iface_name, _ in socket.if_nameindex():
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    ip_bytes = fcntl.ioctl(
                        s.fileno(), 0x8915,
                        struct.pack("256s", iface_name[:15].encode())
                    )[20:24]
                    mask_bytes = fcntl.ioctl(
                        s.fileno(), 0x891b,
                        struct.pack("256s", iface_name[:15].encode())
                    )[20:24]
                    s.close()
                    ip = socket.inet_ntoa(ip_bytes)
                    netmask = socket.inet_ntoa(mask_bytes)
                    if ip == "127.0.0.1" or not ip or not netmask:
                        continue
                    ip_parts = [int(p) for p in ip.split(".")]
                    mask_parts = [int(p) for p in netmask.split(".")]
                    broadcast_parts = [
                        str(ip_parts[i] | (255 ^ mask_parts[i])) for i in range(4)
                    ]
                    bcast = ".".join(broadcast_parts)
                    if (bcast, ip) not in interfaces:
                        interfaces.append((bcast, ip))
                except Exception:
                    continue
    except (ImportError, OSError):
        pass

    # Windows / fallback: 枚举所有非回环 IPv4，按 /24 估算广播地址
    if not interfaces:
        try:
            seen = set()
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip == "127.0.0.1" or ip in seen:
                    continue
                seen.add(ip)
                parts = ip.split(".")
                bcast = ".".join(parts[:3]) + ".255"
                interfaces.append((bcast, ip))
        except OSError:
            pass

    # Windows: 通过 ipconfig 获取所有网卡 IP + 子网掩码
    # （getaddrinfo 可能遗漏虚拟网卡如 VMware Host-Only；正则适配中/英文系统）
    try:
        import subprocess
        import re
        result = subprocess.run(
            ["ipconfig"], capture_output=True, text=True, timeout=5
        )
        current_ip = None
        for line in result.stdout.splitlines():
            # "   IPv4 Address.......: x.x.x.x" / "   IPv4 地址........: x.x.x.x"
            m_ip = re.search(r'IPv4[^:]*?:\s*([\d.]+)', line)
            # "   Subnet Mask.......: y.y.y.y" / "   子网掩码.........: y.y.y.y"
            m_mask = re.search(r'(?:Subnet Mask|子网掩码)[^:]*?:\s*([\d.]+)', line)

            if m_ip:
                current_ip = m_ip.group(1)
                if current_ip == "127.0.0.1":
                    current_ip = None
            elif m_mask and current_ip:
                mask = m_mask.group(1)
                ip_parts = [int(p) for p in current_ip.split(".")]
                mask_parts = [int(p) for p in mask.split(".")]
                bcast = ".".join(
                    [str(ip_parts[i] | (255 ^ mask_parts[i])) for i in range(4)]
                )
                if (bcast, current_ip) not in interfaces:
                    interfaces.append((bcast, current_ip))
                current_ip = None
    except Exception:
        pass

    # 最后的兜底
    if not interfaces:
        interfaces.append(("255.255.255.255", "0.0.0.0"))

    _cached_interfaces = interfaces
    _cached_interfaces_time = time.time()
    return interfaces


# 保留旧函数名的兼容引用
def _get_broadcast_addresses() -> list[str]:
    """[兼容] 仅返回广播地址列表（不含网卡 IP）"""
    return [bcast for bcast, _ in _get_broadcast_interfaces()]


class Discovery:
    """
    节点发现服务。

    启动后：
      - 广播线程：每 3 秒向所有网卡的广播地址发送心跳包
      - 监听线程：持续接收其他节点的心跳包，更新在线列表
    """

    def __init__(
        self,
        my_uuid: str,
        my_name: str,
        my_ip: str,
        ws_port: int,
        token_manager: TokenManager,
    ):
        self.my_uuid = my_uuid
        self.my_name = my_name
        self.my_ip = my_ip
        self.ws_port = ws_port
        self.token_manager = token_manager

        # peer_list: uuid -> {uuid, name, ip, ws_port, token, previous_token,
        #                      last_seen, miss_count, status}
        self._peers: dict = {}
        self._lock = threading.Lock()

        self._running = False
        self._sock: socket.socket | None = None

        # 事件回调（通知 main.py 状态变更）
        self.on_peer_online: Callable[[dict], None] | None = None
        self.on_peer_offline: Callable[[dict], None] | None = None

    def start(self):
        """启动发现服务（广播 + 监听）"""
        self._running = True

        # 创建 UDP socket
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("0.0.0.0", BROADCAST_PORT))
        self._sock.settimeout(1.0)  # 1秒超时，用于定期检查退出信号

        # 启动时立即发一次广播，不等定时器
        self._broadcast_heartbeat()

        # 启动后台线程
        threading.Thread(target=self._broadcast_loop, daemon=True, name="udp-broadcast").start()
        threading.Thread(target=self._listen_loop, daemon=True, name="udp-listen").start()

    def stop(self):
        """停止发现服务，发送 goodbye 广播"""
        self._running = False
        if self._sock:
            # 发送 goodbye
            goodbye = json.dumps({"type": "goodbye", "uuid": self.my_uuid})
            for bcast_addr, _ in _get_broadcast_interfaces():
                try:
                    self._sock.sendto(goodbye.encode(), (bcast_addr, BROADCAST_PORT))
                except OSError:
                    pass
            try:
                self._sock.close()
            except OSError:
                pass

    def get_peers(self) -> list[dict]:
        """获取当前在线节点列表"""
        with self._lock:
            online = [p.copy() for p in self._peers.values() if p.get("status") == "online"]
            return online

    def get_all_peers(self) -> list[dict]:
        """获取所有已知节点列表（含离线）"""
        with self._lock:
            return [p.copy() for p in self._peers.values()]

    def verify_token(self, uuid: str, token: str) -> bool:
        """验证某个 uuid 提供的 token 是否与记录匹配"""
        with self._lock:
            peer = self._peers.get(uuid)
            if not peer:
                return False
            # 接受当前 token 或上一周期 token（容忍一次刷新周期的时间差）
            return token in (peer.get("token"), peer.get("previous_token"))

    def get_peer(self, uuid: str) -> dict | None:
        """获取指定节点信息"""
        with self._lock:
            return self._peers.get(uuid, {}).copy()

    # ===== 内部方法 =====

    def _broadcast_heartbeat(self):
        """发送一次心跳广播到所有广播地址，每张网卡携带自己的 IP"""
        if not self._sock:
            return

        for bcast_addr, iface_ip in _get_broadcast_interfaces():
            # 每张网卡使用对应的 IP，保证接收方能从同一子网回连
            ip = iface_ip if iface_ip != "0.0.0.0" else self.my_ip
            msg = json.dumps({
                "type": "hello",
                "uuid": self.my_uuid,
                "name": self.my_name,
                "ip": ip,
                "ws_port": self.ws_port,
                "token": self.token_manager.get_token(),
                "timestamp": time.time(),
            })
            try:
                self._sock.sendto(msg.encode(), (bcast_addr, BROADCAST_PORT))
            except OSError:
                pass

    def _broadcast_loop(self):
        """后台广播循环：每 HEARTBEAT_INTERVAL 秒发一次心跳"""
        while self._running:
            time.sleep(HEARTBEAT_INTERVAL)
            if self._running:
                self._broadcast_heartbeat()

    def _listen_loop(self):
        """后台监听循环：持续接收其他节点的广播包"""
        while self._running:
            try:
                data, addr = self._sock.recvfrom(4096)
                msg = json.loads(data.decode("utf-8"))
                self._handle_message(msg)
            except socket.timeout:
                # 定时超时，用于检查离线节点和退出信号
                self._check_timeouts()
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                continue

    def _handle_message(self, msg: dict):
        """处理收到的广播消息"""
        uuid = msg.get("uuid", "")
        if uuid == self.my_uuid:
            return  # 忽略自己发的

        msg_type = msg.get("type")

        with self._lock:
            if msg_type == "hello":
                is_new = uuid not in self._peers
                was_offline = (
                    not is_new and self._peers[uuid].get("status") == "offline"
                )

                prev_data = self._peers.get(uuid, {})
                self._peers[uuid] = {
                    "uuid": uuid,
                    "name": msg.get("name", "Unknown"),
                    "ip": msg.get("ip", ""),
                    "ws_port": msg.get("ws_port", 50002),
                    "token": msg.get("token", ""),
                    "previous_token": prev_data.get("token", ""),
                    "last_seen": time.time(),
                    "miss_count": 0,
                    "status": "online",
                }

                # 触发上线回调
                if is_new and self.on_peer_online:
                    self.on_peer_online(self._peers[uuid].copy())
                elif was_offline and self.on_peer_online:
                    self.on_peer_online(self._peers[uuid].copy())

            elif msg_type == "goodbye":
                if uuid in self._peers:
                    self._peers[uuid]["status"] = "offline"
                    self._peers[uuid]["last_seen"] = time.time()
                    if self.on_peer_offline:
                        self.on_peer_offline(self._peers[uuid].copy())

    def _check_timeouts(self):
        """检查超时节点，标记离线。每轮去抖动：连续 MISS_THRESHOLD 次超时才标记。"""
        now = time.time()
        offline_notifications = []

        with self._lock:
            for uuid, peer in list(self._peers.items()):
                if peer.get("status") != "online":
                    continue
                if now - peer.get("last_seen", 0) > PEER_TIMEOUT:
                    peer["miss_count"] = peer.get("miss_count", 0) + 1
                    if peer["miss_count"] >= MISS_THRESHOLD:
                        peer["status"] = "offline"
                        offline_notifications.append(peer.copy())

        # 在锁外触发回调，避免死锁
        for peer in offline_notifications:
            if self.on_peer_offline:
                self.on_peer_offline(peer)
