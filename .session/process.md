# LanChat 开发过程记录

## 2026-08-10 调试与修复

### 1. 异步回调线程安全修复

**问题**：`discovery.py` 的 UDP 监听线程通过 `self.on_peer_online(peer)` 同步调用回调，但 `main.py` 中的 `_notify_peer_online` 是 `async` 协程，导致 `RuntimeWarning: coroutine was never awaited`。

**修复**（`main.py`）：
- 在 lifespan 启动时保存事件循环引用 `_main_loop = asyncio.get_running_loop()`
- 新增 `_make_threadsafe(async_func)` 包装器，内部调用 `asyncio.run_coroutine_threadsafe()` 将协程调度到主事件循环
- 将 discovery 回调注册为线程安全版本：
  ```python
  discovery.on_peer_online = _make_threadsafe(_notify_peer_online)
  discovery.on_peer_offline = _make_threadsafe(_notify_peer_offline)
  ```

### 2. Token 验证修复

**问题**：前端 `connectToPeer()` 发送 `token: ''`（空字符串），后端 `discovery.verify_token()` 验证必然失败，连接被拒绝。

**根因分析**：
- Token 认证机制：每个节点生成 token 并通过 UDP 心跳广播，建立 WS 连接时出示**自己的** token，对方用 UDP 收到的 token 验证
- 前端错误地发送了对端的 token（甚至为空）

**修复**：
- 后端 init 消息和 `/api/me` 响应增加 `token` 字段
- 前端 `handleInit` 存储 `myInfo.token`
- `connectToPeer` 改为发送 `myInfo.token`（自己的 token）
- 连接前先调 `/api/me` 刷新 token（token 每 3 秒过期，含 previous 容错共 6 秒窗口）
- 前端区分拒绝原因：`invalid_token` 显示"Token 验证失败"，其他显示"对方拒绝了连接请求"

### 3. 消息发送双路径

**问题**：消息发送路径错误，A 通过 control WS 发给自己的后端，但自己的后端 `active_chats` 中没有 B（B 从未连接过 A 的后端）。

**双向通信流程**（单条 chat WS 双向复用）：

```
A（发起方）→ B：
  A浏览器 → chat WS(A→B后端) → B后端 _relay_from_peer → 保存 + 通知B浏览器(control WS) + ACK回A

B（接收方）→ A：
  B浏览器 → control WS(B后端) → B后端 _handle_chat_message_from_browser → 复用chat WS(A→B后端) → A浏览器
```

**修复**：
- `sendCurrentMessage`：有 chat WS 时直发 peer 后端（type: `chat`），否则走 control WS（type: `chat_message`）
- 5 秒 ACK 超时检测

### 4. 消息与联系人持久化

**问题**：chat WS 直连收发消息绕过了自己的后端，消息只保存在接收方 contacts.json，发送方刷新页面后历史丢失。

**修复**：
- 后端新增 `save_message` 和 `save_contact` 控制消息类型
- 前端 `sendCurrentMessage`（chat WS 路径）：发后额外调 `controlWs.send({type: 'save_message', ...})` 通知自己后端保存
- 前端 `handleDirectChatMessage`：收到消息后调 `controlWs.send({type: 'save_message', ...})` 持久化
- `connectToPeer` 收到 `connect_accepted` 后调 `controlWs.send({type: 'save_contact', ...})` 保存联系人信息
- `openChat` 首次打开时调 `/api/messages/{uuid}` 加载历史消息
- init 消息携带完整联系人列表，页面加载即刻显示

### 5. 联系人在线状态统一

**问题**：多处使用不同数据源判断在线状态，导致不一致：
- 联系人圆点用 `contact.status`（5s 刷新）
- 点击行为用 `onlinePeers.has()`（3s 刷新）
- 聊天头部用 `onlinePeers.has()`
- 输入框禁用用 `contact.status`
- 首页渲染时 `onlinePeers` 为空（`fetchPeers` 尚未返回），联系人全显示离线

**修复**：
- 统一使用 `onlinePeers.has(uuid)` 作为唯一在线状态判断源
- `handleInit`：先调 `updateOnlinePeers(msg.online_peers)` 填充 Map，再调 `updateContacts(msg.contacts)` 渲染
- `updateOnlinePeers`：每次更新后同步调用 `renderContactsList()` 和 `updateChatHeaderStatus()`
- `updateChatHeaderStatus`：统一控制聊天头部文字、输入框和发送按钮的 disabled 状态
- init 消息增加 `online_peers` 字段，后端在 WS 连接时即下发当前在线节点
- 离线联系人点击：弹出"对方不在线"提示 + 加载历史记录（只读）

### 设计流程总结

```
页面加载
  → control WS 连接
  → 收到 init {contacts, online_peers, token, ...}
  → updateOnlinePeers(online_peers)  // 填充在线Map
  → updateContacts(contacts)          // 渲染联系人（状态正确）
  → startPolling()                    // 每3s轮询在线节点，每5s轮询联系人

点击在线联系人（绿色🟢）
  → refresh /api/me 获取最新 token
  → 打开 WS ws://peer_ip:peer_port/ws/chat
  → 发送 connect_request {uuid, name, token}  // 自己的 token
  → 对方后端验证 token
  → 对方浏览器收到 incoming_connection，显示同意/拒绝按钮
  → 对方同意 → connect_accepted → 连接建立
  → 双向消息：主动方走 chat WS，被动方走 control WS + 复用 chat WS

点击离线联系人（红色🔴）
  → 弹出"对方不在线"
  → 打开聊天窗口，加载 /api/messages/{uuid} 历史记录
  → 输入框禁用（只读模式）
```

**文件传输功能还没有验证，甚至重传等等策略