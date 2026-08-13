# LanChat 设计决策记录

## 1. 发现机制：UDP 单连接 vs 全量发现？

**决定**：全量发现。UDP 广播到 `255.255.255.255`，每个节点周期性发送心跳（每3秒），同时持续监听，每个节点都能发现局域网内所有在线节点。用户在列表中选择一个建立点对点通信。

**原因**：UDP 广播天然是一对全的机制。

---

## 2. 认证方式：是否需要？Token 还是账号密码？

**决定**：UUID + Token 组合认证，只在 WebSocket 连接建立时验证一次。

- UUID：首次启动自动生成（uuid4），持久化到 config.json，后续启动复用，作为长期身份标识
- Token：启动时随机生成，每3秒刷新一次，随 UDP 心跳广播分发。用于证明"你就是 UUID 对应的那个节点"
- Token 不是每条消息都验证——连接建立后信任整个会话

**防什么**：陌生人伪造连接（不知道有效 UUID+Token）、重放过期包（Token 3秒刷新）
**不防**：同网段抓取最新广播包（窗口极小，本项目可接受）

---

## 3. 连接建立：自动接受还是需要对方同意？

**决定**：需要对方 UI 确认。A 发起连接请求 → Token 验证通过 → B 弹窗 [同意]/[拒绝] → 同意后才建立聊天。

**原因**：局域网内用户可能不希望被陌生人连接。

---

## 4. 用户命名：默认昵称？可否重命名？

**决定**：默认取主机名 `socket.gethostname()`，用户可在页面右上角随时修改，保存到 `config.json`。

**同名处理**：允许重名（如两台电脑都叫 DESKTOP-ABC），前端展示 `小明 (DESKTOP-ABC)` 区分。通信靠 UUID，不受影响。

---

## 5. UUID 是否需要持久化？

**决定**：需要。首次启动通过 `uuid4()` 生成并写入 `config.json`，后续启动复用。

**原因**：UUID 是长期身份证。不持久化的话每次重启换新 UUID，其他节点认不出你，历史联系人和聊天记录都对不上号。

---

## 6. Token 验证流程是怎样的？

**决定**：Token 在 WS 连接建立时验证一次，不是每条消息都验证。

```
① A 启动 → 生成 token="k3x9" → 立即发 UDP 广播（不等定时器）
② B 收到广播 → peer_list 记录 {uuid:aaa, token:"k3x9"}
③ A 点连接 B → WS 发送 {uuid:aaa, token:"k3x9"}
④ B 查 peer_list: uuid=aaa 存在？token 匹配？→ 通过
⑤ 此后整个会话不再验证
```

**首次连接没有 token 怎么办**：启动时立即发第一次广播（不等3秒定时器），窗口缩到0秒。极端情况 UDP 丢包，前端等2秒重试。

---

## 7. 端口设计

**决定**：
- UDP 50001（广播 + 监听）
- HTTP/WS 50002（FastAPI 全部服务，绑定 `0.0.0.0`）

**端口冲突**：自动 +1 重试（50002→50003→...），最多10次。

---

## 8. 数据存储位置

**决定**：存放在项目目录 `data/` 下，随项目走。
- `data/config.json` — 本机配置（UUID、昵称）
- `data/contacts.json` — 联系人 + 聊天记录
- `data/downloads/` — 接收的文件 + `.progress` 进度文件
- `data/` 加入 `.gitignore`

---

## 9. 聊天记录是否持久化？

**决定**：持久化。每条消息实时写入 `contacts.json`，`from:"me"` 表示自己发的，`from:"uuid_xxx"` 表示对方发的。下次打开页面加载历史消息。

---

## 10. 文件传输重传起点如何确定？

**决定**：发送方查询接收方的 `/api/transfer/status/{transfer_id}`，接收方返回 `received_chunks` 位图，发送方找出第一个缺失的 chunk 序号，从该位置继续发送。

**三种场景**：
- 网络波动恢复（.progress 存在）→ 从断点继续
- B 重启但 .progress 还在 → 从断点继续
- B 重启 .progress 丢失/24h 过期 → 从 chunk 0 重新开始

---

## 11. 同名文件如何处理？

**决定**：自动改名。保存前检查 `data/downloads/` 是否有同名文件，有则改为 `demo(1).mp4`、`demo(2).mp4`。

---

## 12. 多网卡如何处理？

**决定**：
- FastAPI 绑定 `0.0.0.0`，监听所有网卡接口
- UDP 遍历所有活跃网卡，每张网卡发出的广播包携带**该网卡自己的 IP**（非全局单一 IP），保证接收方拿到的地址在同子网内可达
- Linux 通过 ioctl 获取网卡 IP + 子网掩码；Windows 通过 `ipconfig` 解析（适配中英文系统），必要时 `getaddrinfo` 兜底
- 网卡枚举结果缓存 60 秒
- UDP 监听绑定 `0.0.0.0`，可收到所有网卡回复
- 只支持同子网发现，不跨路由器

---

## 13. 跨子网需要支持吗？

**决定**：基本范围仍是同子网，但增加了**手动 IP 连接 + 自动 HTTP 探活**作为补充。

- **发现**：UDP 广播只覆盖同子网，跨子网需手动输入 IP:端口
- **验证**：跨子网时 UDP peer_list 没有对方记录 → HTTP GET `/api/me` 反向验证 token
- **持久化**：联系人存储 `ws_port`，重启后通过定期 HTTP 探活（每 30 秒）自动发现上线状态
- **续活**：HTTP 探活成功刷新 `last_seen`，防止 UDP 超时机制（16s）误踢跨子网节点
- **限制**：需 TCP 可达，需知道对方 IP:端口，首次仍需手动输入

---

## 14. 技术栈选择

| 层 | 选型 | 原因 |
|----|------|------|
| 后端 | Python 3.13 + FastAPI | 异步、WebSocket 原生支持、轻量 |
| 前端 | 原生 HTML/CSS/JS | 零构建、浏览器即客户端 |
| 发现 | UDP 广播 | 标准局域网发现方案 |
| 聊天 | WebSocket | 双向实时 |
| 传文件 | HTTP + 分片 | 支持断点续传 |
| 存储 | JSON 文件 | 无额外依赖 |
| 包管理 | uv（pyproject.toml） | 项目已有配置 |

---

## 15. 连接请求如何展示？

**决定**：左侧边栏设置独立区域，在在线用户和历史联系人之间，只在有待处理请求时才出现。橙色 🟠 标识 + 数量徽章。点击 [同意] 自动加入历史联系人 + 打开聊天窗口，点击 [拒绝] 通知对方。所有请求处理完整块隐藏。

**原因**：不弹窗打断当前操作，比弹窗体验好。

---

## 16. 文件重传机制如何设计？

**决定**：A 通过两种方式感知 B 重新上线（UDP 心跳恢复 + 每5秒主动轮询 GET transfer status）。检测到上线后，先查询进度 → 发 file_request（resume:true）→ B 检查 .progress 匹配则直接确认不弹窗 → A 从断点继续发送。

单 chunk 超时10秒，最多重试3次，连续失败3次则暂停整个传输。

**A 重启后**：浏览器端传输队列丢失，需用户手动重新选择文件。B 的 .progress 还在则可从断点续传。

---

## 17. 左侧三个列表如何处理内容溢出？

**决定**：各区域标题栏固定，内容区 `overflow-y: auto` 独立滚动。三个区域之间的分割线固定，不随内容增长。

---

## 18. 其他决策一览

| 问题 | 决定 |
|------|------|
| 同时多人聊天 | 支持，每个用户独立 WS，右侧切换显示 |
| 浏览器刷新 | 所有 WS 断开，刷新后需手动重新发起聊天 |
| 程序退出 | 发 goodbye 广播 → 关闭所有 WS → 保存配置 |
| IP 变化 | 定时检测，变化后重新初始化 discovery |
| 双方同时发起连接 | 各自建立一条 WS，合并到同一聊天窗口 |
| 删除联系人 | 点击聊天头部 🗑 按钮删除，同时清除聊天记录和后端存储 |
| 拒绝连接后 | A 显示"对方拒绝了连接"，可再次发起 |
| 表现形式 | WebUI（浏览器打开即用，易演示） |

---

## 19. 同机多实例 UUID 如何区分？

**决定**：UUID 格式为 `{base_uuid}_{WS_PORT}`。`base_uuid` 从 `config.json` 读取（同机共享），端口后缀确保多实例唯一。

**原因**：同机多实例共享 `data/config.json`，纯 base_uuid 会导致互把对方当"自己"忽略。端口天然唯一，无需额外配置。

---

## 20. 手动连接 UI 如何设计？

**决定**：在线列表标题栏 `➕` 按钮，点击展开紧凑输入行（IP:端口 + 连接按钮），再次点击收起。

**原因**：手动连接使用频率不高，独立面板浪费空间。toggle 展开保持侧栏整洁。

---

## 21. 如何防止用户连接到自己的实例？

**决定**：前后端双重检查。
- 前端 `connectByIp()`：`ip === myInfo.ip && port === myInfo.ws_port` → 拒绝
- 后端 `ws_chat`：`peer_uuid == MY_UUID` → 返回 `connect_rejected: self_connect`
- 前端渲染层：在线列表、历史联系人、peer_online 回调均过滤 `myInfo.uuid`

---

## 22. 跨子网 Token 验证失败怎么办？

**决定**：UDP peer_list 验证优先 → 失败则 HTTP GET `/api/me` 反向验证 → 仍失败则拒绝连接。

**实现**：`_verify_token_via_api()` 用 `asyncio.to_thread` + `urllib.request`（stdlib，无需新依赖），超时 3 秒。

---

## 23. 联系人存储是否需要端口信息？

**决定**：需要。`contacts.json` 每条记录增加 `ws_port` 字段，默认 50002。

**原因**：跨子网 HTTP 探活需要知道对方监听端口。同子网可通过 UDP 广播获取端口，跨子网必须持久化。

---

## 24. 断开连接如何设计？

**决定**：聊天头部新增「断开」按钮，单方面断开即可，无需对方确认。

**流程**：
- 点击断开 → 关闭本方 outgoing chat WS + 通知后端关闭 incoming chat WS
- 后端关闭对端 WS → 对端 ws_chat finally 发送 `peer_disconnected` → 对端浏览器收到通知
- 双方 UI 同步更新为"在线（未连接）"

**原因**：聊天是双方自愿的，任何一方都有权随时终止。类比挂电话不需要对方同意。

---

## 25. 删除联系人时是否需要断开底层 WS？

**决定**：需要。删除联系人时应先断开 WS 连接再删除数据。

**问题**：之前的 `deleteCurrentContact()` 只删除 `contacts.json` 和内存数据，底层 WS 连接未关闭，导致双方侧边栏仍然显示"已连接"，产生"幽灵连接"。

**修复**：删除前先检查 `activeChats` 和 `connectedPeers`，有则先关闭 WS + 通知后端，清理 `pendingFileTransfers`，再删除联系人数据。

---

## 26. 文件发送回退路径（Path 2）如何处理？

**决定**：当发送方没有直接 chat WS 时（被动接收方发文件），通过**后端 HTTP relay** 替代原来的 chat WS 直发。

**问题**：原来的 Path 2（control WS → 后端 → chat WS → 对端前端）有两个缺陷：
1. 对端前端的 `setupPeerMessageHandler` 没有处理 `file_request` 类型 → 消息被静默丢弃
2. 对端接受后，`_handle_file_response` 中 `active_chats.get(sender_uuid)` 为 None → 响应无法传回

**修复**：
- 新增 `POST /api/transfer/request` 端点：接收其他后端的文件传输 relay，创建 transfer + 通知自己浏览器
- `_handle_file_request_from_browser`：优先 HTTP POST 到对端后端，失败则回退到 chat WS 直发
- `_handle_file_response`：`peer_ws` 为空时，通过 `forward_file_response` 通知浏览器经 chat WS 转发
- 前端 `handleForwardFileResponse()`：收到转发指令后通过本方 chat WS 发送 `file_response`
- 前端 `setupPeerMessageHandler`：新增 `file_request` 处理作为 HTTP relay 失败的 fallback
- 后端新增 `register_transfer` 控制消息：前端收到 chat WS file_request 后注册 transfer

---

## 27. 聊天消息溢出时如何滚动？

**决定**：使用 flex 布局 + `overflow-y: auto` 实现消息区独立滚动。

**问题**：flex 子元素（`#chat-messages` 和 `#chat-container`）的隐式 `min-height: auto` 导致容器随内容撑高，`overflow-y: auto` 永不触发。消息超出窗口时先向上挤压覆盖，发很多条后才"反应"出现滚动条。

**修复**：
- `#chat-container` 和 `#chat-messages` 均设置 `min-height: 0`
- `#chat-messages > .msg` 设置 `flex-shrink: 0`，防止 flex 压缩消息导致文件气泡消失
- JS 中 `scrollTop` 改用 `requestAnimationFrame` 回调，等 flex 重排完成后再滚动到底部

---

## 28. 文件重传时如何避免重复弹窗确认？

**决定**：发送方发起重传时携带 `resume: true`，接收方后端检测到 `.progress` 文件存在且 `resume` 为 true → 自动接受，不弹窗。

**问题**：初版重传有 5 个缺陷：
1. HTTP POST 请求体没有传 `resume` 字段 → 接收方无法判断是首次请求还是续传
2. `_relay_from_peer` 全量覆盖 `transfers[transfer_id]` 导致已接收的 `received_chunks` 丢失
3. `handleConnectionEstablished` 覆盖联系人时 `messages: []` 擦除了历史
4. 接受时重复 push 文件消息 → 聊天区出现两条同内容的气泡
5. retry 无连接时静默失败 → transfer 数据被误删

**修复**：5 处逐一修复（详见 process.md §22），确保重传链路完整。

---

## 29. 为什么所有 WebSocket onclose 回调都要中止文件上传？

**决定**：`abortTransfersForPeer()` 必须在每个 chat WS 的 `onclose` 回调中调用，而不仅限于 `disconnectCurrentChat()` 和 `handlePeerDisconnected()`。

**原因**：
- `disconnectCurrentChat()`：只在**主动方点击"断开"按钮**时触发，覆盖发送方主动断开场景
- `handlePeerDisconnected()`：只在**后端通过 control WS 通知**时触发，覆盖接收方的 incoming WS 被后端关闭场景
- `ws.onclose`：chat WS **以任何方式关闭**都会触发（网络闪断、浏览器关标签页、对方后端重启等），是最兜底的路径

项目中 4 处 `onclose`（`connectToPeer`、`autoReconnect`、`connectByIp`×2）原来都没有调用 abort，导致接收方断开连接后发送方 HTTP POST 上传继续跑而不自停。修复后在每个 onclose 中统一调用 `abortTransfersForPeer(uuid)`。

---

## 30. 断开连接时检查哪些文件传输？

**决定**：断开连接的文件传输警告应同时检查**发送中的**（`pendingFileTransfers`）和**接收中的**（`contact.messages` 中 `from !== 'me'` 且状态为 `downloading`/`waiting` 的文件消息）。

**原因**：`pendingFileTransfers` 只记录本端作为发送方的上传任务。当用户是接收方时，该 Map 中没有对应条目，原有检查无效——接收方断开时不会看到任何文件传输警告。

**修复**：`disconnectCurrentChat()` 改为两步检查——先查 `pendingFileTransfers`（发送中），再查 `contact.messages`（接收中），任一命中即弹出警告确认框。

---

## 31. 已在线节点改名/IP 变化为什么对方不更新？

**决定**：UDP 心跳的 `on_peer_online` 回调应在 name 或 ip 变化时也触发，而不仅限于 `is_new` 或 `was_offline`。

**问题**：`discovery._handle_message()` 只在"第一次见到 UUID"或"从离线恢复"时触发回调。已在线且一直在线时，即使心跳中的 name/ip 已变化，回调也不触发。这导致：
- `_notify_peer_online()` 不执行 → `contacts.json` 不更新
- 前端收不到 `peer_online` → UI 永远显示旧数据
- 刷新页面也无效（`contacts.json` 未更新）

**修复**（`discovery.py`）：
```python
name_changed = msg.get("name") != prev_data.get("name")
ip_changed = msg.get("ip") != prev_data.get("ip")
updated = name_changed or ip_changed
if self.on_peer_online and (is_new or was_offline or updated):
    self.on_peer_online(self._peers[uuid].copy())
```

**同时**（`app.js`）：`handlePeerOnline()` 原来只更新 `contacts.status`，现同步更新 `name` 和 `ip`。

---

## 32. UDP 发现的所有人都该写入历史联系人吗？

**决定**：不应该。UDP 发现仅用于更新**已存联系人**的在线状态和 name/IP，不应把陌生节点写入 `contacts.json`。

**原因**：历史联系人 = 真正建立过联系的人（聊天过、连接过）。局域网内可能有很多设备广播 UDP，但大多数与你无关。如果每个广播都写入历史联系人，列表会越来越臃肿，且"小林现象"（从未连接过的人也出现在历史联系人中）不符合用户预期。

**修复**（`main.py`）：`_notify_peer_online()` 中 `upsert_contact()` 改为先 `get_contact()` 检查存在性，不存在则跳过写入：
```python
if get_contact(peer["uuid"]):
    upsert_contact(...)
```

**分层逻辑**：
- **在线用户面板**：UDP 发现的所有节点，实时显示
- **历史联系人列表**：`contacts.json` 中已存的节点 + 建立连接时写入的新节点
- **UDP 发现**：不创建新联系人，只更新已存联系人的 name/ip/状态

---

## 33. 如何判断是否有活跃的文件传输？

**决定**：双维度检查 + 过滤 stale state。

**维度 1 — 发送方**：检查 `pendingFileTransfers`，但需排除 `t.aborted === true` 的条目。中断传输时设置 `aborted = true` 但保留条目供续传，由此产生的"僵尸条目"不应误报。

**维度 2 — 接收方**：检查 `contact.messages` 中 `from !== 'me'` 且 `status` 为 `'downloading'` 或 `'waiting'` 的文件消息。传输中断时 `abortTransfersForPeer` 会将这类消息标记为 `'failed'`，防止下次断开时误报。

**状态清理**：`abortTransfersForPeer` 负责两件事——中止发送（`t.aborted = true`）+ 标记接收（`status → 'failed'`）。所有断开路径（disconnectCurrentChat、onclose、handlePeerDisconnected）统一走此函数。

---

## 34. 路径穿越如何防御？

**决定**：两层纵深防御。

**第一层 — 入口净化**：`api_transfer_request`、`_relay_from_peer`、`_handle_file_request_from_browser` 三处用 `Path(file_name).name` 只取文件名，丢弃所有目录成分。`../../../Windows/evil.exe` → `evil.exe`。

**第二层 — 核心防线**：`get_download_path()` 对最终路径做 `.resolve()` 后检查是否在 `DOWNLOADS_DIR.resolve()` 内。即使用 `.resolve()` 消除 `..` 后路径逃逸也会被 `startswith` 检查拦截。

**原因**：`Path / "../"` 不会自动消除 `..`，必须显式 `.resolve()`。与已有的 `download_file` 端点防护一致。

---

## 35. 文件传输 HTTP API 为什么要加 Token 验证？

**决定**：`POST /api/transfer/request`、`/api/transfer/chunk`、`/api/transfer/complete` 三个端点均加 token 验证，模式与 `ws_chat` 一致。

**原因**：这三个端点是 P2P 架构的后端-后端/browser-后端 relay 接口，但设计时漏掉了身份验证。内网任何人都可以无认证调用：
- `/api/transfer/request` → 刷屏弹窗（每次触发 `incoming_file_request` 通知）
- `/api/transfer/chunk` + `/api/transfer/complete` → 写垃圾数据、提前完成传输

**验证流程**：`discovery.verify_token(uuid, token)` 优先 → 失败则 `_verify_token_via_api` HTTP 反向验证 → 仍失败返回 403。

---

## 36. 三个 CRITICAL Bug 的原因和影响

**CRITICAL #3 — contacts.json 读写竞态**：`upsert_contact` 和 `delete_contact` 在 load 和 save 之间释放了锁，并发写入导致数据丢失。修复：锁覆盖整个读→改→写周期。

**CRITICAL #4 — 文件消息写入错误联系人**：`handleTransferComplete`/`handleTransferCancelled` 使用 `currentChat`（当前显示窗口）而非文件消息实际所属联系人的 UUID。如果你在看 Alice 的聊天，Bob 的文件传完了，Bob 的文件消息会被写进 Alice 的数据。修复：`findFileMsgByTransferId` 返回 `{msg, peerUuid}`，调用方精确使用。

**CRITICAL #5 — 接受连接后联系人未落盘**：`respondConnection` 只存内存 Map，不发 `save_contact`。刷新/重启后联系人消失。修复：追加 `save_contact` control WS 消息。

---

## 37. WS 连接超时策略

**决定**：
- **连接请求超时**：1 分钟。用户不操作则自动拒绝，释放协程和 `pending_connections` 条目。
- **空闲连接超时**：10 分钟无消息且无活跃文件传输则关闭连接。文件传输进行中（`transfers` 中有 `status=="receiving"` 且 `from_uuid` 匹配）时跳过超时检查。

**原因**：`confirmed_event.wait()` 和 `ws.receive_json()` 均无超时，协程永久阻塞，内存泄漏。

**实现**：`asyncio.wait_for()` 包装，超时后分别通知双方浏览器清理状态。`idle_closed` 标志位防止 `finally` 块重复发 `peer_disconnected`。

---

## 38. readAsBase64 为什么不 reject？

**决定**：Promise 加 `reject` 回调 + `reader.onerror` 处理。调用方 `startChunkUpload` 加 try/catch 兜底。

**原因**：原代码 `new Promise((resolve) => ...)` 只有 resolve，没有 reject。`FileReader` 读盘失败（权限变更、文件被删、磁盘错误）时 Promise 永不 settle，上传循环在 `await readAsBase64(blob)` 处永久挂起。

---

## 39. 未连接时发送消息/文件应如何处理？

**决定**：输入框和按钮始终可用（不 disabled），在发送/选文件/重传的入口处检查连接状态，未通过则弹居中提示。

**原因**：disabled 控件让用户不知道"为什么不能发"和"该怎么办"。允许用户先输入内容、选文件，点击发送时才阻断并提示，告知明确的下一步操作。

**实现**：新增 `showCenterToast()` — 白底黑字 + 阴影，屏幕正中央弹出（`scale 0.88→1`）后渐隐，1.75s 自动消失。

**提示文案策略**：
- 离线 → "对方当前不在线，等待对方上线后才能聊天嗷~"
- 在线未连接 → "连接按钮都懒得点，那就别想和我聊天~"
- 重传分支使用同风格但区分场景的文案

---

## 40. 单方面删除联系人后重连，如何判断是否需要重新验证？

**决定**：信任判定由**双方历史共同决定**，不再由接收方单边 `trusted` 字段决定。发起方在 `connect_request` 中携带 `have_you`（自己历史里是否还保留着对方），接收方拿它和自己的 `existing_contact`（自己历史里是否还保留着发起方）做 AND 运算：两者都为 True → 自动接受；任一为 False（有一方删除过对方）→ 走用户确认流程。

**真值表**：

| 场景 | 发起方 have_you | 接收方 existing_contact | 结果 |
|------|------|------|------|
| 双方都没删（正常重连） | T | T | 自动接受 |
| A 删了 B（连接中/未连接一样） | F | T | 验证 |
| B 删了 A | T | F | 验证 |
| 双方都删了 / 首次连接 | F | F | 验证 |

**"第一次连接"如何判断**：第一次连接 = 双方历史里都不存在对方，AND 自然为 False → 走验证，无需任何额外标记。

**原因**：原 `trusted` 字段非对称——只反映"接收方还信不信发起方"，且 A 删除 B 时若不在连接状态，B 永远收不到 `contact_untrusted`，B 的 `trusted[A]` 仍是 True，下次连接被自动接受，违背"单方面删除后再次连接必须验证"的要求。此前 v32 用"墓碑 + deleted_you"补这个洞，因墓碑与"删除时是否连接"耦合而失效，已回退。

**实现**：
- `storage.py`：`delete_contact` 改回完整删除（`del`）；移除 `get_deleted_uuids`；新增 `remove_deleted_tombstones()` 启动时清理 v32 遗留墓碑
- `main.py`：`ws_chat` 判定改为 `if existing_contact and peer_has_me`；`/api/me` 移除 `deleted_uuids`
- `app.js`：`connectToPeer`/`autoReconnect`/`connectByIp` 发送 `have_you`；`connectToPeer` 在 `openChat` **之前**取 `contacts.has(uuid)`（openChat 会把刚删的联系人从后端重新加回 Map，之后取会误判为 True）
