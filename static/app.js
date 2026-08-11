/**
 * LanChat 前端交互逻辑。
 *
 * 全局状态:
 *   myInfo       - 本机信息 {uuid, name, ip, network, ws_port}
 *   onlinePeers  - 在线节点 Map<uuid, {name, ip}>
 *   contacts     - 历史联系人 Map<uuid, {name, ip, status, messages[]}>
 *   pendingReqs  - 待处理连接请求 Map<uuid, {name}>
 *   activeChats  - 活跃聊天 WS Map<uuid, WebSocket>
 *   currentChat  - 当前显示的聊天 uuid | null
 *   pendingMsgs  - 待确认消息 Map<msg_id, {content, uuid, timestamp}>
 *   pendingFileTransfers - 待处理的文件上传 {transferId: {file, uuid, ...}}
 */

// ===== 全局状态 =====
let myInfo = null;
let onlinePeers = new Map();
let contacts = new Map();
let pendingRequests = new Map();
let activeChats = new Map();         // uuid → WebSocket（主动发起方有值）
let connectedPeers = new Set();      // 连接已确认的 peer uuid（双方向都追踪，含接收方）
let currentChat = null;
let pendingMessages = new Map();
let controlWs = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// 文件传输状态
let pendingFileTransfers = {};

// ===== DOM 引用 =====
const $ = (id) => document.getElementById(id);
const onlineList = $('online-list');
const onlineCount = $('online-count');
const pendingList = $('pending-list');
const pendingCount = $('pending-count');
const panelPending = $('panel-pending');
const contactsList = $('contacts-list');
const contactsCount = $('contacts-count');
const chatPlaceholder = $('chat-placeholder');
const chatContainer = $('chat-container');
const chatPeerName = $('chat-peer-name');
const chatPeerStatus = $('chat-peer-status');
const chatMessages = $('chat-messages');
const msgInput = $('msg-input');
const btnSend = $('btn-send');
const btnSendFile = $('btn-send-file');
const fileInput = $('file-input');
const btnCloseChat = $('btn-close-chat');
const btnDeleteContact = $('btn-delete-contact');
const btnDisconnect = $('btn-disconnect');
const btnScan = $('btn-scan');
const btnEditName = $('btn-edit-name');
const modalOverlay = $('modal-overlay');
const modalNameInput = $('modal-name-input');
const fileModalOverlay = $('file-modal-overlay');
const fileModalTitle = $('file-modal-title');
const fileModalBody = $('file-modal-body');
const fileModalButtons = $('file-modal-buttons');

// ===== 初始化 =====
async function init() {
    await connectControl();
    bindEvents();
    startPolling();
}

/** 连接控制 WebSocket */
async function connectControl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/control`;

    return new Promise((resolve) => {
        controlWs = new WebSocket(url);

        controlWs.onopen = () => {
            reconnectAttempts = 0;
            console.log('[Control] 已连接');
        };

        controlWs.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            handleControlMessage(msg);
            if (msg.type === 'init') resolve();
        };

        controlWs.onclose = () => {
            console.log('[Control] 断开，尝试重连...');
            scheduleReconnect();
        };

        controlWs.onerror = () => {};
    });
}

/** 控制 WS 断开后指数退避重连 */
function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    reconnectAttempts++;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        await connectControl();
    }, jitter);
}

// ===== 事件绑定 =====
function bindEvents() {
    btnScan.addEventListener('click', () => fetchPeers());
    btnEditName.addEventListener('click', showEditNameModal);
    $('btn-modal-cancel').addEventListener('click', hideEditNameModal);
    $('btn-modal-save').addEventListener('click', saveName);
    modalNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveName();
    });
    btnSend.addEventListener('click', sendCurrentMessage);
    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendCurrentMessage();
    });
    btnSendFile.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onFileSelected);
    btnCloseChat.addEventListener('click', closeCurrentChat);
    btnDisconnect.addEventListener('click', disconnectCurrentChat);
    btnDeleteContact.addEventListener('click', deleteCurrentContact);

    // 手动连接：toggle 展开/收起
    const btnManualConnect = $('btn-manual-connect');
    const manualIpInput = $('manual-ip-input');

    btnManualConnect.addEventListener('click', () => {
        const raw = manualIpInput.value.trim();
        if (!raw) return;
        let [ip, port] = raw.split(':');
        port = parseInt(port) || 50002;
        connectByIp(ip, port);
        manualIpInput.value = '';
        toggleManualConnect(); // 收起
    });
    manualIpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnManualConnect.click();
    });
}

/** 展开/收起手动连接输入行（内联 onclick 和 JS 均可调用） */
function toggleManualConnect() {
    const row = $('manual-connect-row');
    const btn = $('btn-toggle-manual');
    if (!row || !btn) return;
    const visible = row.style.display !== 'none';
    row.style.display = visible ? 'none' : '';
    btn.textContent = visible ? '➕' : '✖';
    if (!visible) $('manual-ip-input').focus();
}

// ===== 定时轮询 =====
function startPolling() {
    setInterval(fetchPeers, 3000);
    setInterval(fetchContacts, 5000);
    fetchPeers();
    fetchContacts();
}

async function fetchPeers() {
    try {
        const resp = await fetch('/api/peers');
        const peers = await resp.json();
        updateOnlinePeers(peers);
    } catch (e) { /* ignore */ }
}

async function fetchContacts() {
    try {
        const resp = await fetch('/api/contacts');
        const list = await resp.json();
        updateContacts(list);
    } catch (e) { /* ignore */ }
}

// ===== 控制消息处理 =====
function handleControlMessage(msg) {
    const handlers = {
        init: handleInit,
        peer_online: handlePeerOnline,
        peer_offline: handlePeerOffline,
        incoming_connection: handleIncomingConnection,
        pending_update: handlePendingUpdate,
        connection_established: handleConnectionEstablished,
        peer_disconnected: handlePeerDisconnected,
        disconnected: handleDisconnected,
        chat_message: handleIncomingMessage,
        message_ack: handleMessageAck,
        send_failed: handleSendFailed,
        incoming_file_request: handleIncomingFileRequest,
        file_request_response: handleFileRequestResponseFromControl,
        forward_file_response: handleForwardFileResponse,
        transfer_progress: handleTransferProgress,
        transfer_complete: handleTransferComplete,
        transfer_cancelled: handleTransferCancelled,
        transfer_resumed: handleTransferResumed,
    };
    const handler = handlers[msg.type];
    if (handler) handler(msg);
}

function handleInit(msg) {
    myInfo = msg;
    $('my-name-label').textContent = msg.name;
    $('my-ip-label').textContent = `IP: ${msg.ip}`;
    $('my-network-label').textContent = `网段: ${msg.network}`;
    // msg.token 是自己的 token，建立连接时需出示给对方后端验证

    // 步骤1：先用 init 消息中的在线节点填充 onlinePeers（不等轮询）
    if (msg.online_peers && msg.online_peers.length > 0) {
        updateOnlinePeers(msg.online_peers);
    }

    // 步骤2：加载历史联系人（此时 onlinePeers 已有数据，渲染时状态正确）
    if (msg.contacts && msg.contacts.length > 0) {
        updateContacts(msg.contacts);
    }
}

function handlePeerOnline(msg) {
    // 过滤自己
    if (msg.uuid === myInfo.uuid) return;
    onlinePeers.set(msg.uuid, { name: msg.name, ip: msg.ip, ws_port: msg.ws_port, token: msg.token });
    // 如果历史联系人里有，更新在线状态
    if (contacts.has(msg.uuid)) {
        contacts.get(msg.uuid).status = 'online';
    }
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
}

function handlePeerOffline(msg) {
    onlinePeers.delete(msg.uuid);
    if (contacts.has(msg.uuid)) {
        contacts.get(msg.uuid).status = 'offline';
    }
    // 对应聊天 WS 断开
    const ws = activeChats.get(msg.uuid);
    if (ws) {
        ws.close();
        activeChats.delete(msg.uuid);
    }
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
    addSystemMessage(msg.uuid, `${msg.name} 已下线`);
}

function handleIncomingConnection(msg) {
    // 保存连接请求信息，包括 IP 和端口，以便同意后反向建立连接
    pendingRequests.set(msg.uuid, { name: msg.name, ip: msg.ip, ws_port: msg.ws_port });
    renderPendingList();
}

function handlePendingUpdate(msg) {
    // count 可能在 pending 列表被其他地方修改后推送
    if (msg.count === 0) pendingRequests.clear();
}

function handleConnectionEstablished(msg) {
    pendingRequests.delete(msg.uuid);
    connectedPeers.add(msg.uuid);  // 接收方也标记为已连接
    // 加入联系人
    contacts.set(msg.uuid, {
        name: msg.name,
        ip: msg.ip,
        status: 'online',
        messages: [],
    });
    renderPendingList();
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
    // 如果正在等对方的确认（主动发起方），打开聊天
    if (currentChat === msg.uuid || !currentChat) {
        openChat(msg.uuid);
    }
}

function handlePeerDisconnected(msg) {
    activeChats.delete(msg.uuid);
    connectedPeers.delete(msg.uuid);
    pendingRequests.delete(msg.uuid);
    renderPendingList();
    renderOnlineList();
    renderContactsList();
    if (currentChat === msg.uuid) {
        updateChatHeaderStatus();
        addSystemMessage(msg.uuid, `${msg.name || '对方'} 已断开连接`);
    }
}

/** 自己主动断开后的确认回调（后端关闭对端 WS 后返回） */
function handleDisconnected(msg) {
    activeChats.delete(msg.uuid);
    connectedPeers.delete(msg.uuid);
    renderOnlineList();
    renderContactsList();
    if (currentChat === msg.uuid) {
        updateChatHeaderStatus();
        addSystemMessage(msg.uuid, '你已断开连接');
    }
}

function handleIncomingMessage(msg) {
    const uuid = msg.from;
    // 保存消息到联系人内存
    if (!contacts.has(uuid)) {
        contacts.set(uuid, { name: msg.from_name, ip: '', status: 'online', messages: [] });
    }
    const contact = contacts.get(uuid);
    contact.messages.push({
        from: uuid,
        content: msg.content,
        msg_id: msg.msg_id,
        timestamp: msg.timestamp,
    });
    // 立即通知后端持久化到 contacts.json（与后端 _relay_from_peer 形成双保险，
    // storage.append_message 内部有 msg_id 去重，重复调用安全）
    controlWs.send(JSON.stringify({
        type: 'save_message',
        peer_uuid: uuid,
        sender: uuid,
        content: msg.content,
        msg_id: msg.msg_id,
    }));
    if (currentChat === uuid) {
        renderMessages(uuid);
    }
    // 当前没有聊天窗口时，自动打开
    if (!currentChat) {
        openChat(uuid);
    }
    renderContactsList();
}

function handleMessageAck(msg) {
    pendingMessages.delete(msg.msg_id);
    if (currentChat) renderMessages(currentChat);
}

function handleSendFailed(msg) {
    // 标记消息发送失败
    const pending = pendingMessages.get(msg.msg_id);
    if (pending) {
        pending.status = 'failed';
        pendingMessages.set(msg.msg_id, pending);
    }
    if (currentChat) renderMessages(currentChat);
}

// ===== 文件传输消息处理 =====

function handleIncomingFileRequest(msg) {
    showFileRequestModal(msg);
}

/**
 * 处理来自控制 WS 的文件请求响应（通过后端 _relay_from_peer 转发的）。
 * 与来自聊天 WS 直连的响应统一走 handleFileRequestResponse。
 */
function handleFileRequestResponseFromControl(msg) {
    handleFileRequestResponse(msg);
}

/**
 * 统一处理文件请求响应。
 * 发送方会从聊天 WS 直连或控制 WS 两条路径收到此消息，
 * 通过 transfer_id 精确匹配，且幂等（started 标记防止重复启动上传）。
 */
function handleFileRequestResponse(msg) {
    const transferId = msg.transfer_id;
    const t = pendingFileTransfers[transferId];
    if (!t) return; // 不是我们的传输

    if (msg.accepted) {
        if (t.started) return; // 已启动，幂等
        t.started = true;
        startChunkUpload(transferId);
    } else {
        // 对方拒绝
        delete pendingFileTransfers[transferId];
        const fileMsg = findFileMsgByTransferId(transferId);
        if (fileMsg) {
            fileMsg.status = 'failed';
            // 通过 transferId 找到对应的联系人 uuid
            saveFileMessage(t.uuid, fileMsg);
            if (currentChat) renderMessages(currentChat);
        }
        showToast('对方拒绝了文件传输');
    }
}

function handleTransferProgress(msg) {
    // 接收方：更新文件消息进度
    const fileMsg = findFileMsgByTransferId(msg.transfer_id);
    if (fileMsg && msg.total_bytes > 0) {
        fileMsg.progress = Math.round(msg.received_bytes / msg.total_bytes * 100);
        if (currentChat) renderMessages(currentChat);
    }
}

function handleTransferComplete(msg) {
    // 接收方：传输完成
    const fileMsg = findFileMsgByTransferId(msg.transfer_id);
    if (fileMsg) {
        fileMsg.status = msg.verified ? 'complete' : 'failed';
        fileMsg.progress = 100;
        saveFileMessage(currentChat, fileMsg);
        if (currentChat) renderMessages(currentChat);
    }
    if (msg.verified) {
        showToast(`文件接收完成: ${msg.file_name}`);
    } else {
        showToast(`文件校验失败: ${msg.file_name}`);
    }
}

function handleTransferCancelled(msg) {
    const fileMsg = findFileMsgByTransferId(msg.transfer_id);
    if (fileMsg) {
        fileMsg.status = 'cancelled';
        saveFileMessage(currentChat, fileMsg);
        if (currentChat) renderMessages(currentChat);
    }
    // 清理上传方状态
    if (pendingFileTransfers[msg.transfer_id]) {
        delete pendingFileTransfers[msg.transfer_id];
    }
    showToast('文件传输已取消');
}

function handleTransferResumed(msg) {
    // 续传恢复通知 — 不做额外弹窗，进度条会在 transfer_progress 中更新
    const fileMsg = findFileMsgByTransferId(msg.transfer_id);
    if (fileMsg) {
        fileMsg.status = 'downloading';
        if (currentChat) renderMessages(currentChat);
    }
}

/**
 * 当后端无法直接发送 file_response 给发送方时（发送方是被动接收方，无 incoming WS），
 * 后端通知本浏览器通过本方的 chat WS 转发响应给对端后端。
 */
function handleForwardFileResponse(msg) {
    const chatWs = activeChats.get(msg.to_uuid);
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
            type: 'file_response',
            transfer_id: msg.transfer_id,
            accepted: msg.accepted,
        }));
    }
}

// ===== 在线列表渲染 =====
function updateOnlinePeers(peers) {
    onlinePeers.clear();
    for (const p of peers) {
        // 过滤自己
        if (p.uuid === myInfo.uuid) continue;
        // 保存 token，用于建立连接时出示给对方后端验证
        onlinePeers.set(p.uuid, { name: p.name, ip: p.ip, ws_port: p.ws_port, token: p.token });
    }
    renderOnlineList();
    // 同时刷新联系人列表的状态（在线/离线圆点）
    renderContactsList();
    updateChatHeaderStatus();
}

/** 获取指定用户的连接状态文本（主动方查 activeChats，被动方查 connectedPeers） */
function getConnectionLabel(uuid) {
    const ws = activeChats.get(uuid);
    const wsOpen = ws && ws.readyState === WebSocket.OPEN;
    const connected = wsOpen || connectedPeers.has(uuid);
    return connected ? ' 🔗已连接' : '';
}

function renderOnlineList() {
    onlineCount.textContent = onlinePeers.size;
    if (onlinePeers.size === 0) {
        onlineList.innerHTML = '<div class="empty-hint">暂无在线用户</div>';
        return;
    }
    onlineList.innerHTML = '';
    for (const [uuid, peer] of onlinePeers) {
        const div = document.createElement('div');
        div.className = `item${currentChat === uuid ? ' active' : ''}`;
        const connLabel = getConnectionLabel(uuid);
        div.innerHTML = `
            <span class="dot online"></span>
            <div class="info">
                <div class="name">${esc(peer.name)}${connLabel}</div>
                <div class="sub">${esc(peer.ip)}</div>
            </div>`;
        div.addEventListener('click', () => connectToPeer(uuid, peer.name, peer.ip));
        onlineList.appendChild(div);
    }
}

// ===== 待处理请求列表渲染 =====
function renderPendingList() {
    if (pendingRequests.size === 0) {
        panelPending.style.display = 'none';
        return;
    }
    panelPending.style.display = '';
    pendingCount.textContent = pendingRequests.size;
    pendingList.innerHTML = '';
    for (const [uuid, req] of pendingRequests) {
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = `
            <span class="dot pending"></span>
            <div class="info"><div class="name">${esc(req.name)}</div></div>
            <div class="actions">
                <button class="btn-accept" data-uuid="${uuid}">同意</button>
                <button class="btn-reject" data-uuid="${uuid}">拒绝</button>
            </div>`;
        div.querySelector('.btn-accept').addEventListener('click', (e) => {
            e.stopPropagation();
            respondConnection(uuid, true);
        });
        div.querySelector('.btn-reject').addEventListener('click', (e) => {
            e.stopPropagation();
            respondConnection(uuid, false);
        });
        pendingList.appendChild(div);
    }
}

async function respondConnection(uuid, accepted) {
    controlWs.send(JSON.stringify({
        type: 'connection_response',
        to_uuid: uuid,
        accepted: accepted,
    }));
    pendingRequests.delete(uuid);
    renderPendingList();
    if (accepted) {
        // 保存联系人信息并打开聊天窗口
        // 注意：消息发送走 A→B后端的 chat WS（双向），B→A 走 B后端的 active_chats[A] 回传同一 WS
        const peer = onlinePeers.get(uuid) || { name: 'Unknown', ip: '' };
        contacts.set(uuid, { name: peer.name, ip: peer.ip, status: 'online', messages: [] });
        openChat(uuid);
    }
}

// ===== 历史联系人列表渲染 =====
function updateContacts(list) {
    for (const c of list) {
        // 过滤自己
        if (c.uuid === myInfo.uuid) continue;
        if (!contacts.has(c.uuid)) {
            contacts.set(c.uuid, {
                name: c.name,
                ip: c.ip,
                status: c.status,
                messages: [],
            });
        } else {
            contacts.get(c.uuid).status = c.status;
            contacts.get(c.uuid).name = c.name || contacts.get(c.uuid).name;
            contacts.get(c.uuid).ip = c.ip || contacts.get(c.uuid).ip;
        }
    }
    renderContactsList();
    updateChatHeaderStatus();
}

function renderContactsList() {
    const list = Array.from(contacts.entries())
        .sort((a, b) => {
            // 在线排前面，同状态按名字排序
            if (a[1].status !== b[1].status) return a[1].status === 'online' ? -1 : 1;
            return a[1].name.localeCompare(b[1].name);
        });

    contactsCount.textContent = list.length;
    if (list.length === 0) {
        contactsList.innerHTML = '<div class="empty-hint">暂无历史联系人</div>';
        return;
    }

    contactsList.innerHTML = '';
    for (const [uuid, contact] of list) {
        const div = document.createElement('div');
        div.className = `item${currentChat === uuid ? ' active' : ''}`;
        // 用实时在线列表判断状态，与点击行为保持一致
        const isOnline = onlinePeers.has(uuid);
        const dotClass = isOnline ? 'online' : 'offline';
        const connLabel = getConnectionLabel(uuid);
        const statusText = isOnline ? connLabel : ' (离线)';
        div.innerHTML = `
            <span class="dot ${dotClass}"></span>
            <div class="info">
                <div class="name">${esc(contact.name)}${statusText}</div>
                <div class="sub">${esc(contact.ip)}</div>
            </div>`;
        div.addEventListener('click', () => {
            // 用实时在线列表判断（与 updateChatHeaderStatus 数据源一致）
            if (onlinePeers.has(uuid)) {
                // 在线 → 自动发送连接请求
                connectToPeer(uuid, contact.name, contact.ip);
            } else {
                // 离线 → 提示用户，但仍然加载历史聊天记录
                showToast('对方不在线');
                openChat(uuid);
            }
        });
        // 右键删除
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (confirm(`确定删除联系人 ${contact.name} 及聊天记录？`)) {
                deleteContact(uuid);
            }
        });
        contactsList.appendChild(div);
    }
}

async function deleteContact(uuid) {
    try {
        await fetch(`/api/contacts/${uuid}`, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
    contacts.delete(uuid);
    if (currentChat === uuid) closeCurrentChat();
    renderContactsList();
}

// ===== 连接对端 / 打开聊天 =====

/**
 * 主动发起与对端的 WebSocket 连接。
 * 流程: 连接 ws://peer_ip:ws_port/ws/chat → 发 connect_request（带 token）→ 等 connect_accepted
 */
async function connectToPeer(uuid, name, ip) {
    // 如果已有活跃连接，直接打开聊天
    if (activeChats.has(uuid)) {
        openChat(uuid);
        return;
    }

    // 获取对端 ws_port（从在线节点列表）
    const peer = onlinePeers.get(uuid);
    if (!peer) {
        showToast('对方不在线');
        return;
    }

    openChat(uuid); // 先打开聊天窗口，显示"连接中..."

    // 连接前先刷新自己的 token（token 每3秒更新，避免用过期的）
    try {
        const resp = await fetch('/api/me');
        const me = await resp.json();
        myInfo.token = me.token;
    } catch (e) { /* 刷新失败则用现有 token */ }

    try {
        const peerPort = peer.ws_port || 50002;
        const wsUrl = `ws://${peer.ip}:${peerPort}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            // 发送连接请求，带上自己的 token 给对方后端验证
            // 对方通过 UDP 广播收到了我的 token，验证是否匹配
            ws.send(JSON.stringify({
                type: 'connect_request',
                uuid: myInfo.uuid,
                name: myInfo.name,
                token: myInfo.token,
                ip: myInfo.ip,
                ws_port: myInfo.ws_port,
            }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connect_accepted') {
                activeChats.set(uuid, ws);
                connectedPeers.add(uuid);
                setupPeerMessageHandler(uuid, ws);
                addSystemMessage(uuid, '连接已建立');
                updateChatHeaderStatus();
                renderOnlineList();
                renderContactsList();
                // 通知自己后端保存联系人（对方后端已保存，自己后端也需要记录）
                controlWs.send(JSON.stringify({
                    type: 'save_contact',
                    uuid: uuid,
                    name: name,
                    ip: ip,
                    ws_port: peer.ws_port || 50002,
                }));
            } else if (msg.type === 'connect_rejected') {
                ws.close();
                const reason = msg.reason === 'invalid_token' ? 'Token 验证失败，请稍后重试' : '对方拒绝了连接请求';
                addSystemMessage(uuid, reason);
                showToast(reason);
            }
        };

        ws.onclose = () => {
            activeChats.delete(uuid);
            connectedPeers.delete(uuid);
            renderOnlineList();
            renderContactsList();
            if (currentChat === uuid) {
                addSystemMessage(uuid, '连接已断开');
                updateChatHeaderStatus();
            }
        };

        ws.onerror = () => {
            activeChats.delete(uuid);
            addSystemMessage(uuid, '连接失败，请检查网络');
            showToast('连接失败');
            ws.close();
        };

    } catch (e) {
        addSystemMessage(uuid, `连接失败: ${e.message}`);
    }
}

/**
 * 手动输入 IP 连接（跨子网场景）。
 * 与 connectToPeer 的区别：不需要对方在 onlinePeers 中（UDP 广播到不了）。
 */
async function connectByIp(ip, port) {
    port = port || 50002;
    // 生成临时 UUID（等 connect_accepted 时会替换为真实 UUID）
    const tempUuid = 'manual_' + ip + '_' + port;

    if (activeChats.has(tempUuid)) {
        showToast('已在连接中');
        return;
    }

    // 防止自连：不能连自己的 IP:端口
    if (ip === myInfo.ip && port === myInfo.ws_port) {
        showToast('不能连接到自己的实例');
        return;
    }

    openChat(tempUuid);
    addSystemMessage(tempUuid, `正在连接 ${ip}:${port}...`);

    // 连接前刷新自己的 token
    try {
        const resp = await fetch('/api/me');
        const me = await resp.json();
        myInfo.token = me.token;
    } catch (e) { /* ignore */ }

    try {
        const wsUrl = `ws://${ip}:${port}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'connect_request',
                uuid: myInfo.uuid,
                name: myInfo.name,
                token: myInfo.token,
                ip: myInfo.ip,
                ws_port: myInfo.ws_port,
            }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connect_accepted') {
                const realUuid = msg.uuid || tempUuid;
                const realName = msg.name || '手动连接';
                const realIp = msg.ip || ip;

                // 替换临时连接为真实连接
                activeChats.set(realUuid, ws);
                connectedPeers.add(realUuid);
                setupPeerMessageHandler(realUuid, ws);
                // 修正 close 回调使用真实 UUID
                ws.onclose = () => {
                    activeChats.delete(realUuid);
                    connectedPeers.delete(realUuid);
                    renderOnlineList();
                    renderContactsList();
                    if (currentChat === realUuid) {
                        addSystemMessage(realUuid, '连接已断开');
                        updateChatHeaderStatus();
                    }
                };
                // 迁移临时联系人数据
                if (contacts.has(tempUuid)) {
                    contacts.delete(tempUuid);
                }
                contacts.set(realUuid, {
                    name: realName,
                    ip: realIp,
                    status: 'online',
                    messages: [],
                });
                if (currentChat === tempUuid) {
                    currentChat = realUuid;
                    chatPeerName.textContent = realName;
                    updateChatHeaderStatus();
                }
                addSystemMessage(realUuid, '连接已建立 ✓');
                // 通知后端保存联系人
                controlWs.send(JSON.stringify({
                    type: 'save_contact',
                    uuid: realUuid,
                    name: realName,
                    ip: realIp,
                    ws_port: port,
                }));
                renderOnlineList();
                renderContactsList();
            } else if (msg.type === 'connect_rejected') {
                ws.close();
                const reason = msg.reason === 'invalid_token'
                    ? 'Token 验证失败，请稍后重试'
                    : '对方拒绝了连接请求';
                addSystemMessage(tempUuid, reason);
                showToast(reason);
            }
        };

        ws.onclose = () => {
            activeChats.delete(tempUuid);
            connectedPeers.delete(tempUuid);
            renderOnlineList();
            renderContactsList();
            if (currentChat === tempUuid) {
                addSystemMessage(tempUuid, '连接已断开');
                updateChatHeaderStatus();
            }
        };

        ws.onerror = () => {
            activeChats.delete(tempUuid);
            addSystemMessage(tempUuid, `连接失败: ${ip}:${port}`);
            showToast('连接失败，请检查地址');
            ws.close();
        };

    } catch (e) {
        addSystemMessage(tempUuid, `连接失败: ${e.message}`);
    }
}

/** 为对端 WS 设置消息处理器（收到 connect_accepted 后调用） */
function setupPeerMessageHandler(uuid, ws) {
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') {
            // 对方发来的聊天消息（直接从 ws 收到时也需要处理）
            handleDirectChatMessage(uuid, msg);
        } else if (msg.type === 'file_request') {
            // 对端后端通过 chat WS 发来的文件请求（HTTP relay 失败的 fallback）
            // 先在自己后端注册 transfer，再弹窗确认
            controlWs.send(JSON.stringify({
                type: 'register_transfer',
                transfer_id: msg.transfer_id,
                file_name: msg.file_name,
                file_size: msg.file_size,
                chunk_size: msg.chunk_size,
                total_chunks: msg.total_chunks,
                from_uuid: uuid,
                from_name: contacts.get(uuid) ? contacts.get(uuid).name : 'Unknown',
            }));
            // 用 from_uuid（chat WS 的对端 uuid）触发弹窗
            showFileRequestModal({
                transfer_id: msg.transfer_id,
                file_name: msg.file_name,
                file_size: msg.file_size,
                from_uuid: uuid,
                from_name: contacts.get(uuid) ? contacts.get(uuid).name : 'Unknown',
            });
        } else if (msg.type === 'file_response') {
            // 对方对我方文件请求的响应
            handleFileRequestResponse(msg);
        } else if (msg.type === 'file_cancel') {
            // 对方取消了传输
            handleTransferCancelled(msg);
        } else if (msg.type === 'ack') {
            handleMessageAck(msg);
        }
    };
}

function handleDirectChatMessage(uuid, msg) {
    if (!contacts.has(uuid)) {
        contacts.set(uuid, { name: msg.from_name, ip: '', status: 'online', messages: [] });
    }
    contacts.get(uuid).messages.push({
        from: uuid,
        content: msg.content,
        msg_id: msg.msg_id,
        timestamp: msg.timestamp,
    });
    // chat WS 直连绕过自己后端，需额外通知自己后端保存消息
    controlWs.send(JSON.stringify({
        type: 'save_message',
        peer_uuid: uuid,
        sender: uuid,
        content: msg.content,
        msg_id: msg.msg_id,
    }));
    if (currentChat === uuid) renderMessages(uuid);
    renderContactsList();
}

async function openChat(uuid) {
    currentChat = uuid;
    chatPlaceholder.style.display = 'none';
    chatContainer.style.display = '';

    const contact = contacts.get(uuid) || { name: 'Unknown', ip: '', status: 'offline' };
    chatPeerName.textContent = contact.name;
    updateChatHeaderStatus();

    // 从后端加载历史消息（首次打开或消息为空时加载）
    if (!contact.messages || contact.messages.length === 0) {
        try {
            const resp = await fetch(`/api/messages/${uuid}`);
            const history = await resp.json();
            if (!contacts.has(uuid)) {
                contacts.set(uuid, { name: contact.name, ip: contact.ip, status: contact.status, messages: [] });
            }
            contacts.get(uuid).messages = history;
        } catch (e) { /* 加载失败则用现有消息 */ }
    }

    renderMessages(uuid);
    renderOnlineList();
    renderContactsList();
}

function closeCurrentChat() {
    currentChat = null;
    chatPlaceholder.style.display = '';
    chatContainer.style.display = 'none';
    chatMessages.innerHTML = '';
    renderOnlineList();
    renderContactsList();
}

/** 主动断开当前聊天连接（关闭双方 WS，无需对方确认） */
function disconnectCurrentChat() {
    if (!currentChat) return;
    const uuid = currentChat;
    const contact = contacts.get(uuid);
    const peerName = contact ? contact.name : '对方';

    // 检查是否有正在进行的文件传输
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) {
            if (!confirm(`${peerName} 有正在传输的文件，断开连接将中断传输。确定断开？`)) {
                return;
            }
            break;
        }
    }

    if (!confirm(`确定断开与 ${peerName} 的连接？`)) return;

    // 1. 关闭本方的 outgoing chat WS（如果我们是主动发起方）
    const chatWs = activeChats.get(uuid);
    if (chatWs) {
        try { chatWs.close(); } catch (e) { /* ignore */ }
        activeChats.delete(uuid);
    }

    // 2. 通知后端关闭 incoming chat WS（如果我们是接收方）
    controlWs.send(JSON.stringify({
        type: 'disconnect',
        to_uuid: uuid,
    }));

    // 3. 清理本地状态
    connectedPeers.delete(uuid);

    // 4. 清理待处理的文件传输
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) {
            delete pendingFileTransfers[tid];
        }
    }

    // 5. 更新 UI
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
    addSystemMessage(uuid, '你已断开连接');
}

async function deleteCurrentContact() {
    if (!currentChat) return;
    const uuid = currentChat;
    const contact = contacts.get(uuid);
    const peerName = contact ? contact.name : '对方';

    if (!confirm(`确定删除联系人 ${peerName} 及其所有聊天记录？此操作不可恢复。`)) return;

    // 先断开底层 WS 连接（如果已连接），再删除联系人
    const chatWs = activeChats.get(uuid);
    if (chatWs || connectedPeers.has(uuid)) {
        // 关闭本方 outgoing WS
        if (chatWs) {
            try { chatWs.close(); } catch (e) { /* ignore */ }
            activeChats.delete(uuid);
        }
        // 通知后端关闭 incoming WS
        controlWs.send(JSON.stringify({ type: 'disconnect', to_uuid: uuid }));
        connectedPeers.delete(uuid);

        // 清理文件传输
        for (const [tid, t] of Object.entries(pendingFileTransfers)) {
            if (t.uuid === uuid) delete pendingFileTransfers[tid];
        }
    }

    // 通知后端删除联系人
    try {
        controlWs.send(JSON.stringify({ type: 'delete_contact', uuid: uuid }));
    } catch (e) { /* ignore */ }
    contacts.delete(uuid);
    closeCurrentChat();
    renderOnlineList();
    renderContactsList();
    showToast('联系人已删除');
}

function updateChatHeaderStatus() {
    if (!currentChat) return;
    const online = onlinePeers.has(currentChat);
    const chatWs = activeChats.get(currentChat);
    const wsConnected = (chatWs && chatWs.readyState === WebSocket.OPEN) || connectedPeers.has(currentChat);

    // 在线 + 已连接 = 绿色；在线但未连接 = 黄色；离线 = 灰色
    let statusText, statusClass;
    if (online && wsConnected) {
        statusText = '🟢 已连接';
        statusClass = 'online';
    } else if (online && !wsConnected) {
        statusText = '🟡 在线（未建立聊天连接）';
        statusClass = 'online';
    } else {
        statusText = '🔴 离线';
        statusClass = 'offline';
    }
    chatPeerStatus.textContent = statusText;
    chatPeerStatus.className = statusClass;
    msgInput.disabled = !online;
    btnSend.disabled = !online;
    btnSendFile.disabled = !online;
    // 显示/隐藏断开按钮：仅当已连接时显示
    btnDisconnect.style.display = wsConnected ? '' : 'none';
}

// ===== 发送消息 =====
function sendCurrentMessage() {
    const content = msgInput.value.trim();
    if (!content || !currentChat) return;
    msgInput.value = '';

    const msgId = generateMsgId();
    const contact = contacts.get(currentChat);

    // 保存到本地联系人消息列表
    if (!contact.messages) contact.messages = [];
    contact.messages.push({
        from: 'me',
        content: content,
        msg_id: msgId,
        timestamp: new Date().toISOString(),
        status: 'sending',
    });
    renderMessages(currentChat);

    pendingMessages.set(msgId, { content, uuid: currentChat, status: 'sending' });

    // 判断发送路径：
    //   - 主动发起方：有 chat WS（直接连对方后端 /ws/chat），通过它发送
    //   - 被动接收方：没有 chat WS，通过 control WS 发给自己后端，
    //                 自己后端复用发起方建立的 chat WS 回传给对方
    const chatWs = activeChats.get(currentChat);
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
            type: 'chat',
            msg_id: msgId,
            content: content,
        }));
        // chat WS 直连绕过自己后端，需额外通知自己后端保存消息
        controlWs.send(JSON.stringify({
            type: 'save_message',
            peer_uuid: currentChat,
            sender: 'me',
            content: content,
            msg_id: msgId,
        }));
    } else {
        controlWs.send(JSON.stringify({
            type: 'chat_message',
            to_uuid: currentChat,
            msg_id: msgId,
            content: content,
        }));
    }

    // 5秒超时：没收到 ACK 则标记失败
    setTimeout(() => {
        const pending = pendingMessages.get(msgId);
        if (pending && pending.status === 'sending') {
            pending.status = 'failed';
            pendingMessages.set(msgId, pending);
            if (currentChat) renderMessages(currentChat);
        }
    }, 5000);
}

// ===== 聊天消息渲染 =====
function renderMessages(uuid) {
    chatMessages.innerHTML = '';
    const contact = contacts.get(uuid);
    if (!contact || !contact.messages) return;

    const items = contact.messages;
    for (const m of items) {
        const div = document.createElement('div');

        // 文件消息（type === 'file' 或 msg_id 以 'f_' 开头做回退检测）
        if (m.type === 'file' || (m.msg_id && typeof m.msg_id === 'string' && m.msg_id.startsWith('f_'))) {
            renderFileBubble(div, m);
            chatMessages.appendChild(div);
            continue;
        }

        // 系统消息
        if (m.from === 'system') {
            div.className = 'msg system';
            div.textContent = m.content;
            chatMessages.appendChild(div);
            continue;
        }

        // 普通文本消息
        if (m.from === 'me') {
            div.className = 'msg sent';
            const statusIcon = m.status === 'sending' ? '🕒' :
                               m.status === 'failed' ? '⚠️' : '✓';
            const statusClass = m.status === 'sending' ? 'status-sending' :
                                m.status === 'failed' ? 'status-failed' : 'status-sent';
            div.innerHTML = `${esc(m.content)}<div class="time">${fmtTime(m.timestamp)} <span class="status ${statusClass}">${statusIcon}</span></div>`;
        } else {
            div.className = 'msg received';
            div.innerHTML = `${esc(m.content)}<div class="time">${fmtTime(m.timestamp)}</div>`;
        }
        chatMessages.appendChild(div);
    }
    // requestAnimationFrame 确保 flex 布局计算完成后再滚到底部
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

/** 渲染文件消息气泡 */
function renderFileBubble(container, msg) {
    const isSent = msg.direction === 'send' || msg.from === 'me';
    container.className = `msg file-msg ${isSent ? 'sent' : 'received'}`;

    // 兼容旧数据：从 transfer_id 或 msg_id 推导 transfer_id
    const transferId = msg.transfer_id || (msg.msg_id && msg.msg_id.startsWith('f_t_') ? msg.msg_id.slice(2) : '');
    const fileName = msg.file_name || '未知文件';
    const fileSize = msg.file_size || 0;
    const status = msg.status || 'failed';
    const progress = msg.progress || 0;

    let statusText = '';
    if (status === 'waiting') statusText = '等待对方确认...';
    else if (status === 'uploading') statusText = `发送中 ${progress}%`;
    else if (status === 'downloading') statusText = `接收中 ${progress}%`;
    else if (status === 'complete') statusText = isSent ? '发送完成 ✓' : '接收完成 ✓';
    else if (status === 'failed') statusText = '传输失败 ✗';
    else if (status === 'cancelled') statusText = '已取消';

    const showProgress = status === 'uploading' || status === 'downloading' || status === 'waiting';
    const showOpen = status === 'complete' && !isSent;

    let actionHtml = '';
    if (showOpen) {
        actionHtml = `<button class="btn-open-file" onclick="openDownloadedFile('${escAttr(fileName)}')">📂 打开文件</button>`;
    }

    container.innerHTML = `
        <div class="file-card">
            <div class="file-icon">📄</div>
            <div class="file-info">
                <div class="file-name">${esc(fileName)}</div>
                <div class="file-size">${formatSize(fileSize)}</div>
                ${showProgress ? `
                <div class="file-progress-bar">
                    <div class="file-progress-fill" style="width:${progress}%"></div>
                </div>` : ''}
                <div class="file-status">${statusText}</div>
                ${actionHtml}
            </div>
        </div>
        <div class="file-time">${fmtTime(msg.timestamp)}</div>
    `;
}

function addSystemMessage(uuid, text) {
    if (!contacts.has(uuid)) return;
    contacts.get(uuid).messages.push({
        from: 'system',
        content: text,
        msg_id: generateMsgId(),
        timestamp: new Date().toISOString(),
    });
    if (currentChat === uuid) renderMessages(uuid);
}

// ===== 文件传输 =====

function onFileSelected() {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file || !currentChat) return;
    sendFile(currentChat, file);
}

/**
 * 发送文件：添加文件消息气泡 → 发 file_request → 等对方响应后自动开始上传。
 */
async function sendFile(uuid, file) {
    const CHUNK_SIZE = 64 * 1024; // 64KB
    const transferId = 't_' + myInfo.uuid + '_' + Date.now();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 在聊天中插入文件消息气泡（初始状态：等待确认）
    const contact = contacts.get(uuid);
    if (!contact.messages) contact.messages = [];
    const fileMsg = {
        from: 'me',
        type: 'file',
        msg_id: 'f_' + transferId,
        timestamp: new Date().toISOString(),
        file_name: file.name,
        file_size: file.size,
        transfer_id: transferId,
        direction: 'send',
        status: 'waiting',
        progress: 0,
    };
    contact.messages.push(fileMsg);
    renderMessages(uuid);

    // 持久化文件消息
    saveFileMessage(uuid, fileMsg);

    // 注册待处理传输
    pendingFileTransfers[transferId] = {
        file: file,
        uuid: uuid,
        totalChunks: totalChunks,
        CHUNK_SIZE: CHUNK_SIZE,
        transferId: transferId,
        currentChunk: 0,
        started: false,
    };

    const fileRequestMsg = {
        transfer_id: transferId,
        file_name: file.name,
        file_size: file.size,
        chunk_size: CHUNK_SIZE,
        total_chunks: totalChunks,
        resume: false,
    };

    // 优先走直连 chat WS；没有则回退到 control WS 转发
    const ws = activeChats.get(uuid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'file_request', ...fileRequestMsg }));
    } else {
        // 回退路径：通过 control WS → 自己后端 → 转发给对端
        controlWs.send(JSON.stringify({
            type: 'file_request',
            to_uuid: uuid,
            ...fileRequestMsg,
        }));
    }
}

/**
 * 开始分片上传文件到对方后端。
 * 每发送一个分片后更新聊天气泡中的进度。
 */
async function startChunkUpload(transferId) {
    const t = pendingFileTransfers[transferId];
    if (!t) return;

    const fileMsg = findFileMsgByTransferId(transferId);
    if (fileMsg) {
        fileMsg.status = 'uploading';
        saveFileMessage(t.uuid, fileMsg);
        if (currentChat === t.uuid) renderMessages(t.uuid);
    }

    const peer = onlinePeers.get(t.uuid);
    if (!peer) {
        showToast('对方不在线，无法发送文件');
        if (fileMsg) {
            fileMsg.status = 'failed';
            saveFileMessage(t.uuid, fileMsg);
            if (currentChat === t.uuid) renderMessages(t.uuid);
        }
        delete pendingFileTransfers[transferId];
        return;
    }

    const file = t.file;
    const CHUNK_SIZE = t.CHUNK_SIZE;
    const totalChunks = t.totalChunks;
    const peerPort = peer.ws_port || 50002;

    for (let i = t.currentChunk; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);
        const dataB64 = await readAsBase64(blob);

        let retries = 0;
        let success = false;

        while (retries < 3 && !success) {
            try {
                const resp = await fetch(`http://${peer.ip}:${peerPort}/api/transfer/chunk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transfer_id: transferId,
                        chunk_index: i,
                        data: dataB64,
                    }),
                });
                if (resp.ok) {
                    success = true;
                    t.currentChunk = i + 1;
                    // 更新进度条
                    if (fileMsg) {
                        fileMsg.progress = Math.round((i + 1) / totalChunks * 100);
                        if (currentChat === t.uuid) renderMessages(t.uuid);
                    }
                } else {
                    retries++;
                }
            } catch (e) {
                retries++;
            }
        }

        if (!success) {
            if (fileMsg) {
                fileMsg.status = 'failed';
                saveFileMessage(t.uuid, fileMsg);
                if (currentChat === t.uuid) renderMessages(t.uuid);
            }
            delete pendingFileTransfers[transferId];
            return; // 传输中断
        }
    }

    // 所有分片发送完毕 → 通知对方合并
    try {
        await fetch(`http://${peer.ip}:${peerPort}/api/transfer/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transfer_id: transferId }),
        });
        if (fileMsg) {
            fileMsg.status = 'complete';
            fileMsg.progress = 100;
            saveFileMessage(t.uuid, fileMsg);
            if (currentChat === t.uuid) renderMessages(t.uuid);
        }
    } catch (e) {
        if (fileMsg) {
            fileMsg.status = 'failed';
            saveFileMessage(t.uuid, fileMsg);
            if (currentChat === t.uuid) renderMessages(t.uuid);
        }
    }

    delete pendingFileTransfers[transferId];
}

function readAsBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            // 去掉 "data:...;base64," 前缀
            const b64 = result.split(',')[1] || result;
            resolve(b64);
        };
        reader.readAsDataURL(blob);
    });
}

// ===== 文件传输弹窗 =====

function showFileRequestModal(msg) {
    fileModalTitle.textContent = '文件传输请求';
    fileModalBody.innerHTML = `
        <p><strong>${esc(msg.from_name)}</strong> 想发送文件:</p>
        <p>📄 ${esc(msg.file_name)} (${formatSize(msg.file_size)})</p>`;
    fileModalButtons.innerHTML = `
        <button id="btn-file-accept" class="btn-primary">接收</button>
        <button id="btn-file-reject">拒绝</button>`;
    fileModalOverlay.style.display = '';

    $('btn-file-accept').addEventListener('click', () => {
        // 发送接受响应
        controlWs.send(JSON.stringify({
            type: 'file_response',
            transfer_id: msg.transfer_id,
            accepted: true,
        }));

        // 在聊天中插入接收文件消息气泡
        const uuid = msg.from_uuid;
        if (!contacts.has(uuid)) {
            contacts.set(uuid, { name: msg.from_name, ip: '', status: 'online', messages: [] });
        }
        const contact = contacts.get(uuid);
        const fileMsg = {
            from: uuid,
            type: 'file',
            msg_id: 'f_' + msg.transfer_id,
            timestamp: new Date().toISOString(),
            file_name: msg.file_name,
            file_size: msg.file_size,
            transfer_id: msg.transfer_id,
            direction: 'receive',
            status: 'downloading',
            progress: 0,
        };
        contact.messages.push(fileMsg);
        // 持久化文件消息
        saveFileMessage(uuid, fileMsg);
        if (currentChat === uuid) {
            renderMessages(uuid);
        } else {
            openChat(uuid);
        }

        fileModalOverlay.style.display = 'none';
    });

    $('btn-file-reject').addEventListener('click', () => {
        controlWs.send(JSON.stringify({
            type: 'file_response',
            transfer_id: msg.transfer_id,
            accepted: false,
        }));
        fileModalOverlay.style.display = 'none';
    });
}

// ===== 文件传输辅助函数 =====

/** 根据 transfer_id 在所有联系人的消息中查找文件消息 */
function findFileMsgByTransferId(transferId) {
    for (const [uuid, contact] of contacts) {
        if (contact.messages) {
            // 从后往前找（文件消息通常在末尾）
            for (let i = contact.messages.length - 1; i >= 0; i--) {
                if (contact.messages[i].transfer_id === transferId) {
                    return contact.messages[i];
                }
            }
        }
    }
    return null;
}

/** 持久化文件消息到后端 contacts.json（里程碑状态变化时调用，避免每次进度更新都写盘） */
function saveFileMessage(peerUuid, fileMsg) {
    if (!peerUuid || !fileMsg || !fileMsg.msg_id) return;
    controlWs.send(JSON.stringify({
        type: 'save_message',
        msg_type: 'file',
        peer_uuid: peerUuid,
        sender: fileMsg.from === 'me' ? 'me' : peerUuid,
        content: '',
        msg_id: fileMsg.msg_id,
        file_name: fileMsg.file_name,
        file_size: fileMsg.file_size,
        transfer_id: fileMsg.transfer_id,
        status: fileMsg.status,
        progress: fileMsg.progress || 0,
    }));
}

/** 接收方点击"打开文件"，通过 API 下载/预览 */
function openDownloadedFile(fileName) {
    window.open(`/api/downloads/${encodeURIComponent(fileName)}`, '_blank');
}

// ===== 昵称编辑弹窗 =====
function showEditNameModal() {
    modalNameInput.value = myInfo.name;
    modalOverlay.style.display = '';
    modalNameInput.focus();
}
function hideEditNameModal() {
    modalOverlay.style.display = 'none';
}
function saveName() {
    const newName = modalNameInput.value.trim();
    if (!newName || newName === myInfo.name) {
        hideEditNameModal();
        return;
    }
    controlWs.send(JSON.stringify({ type: 'update_name', name: newName }));
    myInfo.name = newName;
    $('my-name-label').textContent = newName;
    hideEditNameModal();
}

// ===== 工具函数 =====
function generateMsgId() {
    return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
/** HTML 属性值转义（用于 onclick="openDownloadedFile('...')" 等场景） */
function escAttr(text) {
    return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
function fmtTime(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
}
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}
function showToast(text) {
    // 简单的 toast 提示
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:60px;right:20px;background:#333;color:#fff;padding:10px 20px;border-radius:6px;z-index:200;font-size:13px;animation:fadeOut 2s forwards';
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2200);
}

// ===== 启动 =====
init();
