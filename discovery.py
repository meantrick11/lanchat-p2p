"""
UDP 节点发现模块。

功能:
  - 向当前网段广播本机信息（每0.8秒）
  - 监听其他节点的广播包
  - 维护在线节点列表（含超时检测）
  - Token 管理（每 3 秒刷新，随 UDP 心跳广播分发）
  - 多网卡支持（每个子网都广播）
"""

import json
import ipaddress
import logging
import os
import socket
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger("lanchat.discovery")

# UDP 广播端口
BROADCAST_PORT = 50001

# 心跳间隔（秒）：UDP 广播频率，用于快速发现
HEARTBEAT_INTERVAL = 0.8

# Token 刷新间隔（秒）：独立于心跳，验证窗口约为 2 倍此值
TOKEN_REFRESH_INTERVAL = 3

# 节点超时时间（秒）：10秒未收到心跳标记离线
PEER_TIMEOUT = 10

# 连续超时次数阈值（去抖动：连续3次未收到才标记离线）
MISS_THRESHOLD = 3


class TokenManager:
    """管理本机的会话 Token，每 TOKEN_REFRESH_INTERVAL 秒自动刷新。"""

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
        """获取当前 token，超过 TOKEN_REFRESH_INTERVAL 则自动刷新"""
        if time.time() - self.created_at > TOKEN_REFRESH_INTERVAL:
            self._refresh()
        return self.current


# 缓存：网卡信息不会频繁变化，60 秒刷新一次，避免每 3 秒枚举系统网卡
@dataclass(frozen=True)
class NetworkInterface:
    """一张可用于局域网发现的 IPv4 网卡。"""

    name: str
    ip: str
    netmask: str
    network: str
    broadcast: str


_cached_interfaces: list[NetworkInterface] | None = None
_cached_interfaces_time: float = 0
_CACHE_TTL = 60  # 秒


def _build_interface(name: str, ip: str, netmask: str) -> NetworkInterface:
    """根据 IPv4 地址和真实掩码构造网卡网络信息。"""
    interface = ipaddress.IPv4Interface(f"{ip}/{netmask}")
    return NetworkInterface(
        name=name,
        ip=str(interface.ip),
        netmask=str(interface.netmask),
        network=str(interface.network),
        broadcast=str(interface.network.broadcast_address),
    )


def _is_usable_ip(ip: str) -> bool:
    """过滤回环、链路本地和未指定地址。"""
    try:
        address = ipaddress.IPv4Address(ip)
        return not (
            address.is_loopback
            or address.is_link_local
            or address.is_unspecified
        )
    except ipaddress.AddressValueError:
        return False


def _get_linux_interfaces() -> list[NetworkInterface]:
    """通过 ioctl 枚举 Linux IPv4 网卡及真实掩码。"""
    try:
        import fcntl
        import struct
    except ImportError:
        return []

    interfaces: list[NetworkInterface] = []
    if not hasattr(socket, "if_nameindex"):
        return interfaces

    # socket.if_nameindex() 返回 (index, name)，名称在第二项。
    for _, iface_name in socket.if_nameindex():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            packed_name = struct.pack("256s", iface_name[:15].encode())
            ip_bytes = fcntl.ioctl(sock.fileno(), 0x8915, packed_name)[20:24]
            mask_bytes = fcntl.ioctl(sock.fileno(), 0x891B, packed_name)[20:24]
            ip = socket.inet_ntoa(ip_bytes)
            netmask = socket.inet_ntoa(mask_bytes)
            if _is_usable_ip(ip):
                interfaces.append(_build_interface(iface_name, ip, netmask))
        except OSError:
            logger.debug("跳过无法读取 IPv4 信息的 Linux 网卡: %s", iface_name)
        finally:
            sock.close()
    return interfaces


def _get_windows_interfaces() -> list[NetworkInterface]:
    """通过 PowerShell JSON 枚举 Windows IPv4 网卡，避免依赖 ipconfig 语言。"""
    if os.name != "nt":
        return []

    command = (
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
        "Get-NetIPAddress -AddressFamily IPv4 | "
        "Where-Object {$_.AddressState -eq 'Preferred'} | "
        "Select-Object InterfaceAlias,IPAddress,PrefixLength | "
        "ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
        )
        if result.returncode != 0:
            logger.warning("PowerShell 网卡枚举失败: %s", result.stderr.strip())
            return []

        raw = result.stdout.strip()
        if not raw:
            return []
        records = json.loads(raw)
        if isinstance(records, dict):
            records = [records]

        interfaces = []
        for record in records:
            ip = str(record.get("IPAddress", ""))
            prefix = int(record.get("PrefixLength", 0))
            if not _is_usable_ip(ip) or not 1 <= prefix <= 30:
                continue
            interfaces.append(
                _build_interface(
                    str(record.get("InterfaceAlias", "unknown")),
                    ip,
                    str(prefix),
                )
            )
        return interfaces
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Windows 网卡枚举异常: %s", exc)
        return []


def _get_fallback_interfaces() -> list[NetworkInterface]:
    """系统枚举不可用时通过主机名解析兜底（掩码只能保守估算为 /24）。"""
    interfaces = []
    try:
        seen = set()
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not _is_usable_ip(ip) or ip in seen:
                continue
            seen.add(ip)
            interfaces.append(_build_interface("fallback", ip, "24"))
    except OSError as exc:
        logger.warning("兜底网卡枚举失败: %s", exc)
    return interfaces


def get_network_interfaces() -> list[NetworkInterface]:
    """
    获取所有活跃 IPv4 网卡（带缓存）。

    LANCHAT_BIND_IP 可限制只使用指定网卡，适合 WSL/VMware 等多网卡环境。
    """
    global _cached_interfaces, _cached_interfaces_time

    now = time.time()
    if _cached_interfaces is not None and (now - _cached_interfaces_time) < _CACHE_TTL:
        return list(_cached_interfaces)

    interfaces = (
        _get_windows_interfaces()
        if os.name == "nt"
        else _get_linux_interfaces()
    )
    if not interfaces:
        interfaces = _get_fallback_interfaces()

    # 去重，避免同一 IP 被多个系统接口查询重复返回。
    interfaces = list({item.ip: item for item in interfaces}.values())

    bind_ip = os.environ.get("LANCHAT_BIND_IP", "").strip()
    if bind_ip:
        selected = [item for item in interfaces if item.ip == bind_ip]
        if selected:
            interfaces = selected
        else:
            logger.warning(
                "LANCHAT_BIND_IP=%s 未匹配任何可用网卡，将使用自动枚举结果",
                bind_ip,
            )

    if not interfaces:
        interfaces = [
            NetworkInterface(
                name="fallback",
                ip="0.0.0.0",
                netmask="0.0.0.0",
                network="0.0.0.0/0",
                broadcast="255.255.255.255",
            )
        ]

    _cached_interfaces = interfaces
    _cached_interfaces_time = time.time()
    return list(interfaces)


def _get_broadcast_interfaces() -> list[tuple[str, str]]:
    """返回兼容格式的 (广播地址, 网卡 IP) 列表。"""
    return [(item.broadcast, item.ip) for item in get_network_interfaces()]


# 保留旧函数名的兼容引用
def _get_broadcast_addresses() -> list[str]:
    """[兼容] 仅返回广播地址列表（不含网卡 IP）"""
    return [bcast for bcast, _ in _get_broadcast_interfaces()]


class Discovery:
    """
    节点发现服务。

    启动后：
      - 广播线程：每 HEARTBEAT_INTERVAL 秒向所有网卡的广播地址发送心跳包
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
        for interface in get_network_interfaces():
            logger.info(
                "发现网卡 name=%s ip=%s network=%s broadcast=%s",
                interface.name,
                interface.ip,
                interface.network,
                interface.broadcast,
            )

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
                except OSError as exc:
                    logger.warning("发送 goodbye 失败 target=%s error=%s", bcast_addr, exc)
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
                logger.debug(
                    "发送 UDP 心跳 source=%s target=%s:%s",
                    ip,
                    bcast_addr,
                    BROADCAST_PORT,
                )
            except OSError as exc:
                logger.warning(
                    "发送 UDP 心跳失败 source=%s target=%s:%s error=%s",
                    ip,
                    bcast_addr,
                    BROADCAST_PORT,
                    exc,
                )

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
                self._handle_message(msg, addr[0])
            except socket.timeout:
                # 定时超时，用于检查离线节点和退出信号
                self._check_timeouts()
            except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
                if self._running:
                    logger.debug("忽略无效 UDP 数据或接收异常: %s", exc)
                continue

    def _is_same_subnet(self, ip: str) -> bool:
        """判断 IP 是否与本机任一网卡同子网（用于多网卡广播去重）"""
        if not _is_usable_ip(ip):
            return False
        address = ipaddress.IPv4Address(ip)
        return any(
            address in ipaddress.IPv4Network(interface.network)
            for interface in get_network_interfaces()
            if interface.ip != "0.0.0.0"
        )

    def _handle_message(self, msg: dict, source_ip: str = ""):
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
                new_ip = msg.get("ip", "")
                prev_ip = prev_data.get("ip", "")

                # UDP 发现仅接受本机真实子网中的地址，防止 WSL/VPN/VMware
                # 网卡广播穿透后用不可达地址覆盖正确的局域网地址。
                if not self._is_same_subnet(new_ip):
                    logger.debug(
                        "忽略非本地子网心跳 uuid=%s advertised_ip=%s source_ip=%s",
                        uuid,
                        new_ip,
                        source_ip,
                    )
                    return

                # 多网卡广播去重：只接受同子网的 IP，防止虚拟机/VPN 网卡的
                # 广播覆盖了真正的局域网 IP（最后到达的包会覆盖先前的）
                use_ip = new_ip
                if not is_new and new_ip and prev_ip:
                    new_same = self._is_same_subnet(new_ip)
                    prev_same = self._is_same_subnet(prev_ip)
                    if prev_same and not new_same:
                        # 旧 IP 和本机同子网，新 IP 不是 → 保留旧 IP
                        use_ip = prev_ip

                self._peers[uuid] = {
                    "uuid": uuid,
                    "name": msg.get("name", "Unknown"),
                    "ip": use_ip,
                    "ws_port": msg.get("ws_port", 50002),
                    "token": msg.get("token", ""),
                    "previous_token": prev_data.get("token", ""),
                    "last_seen": time.time(),
                    "miss_count": 0,
                    "status": "online",
                }

                # 触发上线/更新回调
                # ① 新节点 ② 从离线恢复 ③ 已在线但 name/IP 变化 → 都通知前端
                name_changed = msg.get("name") != prev_data.get("name")
                ip_changed = msg.get("ip") != prev_data.get("ip")
                updated = name_changed or ip_changed
                if self.on_peer_online and (is_new or was_offline or updated):
                    self.on_peer_online(self._peers[uuid].copy())
                if is_new or was_offline:
                    logger.info(
                        "节点上线 uuid=%s name=%s ip=%s source_ip=%s",
                        uuid,
                        self._peers[uuid]["name"],
                        use_ip,
                        source_ip,
                    )

            elif msg_type == "goodbye":
                if uuid in self._peers:
                    self._peers[uuid]["status"] = "offline"
                    self._peers[uuid]["last_seen"] = time.time()
                    logger.info("节点主动下线 uuid=%s ip=%s", uuid, self._peers[uuid].get("ip"))
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
            logger.info(
                "节点心跳超时 uuid=%s ip=%s miss_count=%s",
                peer.get("uuid"),
                peer.get("ip"),
                peer.get("miss_count"),
            )
            if self.on_peer_offline:
                self.on_peer_offline(peer)
