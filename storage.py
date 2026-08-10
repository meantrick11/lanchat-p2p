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


def load_contacts() -> dict:
    """
    读取全部联系人数据。
    返回: {uuid: {name, ip, first_contact, last_contact, messages:[]}}
    """
    ensure_data_dir()
    if CONTACTS_PATH.exists():
        try:
            with _contacts_lock:
                return json.loads(CONTACTS_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_contacts(contacts: dict):
    """保存全部联系人数据到 data/contacts.json"""
    ensure_data_dir()
    with _contacts_lock:
        CONTACTS_PATH.write_text(
            json.dumps(contacts, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def get_contact(uuid: str) -> dict | None:
    """获取单个联系人信息，不存在返回 None"""
    contacts = load_contacts()
    return contacts.get(uuid)


def upsert_contact(uuid: str, name: str, ip: str):
    """
    添加或更新联系人基本信息（不覆盖 messages）。
    首次接触时记录 first_contact，每次更新 last_contact。
    """
    contacts = load_contacts()
    now = datetime.now().isoformat()

    if uuid not in contacts:
        contacts[uuid] = {
            "name": name,
            "ip": ip,
            "first_contact": now,
            "last_contact": now,
            "messages": [],
        }
    else:
        contacts[uuid]["name"] = name
        contacts[uuid]["ip"] = ip
        contacts[uuid]["last_contact"] = now
        # 如果旧数据没有 messages 字段，补上
        if "messages" not in contacts[uuid]:
            contacts[uuid]["messages"] = []

    save_contacts(contacts)


def append_message(uuid: str, sender: str, content: str, msg_id: str):
    """
    向指定联系人的消息列表追加一条消息。
    sender: "me" 表示自己发的，否则是对面的 uuid。
    同时更新 last_contact 时间。
    """
    contacts = load_contacts()

    if uuid not in contacts:
        # 极端情况：对方还没加入联系人（比如从在线列表直接发了消息但还未建立正式连接），先创建空记录
        contacts[uuid] = {
            "name": "Unknown",
            "ip": "",
            "first_contact": datetime.now().isoformat(),
            "last_contact": "",
            "messages": [],
        }

    msg = {
        "from": sender,
        "content": content,
        "msg_id": msg_id,
        "timestamp": datetime.now().isoformat(),
    }
    contacts[uuid]["messages"].append(msg)
    contacts[uuid]["last_contact"] = datetime.now().isoformat()
    save_contacts(contacts)


def get_messages(uuid: str) -> list[dict]:
    """获取指定联系人的聊天记录"""
    contact = get_contact(uuid)
    if contact:
        return contact.get("messages", [])
    return []


def delete_contact(uuid: str):
    """删除指定联系人及其聊天记录"""
    contacts = load_contacts()
    if uuid in contacts:
        del contacts[uuid]
        save_contacts(contacts)


def list_contacts() -> list[dict]:
    """返回联系人列表（不含 messages，减少数据量）"""
    contacts = load_contacts()
    result = []
    for uuid, info in contacts.items():
        result.append({
            "uuid": uuid,
            "name": info.get("name", "Unknown"),
            "ip": info.get("ip", ""),
            "first_contact": info.get("first_contact", ""),
            "last_contact": info.get("last_contact", ""),
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
    """
    ensure_data_dir()
    target = DOWNLOADS_DIR / file_name
    if not target.exists():
        return target

    stem = target.stem
    suffix = target.suffix
    counter = 1
    while True:
        new_name = f"{stem}({counter}){suffix}"
        target = DOWNLOADS_DIR / new_name
        if not target.exists():
            return target
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
