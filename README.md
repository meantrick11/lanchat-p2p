# LanChat — 局域网 P2P 通讯工具

纯 P2P 架构的局域网即时通讯工具，无需中心服务器。支持好友发现、文字聊天和文件传输。

## 快速开始

### 环境要求

- Python 3.13+

### 安装 uv

**Windows（PowerShell）：**
```powershell
irm https://astral.sh/uv/install.ps1 | iex 
```

**macOS / Linux：**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**pip（通用）：**
```bash
pip install uv
```

### 安装运行

```bash
# 克隆项目
git clone https://github.com/meantrick11/lanchat-p2p
cd lanchat-p2p

# 安装依赖
uv sync

# 启动（使用默认主机名）
uv run python main.py
```

打开浏览器访问 `http://localhost:50002`。

### 多实例测试

通过环境变量在同一台电脑上运行多个实例：

```bash
# 实例 1（默认端口 50002，数据目录 ./data）
uv run python main.py

# 实例 2（端口 50003，数据目录 ./data2，昵称"小红"）
$env:LANCHAT_PORT="50003"
$env:LANCHAT_DATA_DIR="./data2"
$env:LANCHAT_NAME="小红"
uv run python main.py
```

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `LANCHAT_NAME` | 自定义昵称 | 系统主机名 |
| `LANCHAT_PORT` | HTTP/WS 服务端口 | 自动查找（从 50002 起） |
| `LANCHAT_DATA_DIR` | 数据存储目录 | `./data` |

## 功能特性

### 核心功能

- **UDP 节点发现**：广播心跳包自动发现局域网内的 LanChat 节点（每 3 秒）
- **WebSocket 文字聊天**：端到端即时消息，msg_id + ACK 确认机制，5 秒超时重试
- **HTTP 文件传输**：64KB 分片上传，Base64 编码，支持断点续传（`.progress` 进度文件）
- **Token 身份认证**：节点生成随机 token 随 UDP 广播，建立 WS 连接时验证
- **连接请求确认**：收到连接请求时弹窗确认，接受/拒绝由用户决定
- **连接状态显示**：侧边栏和聊天头部实时显示 🔗已连接 / 🟡在线未连接 / 🔴离线 三种状态
- **消息持久化**：文字消息和文件传输消息均实时写入 `contacts.json`，刷新页面历史不丢失

### 交互设计

- **在线列表**（左侧上方）：当前局域网在线的 LanChat 节点
- **连接请求**（左侧中部）：待处理的连接请求，带同意/拒绝按钮
- **历史联系人**（左侧下方）：所有曾经建立过联系的用户，🟢 在线 / 🔴 离线
- **聊天区**（右侧）：文字消息发送、文件传输、在线状态显示

## 技术架构

```
浏览器 A ←→ 后端 A ←→ UDP 广播 ←→ 后端 B ←→ 浏览器 B
                ↕                        ↕
           control WS              control WS
                ↕                        ↕
           chat WS ───────→  ←─ chat WS
```

| 端口 | 协议 | 用途 |
|------|------|------|
| 50001 | UDP | 心跳广播 + 监听 |
| 50002+ | TCP/HTTP/WS | FastAPI 服务（端口冲突自动递增） |

### 项目结构

```
internproject/
├── main.py            # FastAPI 入口（REST API + WebSocket + 生命周期管理）
├── discovery.py       # UDP 节点发现（广播 + 监听 + Token 管理）
├── storage.py         # JSON 持久化（配置 / 联系人 / 消息 / 传输进度）
├── static/            # 前端文件（零构建，浏览器即客户端）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/              # 运行时数据（git 忽略）
│   ├── config.json    # 本机 UUID + 昵称
│   ├── contacts.json  # 联系人 + 聊天记录
│   └── downloads/     # 接收的文件
├── .session/          # AI 协作记录
│   ├── architecture.md
│   ├── question.md
│   └── process.md
├── pyproject.toml     # uv 项目配置
└── README.md
```

### 核心设计

- **纯 P2P**：无中心服务器，每个节点同时是客户端和服务端
- **两套 WebSocket**：`/ws/control`（浏览器 ↔ 自己后端） + `/ws/chat`（浏览器 ↔ 对方后端）
- **Token 认证**：UUID 固定身份 + Token 每 3 秒刷新，建立连接时验证（容忍一次刷新周期）
- **消息可靠性**：msg_id + ACK，5 秒超时，接收端 msg_id 去重
- **文件断点续传**：`.progress` 进度文件记录已收分片，重启后可续传

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/me` | 本机信息（UUID、昵称、IP、Token） |
| GET | `/api/peers` | 当前在线节点列表 |
| GET | `/api/contacts` | 历史联系人（合并在线状态） |
| GET | `/api/messages/{uuid}` | 指定联系人的聊天记录 |
| POST | `/api/config` | 修改昵称 |
| DELETE | `/api/contacts/{uuid}` | 删除联系人及聊天记录 |
| GET | `/api/pending` | 待处理的连接请求 |
| POST | `/api/transfer/chunk` | 接收文件分片 |
| POST | `/api/transfer/complete` | 文件传输完成确认 |
| GET | `/api/transfer/status/{id}` | 查询传输进度 |
| WS | `/ws/control` | 浏览器 ↔ 后端控制通道 |
| WS | `/ws/chat` | 浏览器 ↔ 对端后端聊天通道 |
