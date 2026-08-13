# LanChat — 局域网 P2P 通讯工具 架构设计

## 一、项目目标

实现局域网内 P2P 通讯工具：**发现好友 → 文字聊天 → 文件传输**。

- **加分项**：文件分片上传、断点续传
- **技术栈**：Python 3 + FastAPI + 原生 HTML/CSS/JS
- **表现形式**：WebUI（浏览器打开即用）

---

## 二、技术选型

| 层 | 选型 | 原因 |
|----|------|------|
| 后端 | Python 3 + FastAPI | 异步、WebSocket 原生支持、轻量 |
| 前端 | 原生 HTML/CSS/JS | 零构建、浏览器即客户端 |
| 发现 | UDP 广播 | 标准局域网发现方案 |
| 聊天 | WebSocket | 双向实时通信 |
| 传文件 | HTTP + 分片 | 支持断点续传 |
| 存储 | JSON 文件 | 联系人持久化，无额外依赖 |
| 加密(加分) | ECDH + AES-256-GCM + TLS | 密钥交换 + 应用层加密 + 传输层加密 |

---

## 三、项目结构

```
internproject/
├── main.py            # FastAPI 主入口，路由注册，启动
├── discovery.py       # UDP 广播 + 监听线程，节点发现
├── storage.py         # 联系人 + 配置的 JSON 读写
├── static/            # 前端文件
│   ├── index.html     # 前端页面
│   ├── style.css      # 样式
│   └── app.js         # 前端逻辑
├── data/              # 运行时生成（git忽略）
│   ├── config.json    # 用户配置（uuid, 昵称）
│   ├── contacts.json  # 历史联系人 + 聊天记录
│   └── downloads/     # 接收的文件 + .progress 进度文件
├── pyproject.toml     # uv 项目配置 + 依赖声明
└── .session/          # AI 对话记录（交付物）
    └── architecture.md
```

---

## 四、前端页面布局

```
┌──────────────────────────────────────────────────────────┐
│  🔗 LanChat                    我: 小明                  │
│                                IP: 192.168.1.100         │
│                                网段: 192.168.1.0/24      │
├──────────────┬───────────────────────────────────────────┤
│  在线用户 3   │                                           │
│  [🔍扫描]    │                                           │
│ ┌──────────┐ │         与 小红 的聊天内容                  │
│ │🟢 小红   │ │                                           │
│ │🟢 小刚   │ │   小明: 你好！                             │
│ │🟢 小李   │ │   小红: 你好呀~                            │
│ │          │ │                                           │
│ └──────────┘ │                                           │
│──────────────│                                           │
│  连接请求 2   │ ← 有待处理请求时才出现，橙色 🟠 标识        │
│ ┌──────────┐ │                                           │
│ │🟠 张三   │ │                                           │
│ │ [同意][拒]│ │                                           │
│ │🟠 李四   │ │                                           │
│ │          │ │                                           │
│ └──────────┘ │                                           │
│──────────────│                                           │
│  历史联系人 5 │                                           │
│ ┌──────────┐ │                                           │
│ │🟢 小红   │ │                                           │
│ │🔴 老张   │ │                                           │
│ │🔴 赵六   │ │                                           │
│ │          │ │                                           │
│ └──────────┘ │                                           │
├──────────────┴───────────────────────────────────────────┤
│  💬 输入消息...                    [📎发文件]    [发送]   │
└──────────────────────────────────────────────────────────┘
```

五个区域：
- **右上角**：当前用户信息（用户名 + 本机IP + 网段），和 LanChat 标题平级
- **左上**：当前网段活跃用户列表（标题含数量角标，内容区独立滚动）
- **左中**：待处理连接请求列表（含数量角标，空时整块隐藏，内容区独立滚动）
- **左下**：历史联系人列表（标题含数量角标，离线保留标记🔴，内容区独立滚动）
- **右侧**：当前选中用户的聊天主区域 + 底部输入栏

连接请求交互：
- 收到请求 → 区域出现 + 🟠 标识 + 数字徽章
- 点 [同意] → 自动加入历史联系人 + 打开聊天窗口 + 该行消失
- 点 [拒绝] → 该行消失 + 通知对方
- 所有请求处理完 → 整块区域隐藏

---

## 五、两套列表的区别

| | 在线用户列表（发现列表） | 历史联系人列表 |
|---|---|---|
| **数据来源** | UDP 广播实时收集 | JSON 文件持久化 |
| **生命周期** | 超时自动移除 | 永久保留，除非手动删除 |
| **离线行为** | 消失 | 保留但标记 🔴已下线 |
| **作用** | 发现新朋友 | 找回老朋友、查看聊天记录 |

逻辑：
- 在线列表里点击某人 → 建立 WS 连接 → 自动加入历史联系人
- 历史联系人重新上线 → 自动变绿 🟢
- 历史联系人不在线 → 灰显 + "该用户当前已下线" 🔴

---

## 六、后端 API 端点

| 端点 | 方法 | 作用 |
|------|------|------|
| `/` | GET | 返回前端页面 |
| `/api/me` | GET | 本机信息（uuid、昵称、IP、网段、ws_port、token、deleted_uuids） |
| `/api/peers` | GET | 当前在线用户列表 |
| `/api/contacts` | GET | 历史联系人列表（合并在线状态） |
| `/api/messages/{uuid}` | GET | 指定联系人的聊天记录 |
| `/api/config` | POST | 修改昵称 |
| `/api/contacts/{uuid}` | DELETE | 删除联系人（墓碑机制） |
| `/api/pending` | GET | 待处理的连接请求列表 |
| `/ws/control` | WS | **自己浏览器 ↔ 自己后端** 的控制通道 |
| `/ws/chat` | WS | **其他用户浏览器 ↔ 自己后端** 的聊天通道 |
| `/api/transfer/request` | POST | 文件传输请求（后端间 relay，回退路径） |
| `/api/transfer/chunk` | POST | 接收文件分片 |
| `/api/transfer/complete` | POST | 文件传输完成确认 |
| `/api/transfer/status/{id}` | GET | 查询传输进度（断点续传用） |
| `/api/downloads/{file_name}` | GET | 下载/打开已接收文件（带路径穿越防护） |

---

## 七、核心流程

### 7.1 节点发现（后台持续运行）

```
每个节点启动后:

  发送线程(每3秒) ──→ UDP广播到 255.255.255.255:50001
  包内容: {uuid, name, ip, ws_port, token, timestamp}

  接收线程(持续) ←── 收到其他节点的广播
    ├─ 新uuid → 加入在线列表 → 通知前端
    ├─ 已知uuid → 刷新 last_seen
    ├─ 收到 goodbye → 立即标记离线
    └─ 超时10秒(连续3次未收到) → 标记离线 → 通知前端
```

### 7.2 用户名与 UUID

- **用户名（昵称）**：默认取主机名 `socket.gethostname()`，用户可在页面右上角随时修改，保存到 `config.json`
- **UUID**：首次启动时通过 `uuid4()` 自动生成并持久化到 `config.json`，格式为 `{base_uuid}_{WS_PORT}`，端口后缀确保同机多实例 UUID 唯一
- **UUID 复用原因**：让其他节点重启后仍能认出你是同一个人，避免历史联系人、聊天记录对不上号
- 用户名可重名（如两台电脑都叫 DESKTOP-ABC），UUID 全局唯一，因此 UUID 用于后端身份识别，用户名仅用于前端展示

### 7.3 Token 认证机制

- **Token**：程序启动时随机生成，之后每 3 秒自动刷新一次，不间断地随 UDP 心跳广播给同网段所有节点
- **Token 只在 WebSocket 连接建立时验证一次**，验证通过后的整个会话期间不再重复验证
- Token 不是每条消息都验证，也不是根据 UUID 计算出来的——Token 是纯随机字符串，与 UUID 无关
- **UUID 回答"我是谁"**（在 peer_list 中找到你）+ **Token 回答"怎么证明"**（核对是否匹配），两者缺一不可

```
每个节点启动后:
  ① 立即发送第一次 UDP 广播（不等定时器，减少首次连接窗口）
  ② 然后启动定时器，之后每 3 秒刷新 token + 广播一次

A 连接 B 时:
  A 出示 {uuid:A, token:A的当前token}
  B 在 peer_list 中查 A 的uuid
  ├─ 找不到 → 拒绝（uuid_not_found，可能是A刚启动广播还没到，前端等待2秒重试）
  ├─ 找到但 token 不匹配 → 拒绝（invalid_token，冒充或过期）
  └─ 找到且 token 匹配（允许当前或上一周期 token）→ 通过
```

**防什么**：
- ✅ 陌生人伪造连接（不知道有效 UUID + 当前 token）
- ✅ 重放过期包（token 每3秒换一次，最多容忍 6 秒窗口）

**不防**：
- △ 同网段抓到最新广播包（窗口极小，本项目可接受）

### 7.4 建立聊天连接（需对方同意）

```
用户A 点击 用户B 的 "聊天"
        │
        ▼
A的浏览器: new WebSocket("ws://B_IP:50002/ws/chat")
        │
        ├── 发送连接请求:
        │    {"type":"connect_request", "uuid":"A的uuid", "name":"A的昵称", "token":"A的token"}
        │
        ▼
B的FastAPI收到:
  ├─ 在peer_list中查找A的uuid → 找到 ✓
  ├─ 比对token → 匹配 ✓
  ├─ 暂不标记为已连接，等待B用户确认
  └─ 通过 /ws/control 通知B的浏览器:
       {"type":"incoming_connection", "from_uuid":"A的uuid", "from_name":"A的昵称"}
        │
        ▼
B的UI弹窗: "小明 请求与你建立连接"
           [同意]  [拒绝]
        │
   ┌────┴────┐
   ▼         ▼
 同意       拒绝
   │         │
   │         └─→ B后端回复A: {"type":"connect_rejected"}
   │              B后端关闭WS连接
   │              A浏览器: "对方拒绝了你的连接请求"
   │
   └─→ B后端回复A: {"type":"connect_accepted"}
       B后端标记该连接为 active_chats
       B浏览器: 自动将小明加入历史联系人
       双方可以开始聊天
```

> 注：以上为「新联系人」首次连接流程（需用户确认）。若 B 的历史联系人中已有 A 且
> `trusted=true`、A 未带 `deleted_you`，则跳过确认直接 `connect_accepted`（自动重连）；
> 不可信/墓碑联系人则强制回到确认流程（详见 9.9）。

### 7.5 消息收发路径

```
一条连接只有一条 chat WS，由主动发起方建立（A浏览器 ↔ B后端）：

A 发消息给 B（主动方直连）:
  A浏览器 ──chat WS──→ B后端 ──control WS──→ B浏览器

B 发消息给 A（被动方经自己后端，复用同一条 chat WS 回传）:
  B浏览器 ──control WS──→ B后端 ──chat WS(复用A建立的)──→ A浏览器

浏览器持有的 WS 因角色而异：
  · 主动发起方：① 连自己后端 /ws/control（收通知）② 连对方后端 /ws/chat（发消息）
  · 被动接收方：仅 ① 连自己后端 /ws/control；发消息时由自己后端复用对方建立的 chat WS 回传

前端发送时按「是否有出站 chat WS」分流：
  · 有 chat WS（主动方）→ 直接经 chat WS 发送
  · 无 chat WS（被动方）→ 经 control WS 发 chat_message，自己后端转发

消息持久化「双保险」：
  后端 _relay_from_peer 收到消息先落盘；前端收到后再补发 save_message
  （覆盖直连绕过本后端的情况），由 storage.append_message 按 msg_id 去重，重复调用安全。

连接成功后，A自动加入B的历史联系人，B也自动加入A的历史联系人。
```

**消息可靠性**：
- 每条消息带唯一 `msg_id`
- 接收方返回 ACK
- 发送方5秒未收到ACK → 重发（最多2次）→ 仍失败则标记 ⚠发送失败
- 接收方维护最近100条消息ID做去重

### 7.6 文件传输流程

```
A 发文件给 B:

  ① A选择文件 → 生成transfer_id

  ② A浏览器通过聊天WS发:
     {type:"file_request", file_name, file_size, chunk_size, total_chunks, transfer_id}

  ③ B后端收到 → 通过control WS通知B浏览器 → B弹窗 [接收] [拒绝]

  ④ B点击接收 → response通过control WS发回后端 →
     B后端通过聊天WS转发给A浏览器: {type:"file_response", accepted:true}

  ⑤ A浏览器分片上传 (每片64KB):
     POST http://B_IP:50002/api/transfer/chunk
     {transfer_id, chunk_index, data(base64)}

  ⑥ B后端逐片写入 downloads/文件名.part，更新 .progress

  ⑦ 全部发送完 → POST /api/transfer/complete → B后端校验
     → 重命名为正式文件名 → 通知B浏览器 "接收完成 ✓"
```

### 7.7 文件重传与断点续传

#### 中断检测与等待恢复

```
正常发送中，chunk N 连续3次失败（超时/连接拒绝）:
  
  ① 标记传输 paused
     A UI: 进度条暂停，"传输中断，等待对方重新上线"
     B .progress 文件保留已收到的 chunk 数据
  
  ② A 等待 B 重新上线，两种方式:
     ├─ UDP 心跳恢复 → peer_list 中 B 变 🟢 → 触发重传检查
     └─ A 每 5 秒主动 GET /api/transfer/status/t_xxx 探测
         之前连不上 → 现在请求成功 → B 已上线
  
  ③ .progress 过期清理（24小时）
     超过 24 小时未完成 → .progress 自动删除
     → A 轮询 GET /api/transfer/status → 返回 status:"not_found"
     → A 重新发起 file_request（resume:false），从头开始传
```

#### 续传恢复

```
③ A 检测到 B 在线 → 发起续传:
  
  Step 1: 查询进度
    GET /api/transfer/status/t_xxx
    B 返回: {received_chunks:[0..51], received_bytes:3407872, status:"in_progress"}
  
  Step 2: 通过聊天 WS 发 file_request（标记 resume）:
    {"type":"file_request", "transfer_id":"t_xxx", "resume":true,
     "file_name":"demo.mp4", "file_size":104857600, "total_chunks":1600,
     "missing_from":52}
  
  Step 3: B 收到，检查:
    ├─ transfer_id 存在 + .progress 匹配 → 直接确认（不需要弹窗，之前已同意）
    └─ .progress 丢失/不匹配 → 弹窗询问用户是否接收
  
  Step 4: A 从 chunk 52 继续发送
    B 的 .part 文件追加写入，已有数据不丢失
```

#### 重传起点计算

```
起点 = 第一个缺失的 chunk 序号

接收方 .progress:
  {"received_chunks": [0,1,...,51], "total_chunks": 1600}

遍历 0..1599 → 不在 received_chunks 中的最小序号 → 52
文件偏移 = 52 × 65536 = 3,407,872 byte
```

#### 单 chunk 重试

```
每个 chunk:
  ① POST 发送 → 等 ACK，10秒超时
  ② 失败 → 重试（最多3次）
  ③ 3次都失败 → consecutive_failures++
  ④ consecutive_failures ≥ 3 → 暂停整个传输
```

#### .progress 文件格式

```json
{
  "file_name": "demo.mp4",
  "file_size": 104857600,
  "chunk_size": 65536,
  "received_chunks": [0, 1, 2, ..., 50],
  "received_bytes": 3342336,
  "total_chunks": 1600,
  "from_uuid": "a1b2c3...",
  "status": "in_progress",
  "created_at": "2026-08-10T14:30:00",
  "last_update": "2026-08-10T14:35:23"
}
```

#### A 重启后的处理

```
A 重启 → 浏览器端传输队列丢失 → 无法自动续传
→ 需要用户重新选择文件发送（手动重新发起）
→ 此时 B 的 .progress 还在 → 新请求 resume:true → 从断点续传
```

### 7.8 连接断开与重连

| 场景 | 触发 | 前端行为 | 恢复 |
|------|------|----------|------|
| B离线(UDP超时) | 10秒未收到心跳 | 历史联系人变🔴 | B上线自动🟢 |
| WS意外断开 | onclose事件 | 指数退避重连 1s→2s→...→30s | 成功恢复聊天 |
| 重连超限(10次) | 超最大重试 | 提示"连接失败" | 用户手动重连 |
| 文件传输中断 | HTTP超时 | 进度暂停 | 重连后续传 |
| 主动退出 | 关闭程序 | goodbye广播 | 对方立即移除 |

---

## 八、消息协议汇总

```python
# ===== UDP 心跳 =====
{"type":"hello", "uuid":"a1b2c3...", "name":"小明", "ip":"192.168.1.100",
 "ws_port":50002, "token":"abc123...", "timestamp":1691670000.0}
{"type":"goodbye", "uuid":"a1b2c3..."}   # 正常退出时广播，立即标记离线

# ===== WebSocket 连接建立（chat WS）=====
请求:  {"type":"connect_request", "uuid":"...", "name":"...", "token":"...",
       "ip":"...", "ws_port":50002, "deleted_you":false}
同意:  {"type":"connect_accepted", "uuid":"...", "name":"...", "ip":"...", "ws_port":50002}
拒绝:  {"type":"connect_rejected", "reason":"invalid_token|self_connect|timeout"}

# ===== WebSocket 聊天（chat WS，双向）=====
发送:  {"type":"chat", "msg_id":"m001", "content":"你好"}
转发:  {"type":"chat", "msg_id":"m001", "from":"...", "from_name":"...",
       "content":"...", "timestamp":"..."}
确认:  {"type":"ack", "msg_id":"m001"}

# ===== WebSocket 文件信令（chat WS，双向）=====
请求:  {"type":"file_request", "file_name":"...", "file_size":...,
       "chunk_size":65536, "total_chunks":..., "transfer_id":"...", "resume":false}
响应:  {"type":"file_response", "transfer_id":"...", "accepted":true}
取消:  {"type":"file_cancel", "transfer_id":"..."}

# ===== Control WS：浏览器 → 后端 =====
改昵称:     {"type":"update_name", "name":"..."}
连接响应:   {"type":"connection_response", "to_uuid":"...", "accepted":true}
文件响应:   {"type":"file_response", "transfer_id":"...", "accepted":true}
取消传输:   {"type":"file_cancel", "transfer_id":"..."}
主动断开:   {"type":"disconnect", "to_uuid":"..."}
注册传输:   {"type":"register_transfer", "transfer_id":"...", "file_name":"...", ...}
中转聊天:   {"type":"chat_message", "to_uuid":"...", "msg_id":"...", "content":"..."}
文件请求回退: {"type":"file_request", "to_uuid":"...", "transfer_id":"...", ...}
保存消息:   {"type":"save_message", "peer_uuid":"...", "sender":"me|uuid",
            "content":"...", "msg_id":"...", "msg_type":"chat|file", ...}
保存联系人: {"type":"save_contact", "uuid":"...", "name":"...", "ip":"...", "ws_port":50002}
标记不可信: {"type":"mark_untrusted", "uuid":"..."}
删除联系人: {"type":"delete_contact", "uuid":"..."}

# ===== Control WS：后端 → 浏览器 =====
初始化:     {"type":"init", "uuid":"...", "name":"...", "ip":"...", "network":"...",
            "ws_port":50002, "token":"...", "contacts":[...], "online_peers":[...],
            "active_peers":[...]}
节点上线:   {"type":"peer_online", "uuid":"...", "name":"...", "ip":"...",
            "ws_port":50002, "token":"..."}
节点下线:   {"type":"peer_offline", "uuid":"...", "name":"..."}
新连接请求: {"type":"incoming_connection", "uuid":"...", "name":"...", "ip":"...", "ws_port":50002}
待处理数量: {"type":"pending_update", "count":2}
连接已建立: {"type":"connection_established", "uuid":"...", "name":"...", "ip":"..."}
连接断开:   {"type":"peer_disconnected", "uuid":"...", "name":"..."}
主动断开确认: {"type":"disconnected", "uuid":"..."}
联系人已删: {"type":"contact_deleted", "uuid":"..."}
被标记不可信: {"type":"contact_untrusted", "uuid":"..."}
连接超时:   {"type":"connection_timeout", "uuid":"...", "name":"..."}
空闲关闭:   {"type":"connection_idle_close", "uuid":"...", "name":"..."}
收到聊天:   {"type":"chat_message", "from":"...", "from_name":"...", "msg_id":"...",
            "content":"...", "timestamp":"..."}
消息确认:   {"type":"message_ack", "msg_id":"..."}
发送失败:   {"type":"send_failed", "msg_id":"...", "reason":"not_connected|send_error"}
文件请求:   {"type":"incoming_file_request", "transfer_id":"...", "file_name":"...",
            "file_size":..., "from_uuid":"...", "from_name":"...", "resume":false}
文件响应:   {"type":"file_request_response", "transfer_id":"...", "accepted":true}
转发文件响应: {"type":"forward_file_response", "transfer_id":"...", "accepted":true, "to_uuid":"..."}
传输进度:   {"type":"transfer_progress", "transfer_id":"...", "file_name":"...",
            "received_bytes":..., "total_bytes":...}
传输完成:   {"type":"transfer_complete", "transfer_id":"...", "file_name":"...", "verified":true}
传输取消:   {"type":"transfer_cancelled", "transfer_id":"..."}
传输恢复:   {"type":"transfer_resumed", "transfer_id":"...", "file_name":"...", "from_name":"..."}

# ===== HTTP 文件分片 =====
POST /api/transfer/chunk
  Body:   {"transfer_id":"...", "chunk_index":51, "data":"<base64>"}
  Return: {"status":"ok", "chunk_index":51, "received_bytes":3407872}

POST /api/transfer/complete
  Body:   {"transfer_id":"..."}
  Return: {"status":"ok", "verified":true}

GET /api/transfer/status/{transfer_id}
  Return: {"transfer_id":"...", "file_name":"...", "received_bytes":...,
           "received_chunks_count":..., "total_chunks":..., "status":"in_progress"}
```

---

## 九、补充设计决策

### 9.1 数据存储位置

所有运行时数据存放在项目目录 `data/` 下，随项目走：
- `data/config.json` — 本机配置（UUID、昵称）
- `data/contacts.json` — 联系人 + 聊天记录
- `data/downloads/` — 接收的文件 + `.progress` 进度文件
- `data/` 加入 `.gitignore`，不提交到仓库

### 9.2 聊天记录持久化

每条消息实时写入 `contacts.json`，结构：

```json
{
  "uuid_aaa": {
    "name": "小红",
    "ip": "192.168.1.101",
    "ws_port": 50002,
    "first_contact": "2026-08-10T14:00:00",
    "last_contact": "2026-08-10T15:30:00",
    "trusted": true,
    "deleted": false,
    "messages": [
      {"from":"me", "content":"你好", "msg_id":"m001", "type":"chat", "timestamp":"..."},
      {"from":"uuid_aaa", "content":"你好呀~", "msg_id":"m002", "type":"chat", "timestamp":"..."},
      {"from":"uuid_aaa", "content":"", "msg_id":"f_t_xxx", "type":"file",
       "file_name":"demo.mp4", "file_size":104857600, "transfer_id":"t_xxx",
       "status":"complete", "progress":100, "timestamp":"..."}
    ]
  }
}
```

- `from: "me"` = 自己发的，`from: "uuid_xxx"` = 对方发的
- `type: "chat"|"file"` 区分文本与文件消息；文件消息携带 file_name/file_size/transfer_id/status/progress
- 每条联系人记录含 `ws_port`（跨子网 HTTP 探活用）、`trusted`、`deleted`（墓碑）字段
- 下次打开页面，加载历史消息显示在聊天区

### 9.3 同名文件自动改名

接收方保存前检查 `data/downloads/` 是否已有同名文件：
- 无冲突 → 直接保存 `demo.mp4`
- 有冲突 → 自动改名 `demo(1).mp4`、`demo(2).mp4` ...

### 9.4 文件传输取消

```
A 点"取消传输":
  → A 停止发送 chunk
  → A 通过聊天 WS 通知 B: {"type":"file_cancel", "transfer_id":"t_xxx"}
  → B 删除对应的 .part 和 .progress 文件
  → 清理 transfer 记录

接收方只有完整接收并校验通过后才显示文件，取消/中断不残留。
```

### 9.5 多网卡处理

- **FastAPI/HTTP 服务**：绑定 `0.0.0.0`，监听所有网卡接口
- **UDP 广播**：遍历所有活跃网卡，每个子网各发一份广播，**每张网卡的广播包携带该网卡自己的 IP**（而非全局单一 IP）

```
网卡1(WiFi): 192.168.1.100/24 → 广播到 192.168.1.255, ip=192.168.1.100
网卡2(有线):  10.0.0.50/8     → 广播到 10.255.255.255, ip=10.0.0.50
```

- UDP 监听绑定 `0.0.0.0`，可收到来自所有网卡的广播回复
- 只支持同子网发现，不跨路由器
- 网卡枚举结果缓存 60 秒，避免频繁调用系统命令

### 9.7 跨子网手动连接与自动探活

跨子网（如物理机与虚拟机 Host-Only 网段）UDP 广播无法到达，但 TCP 可达。提供手动 IP 连接 + 自动 HTTP 探活机制。

#### 手动连接
- 在线列表标题栏 `➕` 按钮 → 展开 IP:端口输入行 → 输入目标地址 → 直接 WebSocket 连接
- 无需对方在 UDP 在线列表中

#### 跨子网 Token 验证
- 同子网：UDP 广播分发的 token 直接验证
- 跨子网兜底：HTTP GET 发起方 `/api/me` → 对比返回的 token → 通过则临时写入 peer_list

```
A（发起方，跨子网）→ B：
  ① A 浏览器 → WS 连接 B 的 /ws/chat
  ② 发送 connect_request {uuid, token, ip, ws_port}
  ③ B 查 peer_list：找不到 A 的 UUID（UDP 未覆盖）
  ④ B HTTP GET http://A_IP:A_PORT/api/me → 返回 {uuid, token}
  ⑤ 对比通过 → A 写入 peer_list → 通知 B 浏览器 incoming_connection
  ⑥ B 同意 → 连接建立
```

#### 定期 HTTP 探活
- 后台每 30 秒对所有不在 UDP 列表中的历史联系人发起 HTTP GET `/api/me`
- 成功 → 刷新 `last_seen` 阻止超时标记离线，首次发现则通知前端上线
- 失败 → 不处理，由 UDP 超时机制（16s）自然标记离线
- 联系人存储 `ws_port` 字段，用于探活时知道对方监听端口

#### 联系人存储 ws_port
`contacts.json` 每条记录包含 `ws_port` 字段：
```json
{
  "uuid_xxx_50003": {
    "name": "小红",
    "ip": "192.168.215.128",
    "ws_port": 50003,
    "first_contact": "...",
    "last_contact": "...",
    "messages": [...]
  }
}
```

### 9.8 自节点过滤

前后端多层过滤确保用户不会看到自己的节点：
- 后端 `_handle_message`：UDP 层过滤 `uuid == self.my_uuid`
- 后端 init 消息：过滤 contacts 和 online_peers 中的 `MY_UUID`
- 后端 `_probe_saved_contacts`：跳过 `c["uuid"] == MY_UUID`
- 后端 `ws_chat`：拒绝 `peer_uuid == MY_UUID` 的 self_connect
- 前端 `handlePeerOnline` / `updateOnlinePeers` / `updateContacts`：跳过 `myInfo.uuid`
- 前端 `connectByIp`：拒绝自己的 IP:端口

### 9.9 删除联系人与墓碑机制

删除联系人不是物理删除，而是保留「墓碑」记录，用于重连时判断双方身份关系：

- 本端删除：`delete_contact` 将联系人 `trusted=false` + `deleted=true` + 清空 messages
  （墓碑不显示在前端，`list_contacts` 过滤 `deleted=true`）
- 同时通过 chat WS 通知对端 `contact_untrusted`（对端把本端标记为 `trusted=false`，不删数据）
- 墓碑的作用：下次重连时，发起方在 connect_request 里带 `deleted_you`（来自 `/api/me` 的
  `deleted_uuids`），对方据此强制重新走用户确认流程，而非自动接受

```
A 删除 B:
  ① A 前端发 delete_contact → A 后端
  ② A 后端通知 B 后端 contact_untrusted（B 标记 A 为 trusted=false）
  ③ A 后端关闭与 B 的 chat WS、清理待确认请求和进行中的传输
  ④ A 后端 delete_contact：B 变墓碑（deleted=true, trusted=false），清空聊天记录

A 再次连接 B:
  A 在 connect_request 带 deleted_you:true（A 的 deleted_uuids 含 B）
  B 收到后即使本端 trusted=true 也强制走用户确认，而非自动接受
  同意后 upsert_contact 清除墓碑（deleted=false）并恢复 trusted=true
```

### 9.6 其他细节

| 项目 | 决定 |
|------|------|
| **端口冲突** | 自动 +1 重试（50002→50003→...），最多10次 |
| **同时多人聊天** | 支持，每个用户独立 WS 连接，右侧切换显示 |
| **浏览器刷新** | 所有聊天 WS 断开，刷新后聊天需手动重新发起 |
| **程序退出** | Ctrl+C → 发 goodbye 广播 → 关闭所有 WS → 退出 |
| **IP 变化** | 定时检测，变化后重新初始化 discovery |
| **同名用户** | 允许，前端显示 `小明(DESKTOP-ABC)` 区分 |
| **双方同时发起连接** | 各自建立一条 WS，合并到同一聊天窗口 |
| **删除联系人** | 右键删除，同时清除聊天记录 |
| **拒绝连接后** | A 显示"对方拒绝了连接"，可再次发起 |
| **离线消息** | 等重连后自动重发 |
| **断连重连** | A 方自动发起，指数退避 1s→2s→...→30s |

---

## 十、开发步骤

| 步骤 | 模块 | 产出 |
|------|------|------|
| 1 | `storage.py` | 联系人 + 配置 JSON 读写 |
| 2 | `discovery.py` | UDP 广播 + 监听，节点发现 |
| 3 | `main.py` | FastAPI 路由 + WS + 文件传输 API |
| 4 | `index.html` | 前端页面结构 |
| 5 | `style.css` | 界面样式 |
| 6 | `app.js` | 前端交互逻辑 |
| 7 | 测试 | 双实例互发消息 + 传文件验证 |
