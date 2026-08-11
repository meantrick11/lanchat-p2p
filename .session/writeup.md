# WRITEUP

整体项目实现思路

## day1

技术栈和架构问题拆解：
1. 确定编程语言为python
2. 分析整个业务逻辑链链

用户启动服务->本地浏览器打开->（用户网页登录(自命名，默认进程),保存在程序的data中）->UDP进行用户发现->当前网段中的在线用户名以及基础信息、历史建立连接的用户名以及聊天信息等，保存在data文件夹中->然后点击在线用户->发送建立连接请求->对方同意建立连接(核实UUID+token(广播)等，是否是历史连接建立等情况，防止伪造用户（UUID认证）)->建立ws连接->进行通信(文件传输，通过http分片，然后就是重传机制，记录transfer_id,以及状态，B的重新上线，触发重传机制+A的主动每5s尝试重传，超过24h会自动删除.progress目录)

3. 其他设计问题可以参考question.md，其中包括但不限于UDP的用户全量发现策略、全局广播token+UUID的认证机制、连接目标端的统一连接窗口、用户名默认+可重命名机制、UUID持久化+历史聊天记录、历史聊天数据存储位置、文件重传机制等等。

4. 版本初代实现，AI代码编辑：


## day2

1. 完成 LanChat 的跨网段通过 IP 寻址的连接问题
2. 自连接去重问题
3. 连接状态显示同步问题
4. 文件传输连接显示错误问题
5. **消息持久化竞态条件修复**：`append_message` 锁范围过小导致并发写覆盖 → 持锁覆盖全周期 + msg_id 去重
6. **文件消息持久化**：文件消息只存浏览器内存 → 扩展 `append_message` 支持 file 类型 + 状态更新 → 前端全流程节点调用 `saveFileMessage`
7. **文件消息刷新变空白**：CSS 缺失 + 旧数据无 `type` 字段 → 补全 10+ CSS 类 + `f_` 前缀回退检测 + 字段容错
8. **发送文件间歇性失败**：`sendFile` 无回退路径 → 控制 WS 新增 file_request 转发 + 前端 fallback
9. **连接状态双方同步**：接收方无 outgoing WS → 新增 `connectedPeers` Set 双方向追踪 → 🟢🟡🔴 三态显示
10. **文件打开触发下载**：`FileResponse(filename=...)` 强制 attachment → 去掉 filename，浏览器自决
11. **旧进程残留**：Stop-Process 不完全 → Get-Process | Stop-Process -Force 全杀
12. **断开连接功能**：新增断开按钮 + 后端 disconnect handler → 单方断开双方同步
13. **删除联系人底层 WS 未断开**：deleteCurrentContact 先断开 WS → 再删除数据
14. **删除联系人确认弹窗**：直接删除易误触 → 增加 confirm 确认
15. **文件发送回退路径（Path 2）修复**：被动方发文件走 control WS 时，对端前端无 `file_request` handler 静默丢弃 + 响应路径 `peer_ws` 为空无法回传 → 后端新增 `POST /api/transfer/request` HTTP relay + `forward_file_response` 浏览器转发
16. **聊天消息溢出无法滚动**：flex 子元素隐式 `min-height:auto` 导致容器随内容撑高 → `#chat-container` 和 `#chat-messages` 全链加 `min-height:0`
17. **文件消息气泡不可见**：`min-height:0` 后 flex 子元素被等比压缩至 0 高度 → `flex-shrink:0` + JS 中 `scrollTop` 改用 `requestAnimationFrame` 等 flex 重排完成

