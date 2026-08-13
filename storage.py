"""
存储模块：联系人 + 配置的 JSON 持久化读写。

数据目录结构:
  data/
  ├── config.json    # 本机配置 {uuid, name}
  ├── contacts.json  # 联系人 {uuid: {name, ip, messages[], ...}}
  └── downloads/     # 接收的文件 + .progress 进度文件
"""

import json
import os
import threading
from pathlib import Path
from datetime import datetime

# 数据目录：可通过环境变量 LANCHAT_DATA_DIR 覆盖，默认在项目根目录下
_DATA_DIR_OVERRIDE = os.environ.get("LANCHAT_DATA_DIR", "")
if _DATA_DIR_OVERRIDE:
    DATA_DIR = Path(_DATA_DIR_OVERRIDE)
else:
    DATA_DIR = Path(__file__).parent / "data"
CONFIG_PATH = DATA_DIR / "config.json"
CONTACTS_PATH = DATA_DIR / "contacts.json"
DOWNLOADS_DIR = DATA_DIR / "downloads"

# 读写锁，防止并发写入损坏文件
_contacts_lock = threading.Lock()
_config_lock = threading.Lock()


def ensure_data_dir():
    """确保数据目录存在"""
    DATA_DIR.mkdir(exist_ok=True)
    DOWNLOADS_DIR.mkdir(exist_ok=True)


def load_config() -> dict:
    """
    读取本机配置。如果文件不存在，返回空字典。
    调用方负责生成默认值。
    """
    ensure_data_dir()
    if CONFIG_PATH.exists():
        try:
            with _config_lock:
                return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_config(config: dict):
    """保存本机配置到 data/config.json"""
    ensure_data_dir()
    with _config_lock:
        CONFIG_PATH.write_text(
            json.dumps(config, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def _load_contacts_unsafe() -> dict:
    """读取全部联系人数据（不加锁，调用方需持有 _contacts_lock）"""
    ensure_data_dir()
    if CONTACTS_PATH.exists():
        try:
            return json.loads(CONTACTS_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_contacts_unsafe(contacts: dict):
    """保存全部联系人数据（不加锁，调用方需持有 _contacts_lock）"""
    ensure_data_dir()
    CONTACTS_PATH.write_text(
        json.dumps(contacts, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def load_contacts() -> dict:
    """
    读取全部联系人数据（线程安全）。
    返回: {uuid: {name, ip, first_contact, last_contact, messages:[]}}
    """
    with _contacts_lock:
        return _load_contacts_unsafe()


def save_contacts(contacts: dict):
    """保存全部联系人数据到 data/contacts.json（线程安全）"""
    with _contacts_lock:
        _save_contacts_unsafe(contacts)


def get_contact(uuid: str) -> dict | None:
    """获取单个联系人信息，不存在返回 None"""
    contacts = load_contacts()
    return contacts.get(uuid)


def upsert_contact(uuid: str, name: str, ip: str, ws_port: int = 50002):
    """
    添加或更新联系人基本信息（不覆盖 messages）。
    首次接触时记录 first_contact，每次更新 last_contact。
    ws_port 用于跨子网 HTTP 探活时知道对方监听端口。
    重连时重置 trusted 为 true（对方已重新验证通过）。

    线程安全：锁覆盖读→改→写全周期，防止并发导致数据丢失。
    """
    with _contacts_lock:
        contacts = _load_contacts_unsafe()
        now = datetime.now().isoformat()

        if uuid not in contacts:
            contacts[uuid] = {
                "name": name,
                "ip": ip,
                "ws_port": ws_port,
                "first_contact": now,
                "last_contact": now,
                "messages": [],
                "trusted": True,
            }
        else:
            contacts[uuid]["name"] = name
            contacts[uuid]["ip"] = ip
            contacts[uuid]["ws_port"] = ws_port
            contacts[uuid]["last_contact"] = now
            contacts[uuid]["trusted"] = True  # 重连后恢复信任
            # 如果旧数据没有 messages 字段，补上
            if "messages" not in contacts[uuid]:
                contacts[uuid]["messages"] = []

        _save_contacts_unsafe(contacts)


def append_message(uuid: str, sender: str, content: str, msg_id: str,
                   msg_type: str = "chat", **extra):
    """
    向指定联系人的消息列表追加或更新一条消息。

    参数:
      uuid:     联系人 UUID
      sender:   "me" 表示自己发的，否则是对面的 uuid
      content:  消息文本内容（文件消息可为空或描述）
      msg_id:   消息唯一 ID（去重依据）
      msg_type: "chat" 或 "file"
      extra:    文件消息的附加字段（file_name, file_size, transfer_id, status, progress）

    线程安全：锁覆盖整个读→改→写周期，防止并发写入导致消息丢失。
    msg_id 去重：chat 消息已存在则跳过；file 消息已存在则更新 status/progress 字段。
    """
    with _contacts_lock:
        contacts = _load_contacts_unsafe()

        if uuid not in contacts:
            contacts[uuid] = {
                "name": "Unknown",
                "ip": "",
                "first_contact": datetime.now().isoformat(),
                "last_contact": "",
                "messages": [],
            }

        # 查找是否已有同 msg_id 的消息
        existing_idx = None
        for i, m in enumerate(contacts[uuid].get("messages", [])):
            if m.get("msg_id") == msg_id:
                existing_idx = i
                break

        if existing_idx is not None:
            if msg_type == "file":
                # 文件消息：更新状态和进度（传输过程中状态会变化多次）
                msg = contacts[uuid]["messages"][existing_idx]
                for key in ("status", "progress", "file_size", "file_name", "transfer_id"):
                    if key in extra:
                        msg[key] = extra[key]
                if extra.get("status") == "complete":
                    msg["progress"] = 100
            # chat 消息已存在则跳过（去重）
            # 无论如何更新 last_contact
            contacts[uuid]["last_contact"] = datetime.now().isoformat()
            _save_contacts_unsafe(contacts)
            return

        # 新消息
        msg = {
            "from": sender,
            "content": content,
            "msg_id": msg_id,
            "type": msg_type,
            "timestamp": datetime.now().isoformat(),
        }
        # 文件消息的额外字段
        if msg_type == "file":
            for key in ("file_name", "file_size", "transfer_id", "status", "progress"):
                if key in extra:
                    msg[key] = extra[key]
            if "status" not in extra:
                msg["status"] = "pending"

        contacts[uuid]["messages"].append(msg)
        contacts[uuid]["last_contact"] = datetime.now().isoformat()
        _save_contacts_unsafe(contacts)


def get_messages(uuid: str) -> list[dict]:
    """获取指定联系人的聊天记录"""
    contact = get_contact(uuid)
    if contact:
        return contact.get("messages", [])
    return []


def mark_contact_untrusted(uuid: str):
    """将联系人标记为不可信（对方删除了我们，下次重连需重新验证）"""
    with _contacts_lock:
        contacts = _load_contacts_unsafe()
        if uuid in contacts:
            contacts[uuid]["trusted"] = False
            _save_contacts_unsafe(contacts)


def delete_contact(uuid: str):
    """删除联系人及其聊天记录（完整删除，不留任何记录）。"""
    with _contacts_lock:
        contacts = _load_contacts_unsafe()
        if uuid in contacts:
            del contacts[uuid]
            _save_contacts_unsafe(contacts)


def remove_deleted_tombstones():
    """一次性清理旧版本（v32）遗留的墓碑记录（deleted=true），改回完整删除语义。"""
    with _contacts_lock:
        contacts = _load_contacts_unsafe()
        stale = [uuid for uuid, info in contacts.items() if info.get("deleted", False)]
        if stale:
            for uuid in stale:
                del contacts[uuid]
            _save_contacts_unsafe(contacts)


def list_contacts() -> list[dict]:
    """返回联系人列表（不含 messages，减少数据量）"""
    contacts = load_contacts()
    result = []
    for uuid, info in contacts.items():
        result.append({
            "uuid": uuid,
            "name": info.get("name", "Unknown"),
            "ip": info.get("ip", ""),
            "ws_port": info.get("ws_port", 50002),
            "first_contact": info.get("first_contact", ""),
            "last_contact": info.get("last_contact", ""),
            "trusted": info.get("trusted", True),
            "message_count": len(info.get("messages", [])),
        })
    # 按最后联系时间倒序排列
    result.sort(key=lambda x: x["last_contact"], reverse=True)
    return result


# ----- 传输进度文件管理 -----

def save_progress(transfer_id: str, progress: dict):
    """保存传输进度文件"""
    ensure_data_dir()
    path = DOWNLOADS_DIR / f"{transfer_id}.progress"
    path.write_text(json.dumps(progress, indent=2, ensure_ascii=False), encoding="utf-8")


def load_progress(transfer_id: str) -> dict | None:
    """读取传输进度文件，不存在返回 None"""
    path = DOWNLOADS_DIR / f"{transfer_id}.progress"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
    return None


def update_progress(transfer_id: str, chunk_index: int, received_bytes: int):
    """
    更新传输进度：记录已收分片。
    因为频繁调用，采用简单的读-改-写（频次不高的情况下够用）。
    """
    progress = load_progress(transfer_id)
    if progress:
        if chunk_index not in progress.get("received_chunks", []):
            progress["received_chunks"].append(chunk_index)
        progress["received_bytes"] = received_bytes
        progress["last_update"] = datetime.now().isoformat()
        save_progress(transfer_id, progress)


def delete_progress(transfer_id: str):
    """删除传输进度文件和对应的临时文件"""
    progress_path = DOWNLOADS_DIR / f"{transfer_id}.progress"
    if progress_path.exists():
        progress_path.unlink()
    # 也尝试删除对应的 .part 文件（通过 transfer_id 查找）
    for f in DOWNLOADS_DIR.glob("*.part"):
        if f.stem.startswith(transfer_id):
            f.unlink()


def get_download_path(file_name: str) -> Path:
    """
    获取下载文件路径，自动处理同名冲突。
    demo.mp4 → demo.mp4 (无冲突)
    demo.mp4 → demo(1).mp4 (有冲突)

    安全防护：resolve() 后检查路径必须在 DOWNLOADS_DIR 内，防止路径穿越攻击。
    同时对 file_name 做 sanitize，只取文件名部分，丢弃目录成分。
    """
    ensure_data_dir()
    # 只取文件名，丢弃任何目录成分（防御路径穿越的第一层）
    safe_name = Path(file_name).name
    target = (DOWNLOADS_DIR / safe_name).resolve()
    allowed_base = DOWNLOADS_DIR.resolve()
    if not str(target).startswith(str(allowed_base)):
        raise ValueError(f"非法的文件路径: {file_name}")

    # 生成目标路径时也使用 resolve 后的 safe_name，避免后续拼接触发穿越
    if not target.exists():
        return target

    stem = target.stem
    suffix = target.suffix
    counter = 1
    while True:
        new_name = f"{stem}({counter}){suffix}"
        candidate = (DOWNLOADS_DIR / new_name).resolve()
        if not str(candidate).startswith(str(allowed_base)):
            raise ValueError(f"非法的文件路径: {new_name}")
        if not candidate.exists():
            return candidate
        counter += 1


def cleanup_expired_progress(max_age_hours: int = 24):
    """
    清理超过指定小时未更新的 .progress 文件和对应的 .part 文件。
    可在程序启动时调用一次。
    """
    from datetime import timedelta

    now = datetime.now()
    threshold = now - timedelta(hours=max_age_hours)

    for progress_path in DOWNLOADS_DIR.glob("*.progress"):
        try:
            data = json.loads(progress_path.read_text(encoding="utf-8"))
            last_update = datetime.fromisoformat(data.get("last_update", "2000-01-01"))
            if last_update < threshold:
                transfer_id = progress_path.stem
                delete_progress(transfer_id)
        except (json.JSONDecodeError, OSError, ValueError):
            # 损坏的文件直接删除
            progress_path.unlink()
