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
 */

// ===== 全局状态 =====
let myInfo = null;
let onlinePeers = new Map();
let contacts = new Map();
let pendingRequests = new Map();
let activeChats = new Map();
let currentChat = null;
let pendingMessages = new Map();
let controlWs = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

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
    btnDeleteContact.addEventListener('click', deleteCurrentContact);
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
        chat_message: handleIncomingMessage,
        message_ack: handleMessageAck,
        send_failed: handleSendFailed,
        incoming_file_request: handleIncomingFileRequest,
        file_request_response: handleFileRequestResponse,
        transfer_progress: handleTransferProgress,
        transfer_complete: handleTransferComplete,
        transfer_cancelled: handleTransferCancelled,
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
    // county 可能在 pending 列表被其他地方修改后推送
    if (msg.count === 0) pendingRequests.clear();
}

function handleConnectionEstablished(msg) {
    pendingRequests.delete(msg.uuid);
    // 加入联系人
    contacts.set(msg.uuid, {
        name: msg.name,
        ip: msg.ip,
        status: 'online',
        messages: [],
    });
    renderPendingList();
    renderContactsList();
    // 如果正在等对方的确认（主动发起方），打开聊天
    if (currentChat === msg.uuid || !currentChat) {
        openChat(msg.uuid);
    }
}

function handlePeerDisconnected(msg) {
    activeChats.delete(msg.uuid);
    pendingRequests.delete(msg.uuid);
    renderPendingList();
    if (currentChat === msg.uuid) {
        updateChatHeaderStatus();
        addSystemMessage(msg.uuid, `${msg.name || '对方'} 已断开连接`);
    }
}

function handleIncomingMessage(msg) {
    const uuid = msg.from;
    // 保存消息到联系人
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

function handleFileRequestResponse(msg) {
    if (msg.accepted) {
        console.log(`[Transfer] 对方接受传输: ${msg.transfer_id}`);
    } else {
        showToast('对方拒绝了文件传输');
    }
}

function handleTransferProgress(msg) {
    // 更新传输进度（可在聊天区或侧边栏展示进度条）
    console.log(`[Transfer] 进度: ${msg.received_bytes}/${msg.total_bytes}`);
}

function handleTransferComplete(msg) {
    showToast(`文件接收完成: ${msg.file_name}`);
    addSystemMessage(currentChat, `文件 ${msg.file_name} 接收完成 ✓`);
}

function handleTransferCancelled(msg) {
    showToast('对方取消了文件传输');
    addSystemMessage(currentChat, '文件传输已取消');
}

// ===== 在线列表渲染 =====
function updateOnlinePeers(peers) {
    onlinePeers.clear();
    for (const p of peers) {
        // 保存 token，用于建立连接时出示给对方后端验证
        onlinePeers.set(p.uuid, { name: p.name, ip: p.ip, ws_port: p.ws_port, token: p.token });
    }
    renderOnlineList();
    // 同时刷新联系人列表的状态（在线/离线圆点）
    renderContactsList();
    updateChatHeaderStatus();
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
        div.innerHTML = `
            <span class="dot online"></span>
            <div class="info">
                <div class="name">${esc(peer.name)}</div>
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
        const statusText = isOnline ? '' : ' (离线)';
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
            }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connect_accepted') {
                activeChats.set(uuid, ws);
                setupPeerMessageHandler(uuid, ws);
                addSystemMessage(uuid, '连接已建立');
                // 通知自己后端保存联系人（对方后端已保存，自己后端也需要记录）
                controlWs.send(JSON.stringify({
                    type: 'save_contact',
                    uuid: uuid,
                    name: name,
                    ip: ip,
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

/** 为对端 WS 设置消息处理器（收到 connect_accepted 后调用） */
function setupPeerMessageHandler(uuid, ws) {
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') {
            // 对方发来的聊天消息（直接从 ws 收到时也需要处理）
            handleDirectChatMessage(uuid, msg);
        } else if (msg.type === 'file_response') {
            handleFileRequestResponse(msg);
        } else if (msg.type === 'file_cancel') {
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

function updateChatHeaderStatus() {
    if (!currentChat) return;
    const online = onlinePeers.has(currentChat);
    chatPeerStatus.textContent = online ? '🟢 在线' : '🔴 离线';
    chatPeerStatus.className = online ? 'online' : 'offline';
    msgInput.disabled = !online;
    btnSend.disabled = !online;
    btnSendFile.disabled = !online;
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
    chatMessages.scrollTop = chatMessages.scrollHeight;
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

async function sendFile(uuid, file) {
    const CHUNK_SIZE = 64 * 1024; // 64KB
    const transferId = 't_' + myInfo.uuid + '_' + Date.now();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 通过聊天 WS 发 file_request
    const ws = activeChats.get(uuid);
    if (!ws) {
        showToast('未连接到对方，请先建立聊天');
        return;
    }

    ws.send(JSON.stringify({
        type: 'file_request',
        transfer_id: transferId,
        file_name: file.name,
        file_size: file.size,
        chunk_size: CHUNK_SIZE,
        total_chunks: totalChunks,
        resume: false,
    }));

    // 等待 file_response（通过 control ws 回调继续）
    addSystemMessage(uuid, `发送文件: ${file.name} (${formatSize(file.size)})`);

    // 开始发送分片
    window._pendingFileTransfers = window._pendingFileTransfers || {};
    window._pendingFileTransfers[transferId] = { file, uuid, totalChunks, CHUNK_SIZE, transferId, currentChunk: 0 };

    // 等待对方响应后开始发送分片
    const originalHandler = handleFileRequestResponse;
    const onceHandler = (msg) => {
        if (msg.transfer_id === transferId) {
            if (msg.accepted) {
                startChunkUpload(transferId);
            }
            // 恢复原始处理器
            window._fileResponseHandler = originalHandler;
        }
    };
    window._fileResponseHandler = (msg) => {
        originalHandler(msg);
        onceHandler(msg);
    };
}

function handleFileRequestResponse(msg) {
    if (window._fileResponseHandler) {
        window._fileResponseHandler(msg);
    } else if (msg.accepted) {
        // 查找匹配的传输并开始上传
        const transfers = window._pendingFileTransfers || {};
        for (const [tid, t] of Object.entries(transfers)) {
            if (!t.started) {
                t.started = true;
                startChunkUpload(tid);
                break;
            }
        }
    }
}

async function startChunkUpload(transferId) {
    const t = window._pendingFileTransfers?.[transferId];
    if (!t) return;

    const peer = onlinePeers.get(t.uuid);
    if (!peer) {
        showToast('对方不在线，无法发送文件');
        return;
    }

    const file = t.file;
    const CHUNK_SIZE = t.CHUNK_SIZE;
    const totalChunks = t.totalChunks;

    for (let i = t.currentChunk; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);
        const dataB64 = await readAsBase64(blob);

        let retries = 0;
        let success = false;

        while (retries < 3 && !success) {
            try {
                const peerPort = peer.ws_port || 50002;
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
                } else {
                    retries++;
                }
            } catch (e) {
                retries++;
            }
        }

        if (!success) {
            addSystemMessage(t.uuid, '文件传输中断，等待对方重新上线');
            return; // 传输暂停，等待后续续传
        }
    }

    // 完成
    try {
        const peerPort = peer.ws_port || 50002;
        await fetch(`http://${peer.ip}:${peerPort}/api/transfer/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transfer_id: transferId }),
        });
        addSystemMessage(t.uuid, `文件 ${file.name} 发送完成 ✓`);
    } catch (e) {
        addSystemMessage(t.uuid, '文件传输完成确认失败');
    }

    delete window._pendingFileTransfers?.[transferId];
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
        controlWs.send(JSON.stringify({
            type: 'file_response',
            transfer_id: msg.transfer_id,
            accepted: true,
        }));
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
