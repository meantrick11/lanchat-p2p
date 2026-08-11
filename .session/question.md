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

## 10. 离线时收到的消息怎么处理？

**决定**：等待重连后自动发送。消息保留在待发队列，重连成功后依次发送，对方通过 msg_id 去重。

---

## 11. 断连后谁发起重连？

**决定**：A 方自动发起。指数退避重连：1s → 2s → 4s → 8s → 16s → 30s 上限，最多10次。全部失败显示"连接失败，对方可能已下线"。

---

## 12. 文件传输重传起点如何确定？

**决定**：发送方查询接收方的 `/api/transfer/status/{transfer_id}`，接收方返回 `received_chunks` 位图，发送方找出第一个缺失的 chunk 序号，从该位置继续发送。

**三种场景**：
- 网络波动恢复（.progress 存在）→ 从断点继续
- B 重启但 .progress 还在 → 从断点继续
- B 重启 .progress 丢失/24h 过期 → 从 chunk 0 重新开始

---

## 13. 同名文件如何处理？

**决定**：自动改名。保存前检查 `data/downloads/` 是否有同名文件，有则改为 `demo(1).mp4`、`demo(2).mp4`。

---

## 14. 文件传输能否取消？

**决定**：可以。发送方点取消 → 停止发送 → 通过 WS 通知接收方 → 接收方删除 `.part` 和 `.progress` 文件。接收方只有完整接收并校验通过后才显示文件。

---

## 15. 多网卡如何处理？

**决定**：
- FastAPI 绑定 `0.0.0.0`，监听所有网卡接口
- UDP 遍历所有活跃网卡，每张网卡发出的广播包携带**该网卡自己的 IP**（非全局单一 IP），保证接收方拿到的地址在同子网内可达
- Linux 通过 ioctl 获取网卡 IP + 子网掩码；Windows 通过 `ipconfig` 解析（适配中英文系统），必要时 `getaddrinfo` 兜底
- 网卡枚举结果缓存 60 秒
- UDP 监听绑定 `0.0.0.0`，可收到所有网卡回复
- 只支持同子网发现，不跨路由器

---

## 16. 跨子网需要支持吗？

**决定**：基本范围仍是同子网，但增加了**手动 IP 连接 + 自动 HTTP 探活**作为补充。

- **发现**：UDP 广播只覆盖同子网，跨子网需手动输入 IP:端口
- **验证**：跨子网时 UDP peer_list 没有对方记录 → HTTP GET `/api/me` 反向验证 token
- **持久化**：联系人存储 `ws_port`，重启后通过定期 HTTP 探活（每 30 秒）自动发现上线状态
- **续活**：HTTP 探活成功刷新 `last_seen`，防止 UDP 超时机制（16s）误踢跨子网节点
- **限制**：需 TCP 可达，需知道对方 IP:端口，首次仍需手动输入

---

## 17. 技术栈选择

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

## 18. 连接请求如何展示？

**决定**：左侧边栏设置独立区域，在在线用户和历史联系人之间，只在有待处理请求时才出现。橙色 🟠 标识 + 数量徽章。点击 [同意] 自动加入历史联系人 + 打开聊天窗口，点击 [拒绝] 通知对方。所有请求处理完整块隐藏。

**原因**：不弹窗打断当前操作，比弹窗体验好。

---

## 19. 文件重传机制如何设计？

**决定**：A 通过两种方式感知 B 重新上线（UDP 心跳恢复 + 每5秒主动轮询 GET transfer status）。检测到上线后，先查询进度 → 发 file_request（resume:true）→ B 检查 .progress 匹配则直接确认不弹窗 → A 从断点继续发送。

单 chunk 超时10秒，最多重试3次，连续失败3次则暂停整个传输。

**A 重启后**：浏览器端传输队列丢失，需用户手动重新选择文件。B 的 .progress 还在则可从断点续传。

---

## 20. 左侧三个列表如何处理内容溢出？

**决定**：各区域标题栏固定，内容区 `overflow-y: auto` 独立滚动。三个区域之间的分割线固定，不随内容增长。

---

## 21. 其他决策一览

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

## 22. 同机多实例 UUID 如何区分？

**决定**：UUID 格式为 `{base_uuid}_{WS_PORT}`。`base_uuid` 从 `config.json` 读取（同机共享），端口后缀确保多实例唯一。

**原因**：同机多实例共享 `data/config.json`，纯 base_uuid 会导致互把对方当"自己"忽略。端口天然唯一，无需额外配置。

---

## 23. 手动连接 UI 如何设计？

**决定**：在线列表标题栏 `➕` 按钮，点击展开紧凑输入行（IP:端口 + 连接按钮），再次点击收起。

**原因**：手动连接使用频率不高，独立面板浪费空间。toggle 展开保持侧栏整洁。

---

## 24. 如何防止用户连接到自己的实例？

**决定**：前后端双重检查。
- 前端 `connectByIp()`：`ip === myInfo.ip && port === myInfo.ws_port` → 拒绝
- 后端 `ws_chat`：`peer_uuid == MY_UUID` → 返回 `connect_rejected: self_connect`
- 前端渲染层：在线列表、历史联系人、peer_online 回调均过滤 `myInfo.uuid`

---

## 25. 跨子网 Token 验证失败怎么办？

**决定**：UDP peer_list 验证优先 → 失败则 HTTP GET `/api/me` 反向验证 → 仍失败则拒绝连接。

**实现**：`_verify_token_via_api()` 用 `asyncio.to_thread` + `urllib.request`（stdlib，无需新依赖），超时 3 秒。

---

## 26. 联系人存储是否需要端口信息？

**决定**：需要。`contacts.json` 每条记录增加 `ws_port` 字段，默认 50002。

**原因**：跨子网 HTTP 探活需要知道对方监听端口。同子网可通过 UDP 广播获取端口，跨子网必须持久化。

---

## 27. 断开连接如何设计？

**决定**：聊天头部新增「断开」按钮，单方面断开即可，无需对方确认。

**流程**：
- 点击断开 → 关闭本方 outgoing chat WS + 通知后端关闭 incoming chat WS
- 后端关闭对端 WS → 对端 ws_chat finally 发送 `peer_disconnected` → 对端浏览器收到通知
- 双方 UI 同步更新为"在线（未连接）"

**原因**：聊天是双方自愿的，任何一方都有权随时终止。类比挂电话不需要对方同意。

---

## 28. 删除联系人时是否需要断开底层 WS？

**决定**：需要。删除联系人时应先断开 WS 连接再删除数据。

**问题**：之前的 `deleteCurrentContact()` 只删除 `contacts.json` 和内存数据，底层 WS 连接未关闭，导致双方侧边栏仍然显示"已连接"，产生"幽灵连接"。

**修复**：删除前先检查 `activeChats` 和 `connectedPeers`，有则先关闭 WS + 通知后端，清理 `pendingFileTransfers`，再删除联系人数据。

---

## 29. 文件发送回退路径（Path 2）如何处理？

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

## 30. 聊天消息溢出时如何滚动？

**决定**：使用 flex 布局 + `overflow-y: auto` 实现消息区独立滚动。

**问题**：flex 子元素（`#chat-messages` 和 `#chat-container`）的隐式 `min-height: auto` 导致容器随内容撑高，`overflow-y: auto` 永不触发。消息超出窗口时先向上挤压覆盖，发很多条后才"反应"出现滚动条。

**修复**：
- `#chat-container` 和 `#chat-messages` 均设置 `min-height: 0`
- `#chat-messages > .msg` 设置 `flex-shrink: 0`，防止 flex 压缩消息导致文件气泡消失
- JS 中 `scrollTop` 改用 `requestAnimationFrame` 回调，等 flex 重排完成后再滚动到底部
