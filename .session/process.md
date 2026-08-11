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

**文件传输功能还没有验证，甚至重传等等策略都没有验证，就将整体的双方通信聊天实现了**

---

### 6. 多网卡发现修复（2026-08-10）

**问题**：多网卡主机（如物理机 + 虚拟机 Host-Only 网卡）广播时，所有网卡发出的 UDP 包都携带同一个全局 `my_ip`。当该 IP 属于另一子网时，接收方拿到的 IP 无法回连。

**修复**（`discovery.py`）：
- `_get_broadcast_addresses()` 重构为 `_get_broadcast_interfaces()`，返回值从 `[广播地址]` 改为 `[(广播地址, 网卡IP)]`，每张网卡配对各自的 IP
- `_broadcast_heartbeat()` 改为逐网卡构造广播包，各自携带该网卡的 IP
- Windows 平台新增 `ipconfig` 解析兜底（中英文双语正则），补全 `getaddrinfo` 遗漏的虚拟网卡（如 VMware Host-Only）
- 接口枚举结果增加 60 秒缓存，避免 `ipconfig` 每 3 秒心跳调用一次

**修复**（`main.py`）：
- `get_local_ip()` 增加无外网环境下的网卡枚举 fallback（连接 8.8.8.8 失败时不再返回 127.0.0.1）

**效果**：每张网卡各自携带自己子网的 IP 广播，接收方拿到的 IP 一定是同子网可达的地址。

---

### 7. 同机多实例 UUID 冲突修复（2026-08-11）

**问题**：同一台机器启动多个实例（测试需要）时，所有实例共享 `data/config.json`，导致 UUID 完全相同。`discovery._handle_message()` 用 `if uuid == self.my_uuid: return` 过滤自己的广播——同 UUID 意味着各实例互相把对方当"自己"忽略，UDP 发现失败。WebSocket 连接也因 UUID 冲突导致前端状态混乱。

**修复**（`main.py`）：
- `MY_UUID` 从 `config["uuid"]` 改为 `f"{config['uuid']}_{WS_PORT}"`，端口后缀确保同机多实例 UUID 唯一
- `find_available_port()` 移到 `MY_UUID` 之前执行，确保端口先确定

**修复**（`discovery.py`）：
- `_handle_message()` 已有机的 UUID 过滤现在正常工作——各实例 UUID 不同，不再互相忽略

**效果**：同机多实例各自唯一身份，UDP 广播互相发现，连接建立正常。

### 8. 自节点过滤（2026-08-11）

**问题**：用户在线列表和历史联系人中偶尔出现自己。虽然 UDP 层过滤了自己的广播，但 HTTP 探活 `_probe_saved_contacts()` 和前端渲染缺少自节点过滤。

**修复**（`main.py`）：
- init 消息中过滤 `MY_UUID`：`init_contacts` 和 `online_peers_list` 排除自己
- `_probe_saved_contacts()` 跳过 `c.get("uuid") == MY_UUID`
- `ws_chat` 增加 self_connect 拒绝：`if peer_uuid == MY_UUID`

**修复**（`static/app.js`）：
- `handlePeerOnline()` 跳过 `msg.uuid === myInfo.uuid`
- `updateOnlinePeers()` 跳过 `p.uuid === myInfo.uuid`
- `updateContacts()` 跳过 `c.uuid === myInfo.uuid`
- `connectByIp()` 拒绝自连 `ip === myInfo.ip && port === myInfo.ws_port`

**效果**：前后端多层过滤，当前用户不会出现在在线列表、历史联系人、或连接请求中。

### 9. 跨子网手动 IP 连接与自动探活（2026-08-11）

**问题**：UDP 广播只对同子网有效，跨子网（如物理机连虚拟机 Host-Only 网段）无法自动发现。TCP 虽然可达，但没有自动发现和状态维护机制。

**方案**：

#### 9a. 手动 IP 连接 UI
- 在线列表标题栏增加 `➕` 按钮，点击展开 IP:端口输入行
- `connectByIp(ip, port)` 函数：直接 WebSocket 连接目标 IP:端口，发送 connect_request
- 收到 connect_accepted 后替换临时 UUID 为真实 UUID，保存联系人

#### 9b. 跨子网 Token 验证
- **问题**：跨子网时接收方 peer_list 中没有发起方的 UDP 广播记录，无法验证 token
- **解决**：新增 `_verify_token_via_api(uuid, token, ip, port)` — HTTP GET 发起方的 `/api/me`，对比返回的 token
- `ws_chat` 流程：UDP 验证失败 → 反向 API 验证 → 通过则临时写入 peer_list
- connect_request 新增 `ip` 和 `ws_port` 字段，供接收方反向验证

**修复**（`main.py`）：
- 新增 `_verify_token_via_api()` 异步函数（`asyncio.to_thread` + `urllib.request`）
- `ws_chat` 中 Token 验证增加跨子网兜底逻辑
- `ws.client.host` 修复为 `ws.client[0]`（Starlette 返回 tuple 不是对象）

#### 9c. 联系人存储 ws_port
- `upsert_contact()` 新增 `ws_port` 参数并持久化到 `contacts.json`
- `list_contacts()` 返回 `ws_port` 字段
- 所有 `upsert_contact()` 调用点更新传 `ws_port`
- 前端 `save_contact` 消息携带 `ws_port`

#### 9d. 定期 HTTP 探活
- `_probe_saved_contacts()` 改为**每 30 秒循环探活**
- 对不在 UDP 在线列表中的历史联系人发起 HTTP GET `/api/me`
- 探活成功 → 刷新 `discovery._peers` 中的 `last_seen`（阻止 UDP 超时踢下线）→ 未在线则通知前端上线
- 探活失败 → 不处理，让 UDP 超时机制自然标记离线

**效果**：
- 跨子网联系人：手动 IP 连接一次 → 重启后自动 HTTP 探活发现 → 持续每 30s 续活
- 同子网联系人：UDP 广播自动维护，不受影响
- 联系人持久化包含端口信息，重启不丢失

### 10. 其他修复（2026-08-11）

- **deleteCurrentContact 缺失**：`app.js` 补充 `deleteCurrentContact()` 函数；`main.py` 补充 `delete_contact` 消息 handler
- **ws.client.host 错误**：Starlette `ws.client` 返回 `tuple(host, port)`，修复为 `ws.client[0]`
- **connect_request 增加 ip/ws_port**：前端 `connectToPeer` 和 `connectByIp` 都携带自身 IP 和端口

---

### 11. 聊天消息持久化竞态条件修复（2026-08-11）

**问题**：`storage.py` 的 `append_message()` 中 `_contacts_lock` 只在 `load_contacts()` 和 `save_contacts()` **各自内部**加锁，两次锁之间有竞态窗口。每条消息到达时两条代码路径几乎同时调用 `append_message`（`_relay_from_peer` + 浏览器 `save_message`），并发写互相覆盖导致消息丢失。

**修复**（`storage.py`）：
- 拆分出 `_load_contacts_unsafe()` / `_save_contacts_unsafe()` 内部版本（不加锁，调用方持锁）
- `append_message()` 改为**持锁覆盖整个周期**：`加锁 → 读取 → 去重检查 → 追加 → 写入 → 释放锁`
- 新增 `msg_id` 去重：已存在的 msg_id 直接跳过，防止重复保存
- `load_contacts()` / `save_contacts()` 重构为：加锁 → 调 unsafe 版本 → 释放锁

**修复**（`app.js`）：
- `handleIncomingMessage` 收到消息后立即发 `save_message` 给后端持久化，与后端 `_relay_from_peer` 形成双保险

---

### 12. 文件消息持久化（2026-08-11）

**问题**：文件传输消息只存在浏览器内存，刷新页面后文件传输历史丢失。

**修复**（`storage.py`）：
- `append_message()` 新增 `msg_type` 参数（`"chat"` / `"file"`）和 `**extra` 关键字参数
- chat 消息：msg_id 已存在 → 跳过（去重）
- file 消息：msg_id 已存在 → **更新** status/progress（传输中状态会变化多次）
- 新消息自动附加 `type: "file"` + `file_name` / `file_size` / `transfer_id` / `status` / `progress`

**修复**（`main.py`）：
- `_handle_save_message` 提取 `msg_type` 和文件专用字段，透传给 `append_message`

**修复**（`app.js`）：
- 新增 `saveFileMessage(peerUuid, fileMsg)` 辅助函数
- 在发送方选文件、接收方接受、开始上传、传输完成/失败/取消等关键节点调用持久化

---

### 13. 文件消息刷新后变空白修复（2026-08-11）

**问题**：刷新页面后文件消息显示空白，只留下时间戳。两个原因：
1. CSS 完全缺失——`.file-card` `.file-name` `.file-progress-bar` 等 10+ 个类无样式定义
2. 旧数据无 `type` 字段——`renderMessages` 靠 `m.type === 'file'` 识别，旧消息的 content 为空 → 落到文本渲染分支 → 显示空白 + 时间

**修复**（`style.css`）：
- 新增 `.file-msg` / `.file-card` / `.file-icon` / `.file-info` / `.file-name` / `.file-size` / `.file-progress-bar` / `.file-progress-fill` / `.file-status` / `.btn-open-file` / `.file-time` 完整样式
- 发送方蓝色背景白字，接收方白底边框，与文字消息风格统一

**修复**（`app.js`）：
- `renderMessages` 检测条件扩展为 `m.type === 'file' || m.msg_id.startsWith('f_')`，旧数据也能命中
- `renderFileBubble` 所有字段加默认值（`msg.file_name || '未知文件'`，`msg.status || 'failed'` 等），缺字段不崩溃

---

### 14. 发送文件间歇性"未建立连接"修复（2026-08-11）

**问题**：`sendFile` 和 `sendMessage` 不对称。`sendMessage` 无 chatWs 时走 control WS 回退路径，但 `sendFile` 直接报错"未连接到对方"。WS 因网络波动短暂断开时，文字消息能发但文件传输失败。

**修复**（`main.py`）：
- 控制 WS 新增 `file_request` 消息处理 → `_handle_file_request_from_browser()`，通过服务端 `active_chats` 转发给对端

**修复**（`app.js`）：
- `sendFile`：无 chatWs 时走 `controlWs.send({type: 'file_request', to_uuid, ...})` 回退路径

---

### 15. 连接状态显示双方同步（2026-08-11）

**问题**：接收方（被动方）不创建 outgoing chat WS，`activeChats` Map 永远为空，导致侧边栏和聊天头部永远显示"在线（未连接）"而非"已连接"。连接建立与否的状态不直观。

**修复**（`app.js`）：
- 新增 `connectedPeers` Set，追踪"连接已确认"的 peer uuid（双方向都追踪）
- **主动方**：`connect_accepted` 回调设置 `connectedPeers.add(uuid)`
- **被动方**：`handleConnectionEstablished` 回调设置 `connectedPeers.add(uuid)`
- **断开**：`ws.onclose` / `handlePeerDisconnected` 清理 `connectedPeers.delete(uuid)`
- `getConnectionLabel(uuid)` 同时检查 `activeChats` 和 `connectedPeers`
- `updateChatHeaderStatus` 区分三种状态：🟢已连接 / 🟡在线未连接 / 🔴离线
- 连接状态变化时立即刷新侧边栏（`renderOnlineList` + `renderContactsList`）

---

### 16. 文件打开触发浏览器重新下载修复（2026-08-11）

**问题**：`/api/downloads/{file_name}` 返回 `FileResponse(file_path, filename=file_path.name)`，Starlette 检测到 `filename` 参数自动加 `Content-Disposition: attachment`，浏览器强制下载而非直接打开本地已存文件。

**修复**（`main.py`）：
- 去掉 `filename` 参数 → `FileResponse(file_path)`，浏览器根据文件类型自行决定打开方式

---

### 17. 旧进程残留导致在线列表出现已停止用户（2026-08-11）

**问题**：多次重启实例后，`Stop-Process -Id` 杀进程不完全，旧 Python 进程持续发 UDP 广播，在线列表出现"测试用户A/B"等已停止的旧用户。

**修复**：`Get-Process python* | Stop-Process -Force` 全量杀进程，清理旧 `data_a/` `data_b/` 数据目录，全新启动

---

### 18. 断开连接功能 & 删除联系人底层 WS 未断开修复（2026-08-11）

**问题 A**：没有主动断开连接的功能，用户无法单方面终止已建立的聊天连接。

**问题 B**：删除联系人只删除 `contacts.json` 和内存数据，底层 WebSocket 连接仍然存在。双方侧边栏都显示"已连接"，被删除方成为"幽灵连接"。

**方案设计**（用户确认）：
- 聊天头部加"断开"按钮，单方面断开无需对方确认
- 断开时关闭两端的 WS：本方 outgoing chat WS + 服务端 incoming chat WS
- 删除联系人时先断开底层 WS，再删除数据

**修复**（`main.py`）：
- 控制 WS 新增 `disconnect` 消息处理 → `_handle_disconnect_from_browser()`
- 后者关闭 `active_chats[to_uuid]`（对方连进来的 WS），通知自己浏览器 `{type: "disconnected"}`
- 对方浏览器的 `ws_chat` finally 自动发送 `peer_disconnected`，对方 UI 同步更新

**修复**（`app.js`）：
- 新增 `disconnectCurrentChat()` 函数：
  1. 弹确认框（如有进行中的文件传输，额外警告）
  2. 关闭本方 outgoing chat WS（`activeChats.delete(uuid)`）
  3. 通过 control WS 通知后端关闭 incoming chat WS
  4. 清理 `connectedPeers`、`pendingFileTransfers`
  5. 更新 UI（列表、头部状态、系统消息）
- 新增 `handleDisconnected()` 处理 `disconnected` 控制消息
- `updateChatHeaderStatus()` 根据连接状态显示/隐藏断开按钮
- `deleteCurrentContact()` 先调用断开逻辑（关闭 WS + 通知后端），再删除联系人
- `connectByIp()` 修复：`connect_accepted` 设置 `connectedPeers.add(realUuid)`，onclose 清理 `connectedPeers`

**修复**（`index.html`）：
- 聊天头部新增 `<button id="btn-disconnect" class="btn-sm btn-disconnect">断开</button>`

**修复**（`style.css`）：
- 新增 `.btn-disconnect` 样式：红色边框，悬停填充红色背景

**效果**：
- 任意一方点击"断开"→ 双方 UI 立即更新为"在线（未连接）"或"离线"
- 断开按钮仅在已连接状态下显示（🟢已连接），其他状态隐藏
- 删除联系人自动断开底层 WS，不会产生"幽灵连接"

---

### 19. 删除联系人确认弹窗（2026-08-11）

**问题**：聊天头部 🗑 按钮直接删除联系人，没有确认步骤，容易误操作。

**修复**（`app.js`）：
- `deleteCurrentContact()` 开头增加 `confirm()` 弹窗，显示对方昵称和"此操作不可恢复"警告

---

### 20. 文件发送回退路径（Path 2）修复（2026-08-11）

**问题**：当发送方没有直接 chat WS（被动接收方发文件）时，文件请求无法到达对端。

**根因分析**：
1. 原 Path 2 回退路径：control WS → 后端 → `active_chats[target]`（chat WS）→ **对端前端** → `setupPeerMessageHandler` 无 `file_request` handler → 静默丢弃
2. 对端接受后：`_handle_file_response` 中 `peer_ws = active_chats.get(sender_uuid)` 为 None → 响应无法传回

**修复**（`main.py`）：
- 新增 `POST /api/transfer/request` 端点：接收其他后端的文件 relay，创建 transfer + 通知自己浏览器
- `_handle_file_request_from_browser` 重写：优先 HTTP POST 到对端后端 → 失败则 chat WS 回退
- `_handle_file_response`：`peer_ws` 为空时发送 `forward_file_response` 通知自己浏览器转发
- 控制 WS 新增 `register_transfer` 处理：浏览器收到 chat WS file_request 后在本地注册 transfer

**修复**（`app.js`）：
- `handleControlMessage` 新增 `forward_file_response` handler
- 新增 `handleForwardFileResponse()`：收到转发指令后通过本方 chat WS 发送 `file_response`
- `setupPeerMessageHandler` 新增 `file_request` 处理：注册 transfer + 弹窗确认（HTTP relay 失败 fallback）

---

### 21. 聊天滚动 & 文件消息不可见修复（2026-08-11）

**问题 A**：消息超过窗口高度时不出现滚动条，先向上挤压覆盖部分消息，发很多条才"反应"出现滚动条。

**问题 B**：文件消息气泡在聊天区完全不显示，但 console 日志确认 `renderFileBubble` 被正确调用、DOM 元素被插入。

**根因分析**：
- Flexbox 隐式 `min-height: auto`：`#chat-container` 和 `#chat-messages` 都是 flex 子元素，默认 `min-height: auto` 让容器随内容撑高，`overflow-y: auto` 永不触发
- 传播性问题：只修最内层不够，中间层 `#chat-container` 也有同样的 flex 隐式最小高度
- `flex-shrink: 1`（默认）：`min-height: 0` 允许容器缩小后，flex 子元素被等比压缩。文件消息外层 `padding: 0` + `overflow: hidden`，内容全在内部元素里，压缩后高度为 0

**修复**（`style.css`）：
- `#chat-container` 添加 `min-height: 0`
- `#chat-messages` 添加 `min-height: 0`
- 新增 `#chat-messages > .msg { flex-shrink: 0 }` 阻止消息被压缩

**修复**（`app.js`）：
- `renderMessages` 中 `scrollTop` 改为 `requestAnimationFrame` 回调，确保 flex 重排完成后再滚动
- `renderMessages` 文件消息检测加强：`typeof m.msg_id === 'string'` 类型检查