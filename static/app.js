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

/** Chat WS 已建立且未断开；会话态只认此状态，与 UDP 发现无关 */
function isPeerConnected(uuid) {
    const chatWs = activeChats.get(uuid);
    return (chatWs && chatWs.readyState === WebSocket.OPEN) || connectedPeers.has(uuid);
}

/** UDP 发现：仅表示局域网内可见，用于未连接时的在线列表与发起连接 */
function isPeerDiscoverable(uuid) {
    return onlinePeers.has(uuid);
}

/** 获取对端地址：已连接时用 contacts 缓存，未连接时用 UDP 在线列表 */
function getPeerEndpoint(uuid) {
    const fromOnline = onlinePeers.get(uuid);
    const fromContact = contacts.get(uuid);
    if (isPeerConnected(uuid) && fromContact) {
        return {
            name: fromContact.name || fromOnline?.name || 'Unknown',
            ip: fromContact.ip || fromOnline?.ip || '',
            ws_port: fromContact.ws_port || fromOnline?.ws_port || 50002,
        };
    }
    return fromOnline || fromContact || null;
}
let pendingMessages = new Map();
let controlWs = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// ===== sessionStorage：刷新后记住连接状态 =====
const SS_PREFIX = 'lanchat_conn_';

function markConnected(uuid) {
    try { sessionStorage.setItem(SS_PREFIX + uuid, '1'); } catch (e) { /* ignore */ }
}

function markDisconnected(uuid) {
    try { sessionStorage.removeItem(SS_PREFIX + uuid); } catch (e) { /* ignore */ }
}

function getStoredConnectedPeers() {
    const peers = [];
    try {
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && key.startsWith(SS_PREFIX)) {
                peers.push(key.slice(SS_PREFIX.length));
            }
        }
    } catch (e) { /* ignore */ }
    return peers;
}

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
const chatConnectBar = $('chat-connect-bar');
const btnChatConnect = $('btn-chat-connect');
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
    btnChatConnect.addEventListener('click', () => {
        if (!currentChat) return;
        const peer = onlinePeers.get(currentChat) || contacts.get(currentChat);
        if (peer) connectToPeer(currentChat, peer.name, peer.ip);
    });
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

    // 文件续传按钮（事件委托）
    chatMessages.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-retry-file');
        if (btn) {
            const transferId = btn.dataset.transferId;
            if (transferId) retryFileTransfer(transferId);
        }
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
        contact_deleted: handleContactDeleted,
        contact_untrusted: handleContactUntrusted,
        connection_timeout: handleConnectionTimeout,
        connection_idle_close: handleConnectionIdleClose,
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

    // 步骤3：自动重连刷新前已建立的连接（双重来源）
    //   来源A — sessionStorage：本浏览器侧记忆，刷新不丢失
    //   来源B — active_peers：后端记录，对端浏览器仍连着本后端的 chat WS
    const toReconnect = new Set();
    for (const uuid of getStoredConnectedPeers()) {
        toReconnect.add(uuid);
    }
    if (msg.active_peers && msg.active_peers.length > 0) {
        for (const uuid of msg.active_peers) {
            toReconnect.add(uuid);
        }
    }
    for (const peerUuid of toReconnect) {
        autoReconnect(peerUuid);
    }
}

function handlePeerOnline(msg) {
    // 过滤自己
    if (msg.uuid === myInfo.uuid) return;
    onlinePeers.set(msg.uuid, { name: msg.name, ip: msg.ip, ws_port: msg.ws_port, token: msg.token });
    // 如果历史联系人里有，同步更新在线状态、昵称和 IP（对方可能换了 IP 或改了昵称）
    if (contacts.has(msg.uuid)) {
        contacts.get(msg.uuid).status = 'online';
        if (msg.name) contacts.get(msg.uuid).name = msg.name;
        if (msg.ip) contacts.get(msg.uuid).ip = msg.ip;
    }
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
}

function handlePeerOffline(msg) {
    onlinePeers.delete(msg.uuid);
    // 已建立 Chat 连接时，UDP offline 不影响联系人/会话状态
    if (contacts.has(msg.uuid) && !isPeerConnected(msg.uuid)) {
        contacts.get(msg.uuid).status = 'offline';
    }
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
    if (!isPeerConnected(msg.uuid)) {
        addSystemMessage(msg.uuid, `${msg.name} 已下线`);
    }
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
    markConnected(msg.uuid);
    // 只在 contacts 中不存在时才新建，否则保留已有消息（避免覆盖聊天记录）
    if (!contacts.has(msg.uuid)) {
        contacts.set(msg.uuid, {
            name: msg.name,
            ip: msg.ip,
            status: 'online',
            messages: [],
        });
    } else {
        const c = contacts.get(msg.uuid);
        c.name = msg.name;
        c.ip = msg.ip;
        c.status = 'online';
    }
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
    markDisconnected(msg.uuid);
    pendingRequests.delete(msg.uuid);
    // 中止与该对端的所有进行中文件上传
    abortTransfersForPeer(msg.uuid);
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
    markDisconnected(msg.uuid);
    renderOnlineList();
    renderContactsList();
    if (currentChat === msg.uuid) {
        updateChatHeaderStatus();
        addSystemMessage(msg.uuid, '你已断开连接');
    }
}

/** 后端确认联系人已删除 → 清理前端关联状态（本端删除） */
function handleContactDeleted(msg) {
    const uuid = msg.uuid;
    activeChats.delete(uuid);
    connectedPeers.delete(uuid);
    markDisconnected(uuid);
    pendingRequests.delete(uuid);
    contacts.delete(uuid);
    // 清理进行中的文件传输
    abortTransfersForPeer(uuid);
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) delete pendingFileTransfers[tid];
    }
    renderOnlineList();
    renderContactsList();
    renderPendingList();
    if (currentChat === uuid) {
        closeCurrentChat();
    }
}

/** 对端删除了我们 → 标记为不可信（保留历史，断开连接） */
function handleContactUntrusted(msg) {
    const uuid = msg.uuid;
    // 断开连接但保留联系人数据
    const chatWs = activeChats.get(uuid);
    if (chatWs) {
        try { chatWs.close(); } catch (e) { /* ignore */ }
    }
    activeChats.delete(uuid);
    connectedPeers.delete(uuid);
    markDisconnected(uuid);
    pendingRequests.delete(uuid);
    // 标记本地 contacts 中的 trusted=false（重新渲染时显示状态）
    const contact = contacts.get(uuid);
    if (contact) {
        contact.trusted = false;
    }
    // 中止进行中的文件传输
    abortTransfersForPeer(uuid);
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) delete pendingFileTransfers[tid];
    }
    renderOnlineList();
    renderContactsList();
    renderPendingList();
    if (currentChat === uuid) {
        updateChatHeaderStatus();
    }
}

/** 连接请求超时（1分钟内用户未操作）→ 清理待处理请求 */
function handleConnectionTimeout(msg) {
    pendingRequests.delete(msg.uuid);
    renderPendingList();
    showToast(`${msg.name || '对方'} 的连接请求已超时取消`);
}

/** 空闲超时关闭（10分钟无消息且无文件传输）→ 清理连接状态 */
function handleConnectionIdleClose(msg) {
    const uuid = msg.uuid;
    activeChats.delete(uuid);
    connectedPeers.delete(uuid);
    abortTransfersForPeer(uuid);
    markDisconnected(uuid);
    renderOnlineList();
    renderContactsList();
    if (currentChat === uuid) {
        updateChatHeaderStatus();
        addSystemMessage(uuid, '连接因长时间无活动已自动关闭');
    }
    showToast(`${msg.name || '对方'} 连接已因空闲超时关闭`);
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
    // 续传：自动接受，不弹窗
    if (msg.resume) {
        autoAcceptResumeTransfer(msg);
        return;
    }
    showFileRequestModal(msg);
}

/** 续传自动接受（不弹窗），更新已有文件气泡或插入新气泡 */
function autoAcceptResumeTransfer(msg) {
    // 发送接受响应
    controlWs.send(JSON.stringify({
        type: 'file_response',
        transfer_id: msg.transfer_id,
        accepted: true,
    }));

    const uuid = msg.from_uuid;
    if (!contacts.has(uuid)) {
        contacts.set(uuid, { name: msg.from_name, ip: '', status: 'online', messages: [] });
    }
    const contact = contacts.get(uuid);
    const msgId = 'f_' + msg.transfer_id;
    const existingIdx = contact.messages.findIndex(m => m.msg_id === msgId);
    if (existingIdx >= 0) {
        // 续传：更新已有消息，保留旧进度（不重置为0）
        contact.messages[existingIdx].status = 'downloading';
        // progress 保持中断前的值，后续由 transfer_progress 更新
        saveFileMessage(uuid, contact.messages[existingIdx]);
    } else {
        const fileMsg = {
            from: uuid,
            type: 'file',
            msg_id: msgId,
            timestamp: new Date().toISOString(),
            file_name: msg.file_name,
            file_size: msg.file_size,
            transfer_id: msg.transfer_id,
            direction: 'receive',
            status: 'downloading',
            progress: 0,
        };
        contact.messages.push(fileMsg);
        saveFileMessage(uuid, fileMsg);
    }
    if (currentChat === uuid) {
        renderMessages(uuid);
    } else {
        openChat(uuid);
    }
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
        const result = findFileMsgByTransferId(transferId);
        if (result) {
            result.msg.status = 'failed';
            // 通过 transferId 找到对应的联系人 uuid
            saveFileMessage(t.uuid, result.msg);
            if (currentChat) renderMessages(currentChat);
        }
        showToast('对方拒绝了文件传输');
    }
}

function handleTransferProgress(msg) {
    // 接收方：更新文件消息进度
    const result = findFileMsgByTransferId(msg.transfer_id);
    if (result && msg.total_bytes > 0) {
        result.msg.progress = Math.round(msg.received_bytes / msg.total_bytes * 100);
        if (currentChat) renderMessages(currentChat);
    }
}

function handleTransferComplete(msg) {
    // 接收方：传输完成
    const result = findFileMsgByTransferId(msg.transfer_id);
    if (result) {
        const { msg: fileMsg, peerUuid } = result;
        fileMsg.status = msg.verified ? 'complete' : 'failed';
        fileMsg.progress = 100;
        saveFileMessage(peerUuid, fileMsg);
        if (currentChat === peerUuid) renderMessages(currentChat);
    }
    if (msg.verified) {
        showToast(`文件接收完成: ${msg.file_name}`);
    } else {
        showToast(`文件校验失败: ${msg.file_name}`);
    }
}

function handleTransferCancelled(msg) {
    const result = findFileMsgByTransferId(msg.transfer_id);
    if (result) {
        const { msg: fileMsg, peerUuid } = result;
        fileMsg.status = 'cancelled';
        saveFileMessage(peerUuid, fileMsg);
        if (currentChat === peerUuid) renderMessages(currentChat);
    }
    // 清理上传方状态
    if (pendingFileTransfers[msg.transfer_id]) {
        delete pendingFileTransfers[msg.transfer_id];
    }
    showToast('文件传输已取消');
}

function handleTransferResumed(msg) {
    // 续传恢复通知 — 不做额外弹窗，进度条会在 transfer_progress 中更新
    const result = findFileMsgByTransferId(msg.transfer_id);
    if (result) {
        result.msg.status = 'downloading';
        // 持久化状态变更（里程碑切换：failed/cancelled → downloading）
        saveFileMessage(result.peerUuid, result.msg);
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
        const isConnected = getConnectionLabel(uuid) !== '';
        const connLabel = isConnected ? ' 🔗已连接' : '';
        const connBtn = isConnected ? '' :
            `<button class="btn-connect" data-uuid="${uuid}">连接</button>`;
        div.innerHTML = `
            <span class="dot online"></span>
            <div class="info">
                <div class="name">${esc(peer.name)}${connLabel}</div>
                <div class="sub">${esc(peer.ip)}</div>
            </div>
            ${connBtn}`;
        // 点击主体区域 → 打开聊天（不连接）
        div.querySelector('.info')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChat(uuid);
        });
        div.querySelector('.dot')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChat(uuid);
        });
        // 点击连接按钮 → 发起连接
        if (!isConnected) {
            div.querySelector('.btn-connect').addEventListener('click', (e) => {
                e.stopPropagation();
                connectToPeer(uuid, peer.name, peer.ip);
            });
        }
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
        const peer = onlinePeers.get(uuid) || { name: 'Unknown', ip: '', ws_port: 50002 };
        // 保留已有消息（若联系人已存在），避免覆盖聊天记录
        if (!contacts.has(uuid)) {
            contacts.set(uuid, { name: peer.name, ip: peer.ip, status: 'online', trusted: true, messages: [] });
        } else {
            const existing = contacts.get(uuid);
            existing.name = peer.name;
            existing.ip = peer.ip;
            existing.status = 'online';
            existing.trusted = true;
        }
        controlWs.send(JSON.stringify({
            type: 'save_contact',
            uuid: uuid,
            name: peer.name,
            ip: peer.ip,
            ws_port: peer.ws_port || 50002,
        }));
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
                ws_port: c.ws_port || 50002,
                status: isPeerConnected(c.uuid) ? 'online' : c.status,
                trusted: c.trusted !== false,  // 默认 true，兼容旧数据
                messages: [],
            });
        } else {
            if (!isPeerConnected(c.uuid)) {
                contacts.get(c.uuid).status = c.status;
            }
            contacts.get(c.uuid).name = c.name || contacts.get(c.uuid).name;
            contacts.get(c.uuid).ip = c.ip || contacts.get(c.uuid).ip;
            if (c.ws_port) contacts.get(c.uuid).ws_port = c.ws_port;
            if (c.trusted !== undefined) {
                contacts.get(c.uuid).trusted = c.trusted;
            }
        }
    }
    renderContactsList();
    updateChatHeaderStatus();
}

function renderContactsList() {
    const list = Array.from(contacts.entries())
        .sort((a, b) => {
            const aConn = isPeerConnected(a[0]);
            const bConn = isPeerConnected(b[0]);
            if (aConn !== bConn) return aConn ? -1 : 1;
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
        // UDP 发现仅用于未连接时的在线指示；已连接优先显示会话态
        const isConnected = isPeerConnected(uuid);
        const isDiscoverable = isPeerDiscoverable(uuid);
        const dotClass = isConnected ? 'online' : (isDiscoverable ? 'online' : 'offline');
        const connLabel = isConnected ? ' 🔗已连接' : '';
        const statusText = isConnected ? connLabel : (isDiscoverable ? '' : ' (离线)');
        const connBtn = (isDiscoverable && !isConnected) ?
            `<button class="btn-connect" data-uuid="${uuid}">连接</button>` : '';
        div.innerHTML = `
            <span class="dot ${dotClass}"></span>
            <div class="info">
                <div class="name">${esc(contact.name)}${statusText}</div>
                <div class="sub">${esc(contact.ip)}</div>
            </div>
            ${connBtn}`;
        // 点击主体区域 → 打开聊天（不连接）
        div.querySelector('.info')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChat(uuid);
        });
        div.querySelector('.dot')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChat(uuid);
        });
        // 点击连接按钮 → 发起连接
        if (isDiscoverable && !isConnected) {
            div.querySelector('.btn-connect').addEventListener('click', (e) => {
                e.stopPropagation();
                connectToPeer(uuid, contact.name, contact.ip);
            });
        }
        // 右键删除
        div.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            // 先检查是否有正在进行的文件传输，有则阻止删除
            if (hasActiveTransferWithPeer(uuid)) {
                showCenterToast('有文件正在传输，请等待传输完成或取消后再删除联系人');
                return;
            }
            const ok = await showConfirmModal(
                '删除联系人',
                `确定删除联系人 ${contact.name} 及聊天记录？此操作不可恢复。`,
                '删除',
                true
            );
            if (ok) deleteContact(uuid);
        });
        contactsList.appendChild(div);
    }
}

async function deleteContact(uuid) {
    // 清理所有与该对端的连接和状态（与 deleteCurrentContact 一致）
    const chatWs = activeChats.get(uuid);
    if (chatWs) {
        try { chatWs.close(); } catch (e) { /* ignore */ }
    }
    abortTransfersForPeer(uuid);
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) delete pendingFileTransfers[tid];
    }
    activeChats.delete(uuid);
    connectedPeers.delete(uuid);
    markDisconnected(uuid);
    pendingRequests.delete(uuid);

    // 通知后端删除联系人（后端会先通知对端，再关闭连接，最后删数据）
    try {
        controlWs.send(JSON.stringify({ type: 'delete_contact', uuid: uuid }));
    } catch (e) { /* ignore */ }

    contacts.delete(uuid);
    if (currentChat === uuid) closeCurrentChat();
    renderOnlineList();
    renderContactsList();
    renderPendingList();
    showToast('联系人已删除');
}

// ===== 连接对端 / 打开聊天 =====

/**
 * 自动重连：浏览器刷新后恢复之前的连接状态。
 * 与 connectToPeer 区别：对端后端会识别出已知联系人并自动接受，无需对端用户确认。
 */
async function autoReconnect(uuid) {
    // 不重复连接
    if (activeChats.has(uuid)) return;

    const peer = onlinePeers.get(uuid) || contacts.get(uuid);
    if (!peer || !peer.ip) return; // 无地址信息，无法重连

    const name = peer.name;
    const ip = peer.ip;
    const wsPort = peer.ws_port || 50002;

    // 连接前刷新自己的 token
    try {
        const resp = await fetch('/api/me');
        const me = await resp.json();
        myInfo.token = me.token;
    } catch (e) { /* 刷新失败则用现有 token */ }

    try {
        const wsUrl = `ws://${ip}:${wsPort}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'connect_request',
                uuid: myInfo.uuid,
                name: myInfo.name,
                token: myInfo.token,
                ip: myInfo.ip,
                ws_port: myInfo.ws_port,
                have_you: contacts.has(uuid),
            }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connect_accepted') {
                activeChats.set(uuid, ws);
                connectedPeers.add(uuid);
                markConnected(uuid);
                setupPeerMessageHandler(uuid, ws);
                updateChatHeaderStatus();
                renderOnlineList();
                renderContactsList();
            } else if (msg.type === 'connect_rejected') {
                ws.close();
                const reasonText = msg.reason === 'timeout' ? '超时' : (msg.reason || '拒绝');
                console.log('[AutoReconnect] 自动重连被拒绝:', uuid, reasonText);
            }
        };

        ws.onclose = () => {
            activeChats.delete(uuid);
            connectedPeers.delete(uuid);
            markDisconnected(uuid);
            // 中止与该对端的所有进行中文件上传（接收方断开时也要停止发送）
            abortTransfersForPeer(uuid);
            renderOnlineList();
            renderContactsList();
            if (currentChat === uuid) {
                addSystemMessage(uuid, '连接已断开');
                updateChatHeaderStatus();
            }
        };

        ws.onerror = () => {
            activeChats.delete(uuid);
            markDisconnected(uuid);
            ws.close();
        };

    } catch (e) {
        console.log('[AutoReconnect] 自动重连失败:', uuid, e.message);
    }
}

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

    // 打开聊天窗口之前记录：自己历史里是否还保留着对方（openChat 可能把刚删除的
    // 联系人重新加回 Map，导致误判），用于告诉对方是否需要重新验证
    const haveYou = contacts.has(uuid);

    openChat(uuid); // 先打开聊天窗口，显示"连接中..."

    // 连接前先刷新自己的 token（token 每 3 秒更新，避免用过期的）
    try {
        const resp = await fetch('/api/me');
        const me = await resp.json();
        myInfo.token = me.token;
    } catch (e) { /* 刷新失败则用现有 token */ }

    try {
        const peerPort = peer.ws_port || 50002;
        const wsUrl = `ws://${peer.ip}:${peerPort}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        let connectTimeout = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                activeChats.delete(uuid);
                markDisconnected(uuid);
                addSystemMessage(uuid, '连接超时，请检查对方防火墙是否放行 50002 端口');
                showToast('连接超时，对方可能未放行防火墙');
            }
        }, 5000);

        ws.onopen = () => {
            clearTimeout(connectTimeout);
            // 发送连接请求，带上自己的 token 给对方后端验证
            // 对方通过 UDP 广播收到了我的 token，验证是否匹配
            ws.send(JSON.stringify({
                type: 'connect_request',
                uuid: myInfo.uuid,
                name: myInfo.name,
                token: myInfo.token,
                ip: myInfo.ip,
                ws_port: myInfo.ws_port,
                have_you: haveYou,
            }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connect_accepted') {
                activeChats.set(uuid, ws);
                connectedPeers.add(uuid);
                markConnected(uuid);
                setupPeerMessageHandler(uuid, ws);
                // 连接建立后才将对方写入前端 contacts（不是点击聊天就写）
                // 保留已有消息，避免覆盖聊天记录
                if (!contacts.has(uuid)) {
                    contacts.set(uuid, { name: name, ip: ip, status: 'online', trusted: true, messages: [] });
                } else {
                    const existing = contacts.get(uuid);
                    existing.name = name;
                    existing.ip = ip;
                    existing.status = 'online';
                    existing.trusted = true;
                }
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
                let reason;
                if (msg.reason === 'invalid_token') reason = 'Token 验证失败，请稍后重试';
                else if (msg.reason === 'timeout') reason = '对方未在1分钟内确认，连接超时';
                else reason = '对方拒绝了连接请求';
                addSystemMessage(uuid, reason);
                showToast(reason);
            }
        };

        ws.onclose = () => {
            activeChats.delete(uuid);
            connectedPeers.delete(uuid);
            markDisconnected(uuid);
            // 中止与该对端的所有进行中文件上传（接收方断开时也要停止发送）
            abortTransfersForPeer(uuid);
            renderOnlineList();
            renderContactsList();
            if (currentChat === uuid) {
                addSystemMessage(uuid, '连接已断开');
                updateChatHeaderStatus();
            }
        };

        ws.onerror = () => {
            clearTimeout(connectTimeout);
            activeChats.delete(uuid);
            markDisconnected(uuid);
            addSystemMessage(uuid, '连接失败，请检查网络或对方防火墙');
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
                // 手动连接不知道对方真实 uuid，按 IP 在历史里查找是否有该联系人
                have_you: [...contacts.values()].some(c => c.ip === ip),
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
                markConnected(realUuid);
                setupPeerMessageHandler(realUuid, ws);
                // 修正 close 回调使用真实 UUID
                ws.onclose = () => {
                    activeChats.delete(realUuid);
                    connectedPeers.delete(realUuid);
                    markDisconnected(realUuid);
                    // 中止与该对端的所有进行中文件上传（接收方断开时也要停止发送）
                    abortTransfersForPeer(realUuid);
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
                let reason;
                if (msg.reason === 'invalid_token') reason = 'Token 验证失败，请稍后重试';
                else if (msg.reason === 'timeout') reason = '对方未在1分钟内确认，连接超时';
                else reason = '对方拒绝了连接请求';
                addSystemMessage(tempUuid, reason);
                showToast(reason);
            }
        };

        ws.onclose = () => {
            activeChats.delete(tempUuid);
            connectedPeers.delete(tempUuid);
            // 中止与该对端的所有进行中文件上传（接收方断开时也要停止发送）
            abortTransfersForPeer(tempUuid);
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
        } else if (msg.type === 'contact_untrusted') {
            // 对端删除了我们 → 标记对方为不可信（保留历史记录）
            handleContactUntrusted({ uuid: uuid });
            // 通知己方后端标记该联系人为不可信
            controlWs.send(JSON.stringify({ type: 'mark_untrusted', uuid: uuid }));
            const contact = contacts.get(uuid);
            const peerName = contact ? contact.name : '对方';
            showCenterToast(`${peerName} 已将你从联系人中删除，下次连接需重新验证`);
        } else if (msg.type === 'connection_closing') {
            // 对端因空闲超时关闭连接
            addSystemMessage(uuid, '连接因长时间无活动已自动关闭');
            showToast('连接已因空闲超时关闭');
            ws.close();
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

    // 优先从 contacts 取，其次从 onlinePeers 取（陌生人点开时不写入 contacts）
    let contact = contacts.get(uuid);
    if (!contact) {
        const peer = onlinePeers.get(uuid);
        contact = peer ? { name: peer.name, ip: peer.ip, status: 'online' } : { name: 'Unknown', ip: '', status: 'offline' };
    }
    chatPeerName.textContent = contact.name;
    updateChatHeaderStatus();

    // 仅对已有联系人加载历史消息（陌生人无历史）
    if (contacts.has(uuid)) {
        const c = contacts.get(uuid);
        if (!c.messages || c.messages.length === 0) {
            try {
                const resp = await fetch(`/api/messages/${uuid}`);
                c.messages = await resp.json();
            } catch (e) { /* 加载失败则用现有消息 */ }
        }
    } else {
        // 联系人不在 Map 中（如刚被删除但后端还有数据，或页面状态异常），
        // 尝试从后端加载消息，避免显示白板
        try {
            const resp = await fetch(`/api/messages/${uuid}`);
            const msgs = await resp.json();
            if (msgs && msgs.length > 0) {
                const peer = onlinePeers.get(uuid) || {};
                contacts.set(uuid, {
                    name: peer.name || contact.name,
                    ip: peer.ip || contact.ip || '',
                    status: 'online',
                    messages: msgs,
                });
            }
        } catch (e) { /* 忽略 */ }
    }

    renderMessages(uuid);
    renderOnlineList();
    renderContactsList();
}

function closeCurrentChat() {
    currentChat = null;
    chatPlaceholder.style.display = '';
    chatContainer.style.display = 'none';
    chatConnectBar.style.display = 'none';
    chatMessages.innerHTML = '';
    renderOnlineList();
    renderContactsList();
}

/** 主动断开当前聊天连接（关闭双方 WS，无需对方确认） */
async function disconnectCurrentChat() {
    if (!currentChat) return;
    const uuid = currentChat;
    const contact = contacts.get(uuid);
    const peerName = contact ? contact.name : '对方';

    // 检查是否有正在进行的文件传输（发送或接收）
    let hasActiveTransfer = false;
    // 检查发送中的文件（排除已中止的，它们已不在传输）
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid && !t.aborted) { hasActiveTransfer = true; break; }
    }
    // 检查接收中的文件（status 为 downloading/waiting 且来自对方）
    // 注意：abortTransfersForPeer 已将中断的接收标记为 failed，这里不会误报
    if (!hasActiveTransfer && contact && contact.messages) {
        hasActiveTransfer = contact.messages.some(m =>
            (m.type === 'file' || (m.msg_id && m.msg_id.startsWith('f_'))) &&
            m.from !== 'me' &&
            (m.status === 'downloading' || m.status === 'waiting')
        );
    }
    if (hasActiveTransfer) {
        const ok = await showConfirmModal(
            '断开连接',
            `${peerName} 有正在传输的文件，断开连接将中断传输。确定断开？`,
            '断开',
            true
        );
        if (!ok) return;
    }

    const ok = await showConfirmModal(
        '断开连接',
        `确定断开与 ${peerName} 的连接？`,
        '断开',
        true
    );
    if (!ok) return;

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
    markDisconnected(uuid);

    // 4. 中止所有进行中的文件传输（保留数据供后续续传）
    abortTransfersForPeer(uuid);

    // 5. 更新 UI
    renderOnlineList();
    renderContactsList();
    updateChatHeaderStatus();
    addSystemMessage(uuid, '你已断开连接');
}

/** 中止对指定 peer 的所有进行中文件上传，保留数据供续传 */
/**
 * 检查与指定 peer 之间是否有正在进行的文件传输（上传或下载）。
 * @param {string} uuid - 对方 UUID
 * @returns {boolean}
 */
function hasActiveTransferWithPeer(uuid) {
    // 检查发送中的传输（pendingFileTransfers）
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid && !t.aborted && !t.failed) {
            return true;
        }
    }
    // 检查接收中的传输（聊天记录中的 file 消息）
    const contact = contacts.get(uuid);
    if (contact && contact.messages) {
        for (const m of contact.messages) {
            if ((m.type === 'file' || (m.msg_id && m.msg_id.startsWith('f_'))) &&
                m.from !== 'me' &&
                (m.status === 'downloading' || m.status === 'waiting')) {
                return true;
            }
        }
    }
    return false;
}

function abortTransfersForPeer(uuid) {
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) {
            t.aborted = true;
        }
    }
    // 同时标记接收中的文件消息为 failed，防止断开检查误报"有正在传输的文件"
    const contact = contacts.get(uuid);
    if (contact && contact.messages) {
        let changed = false;
        for (const m of contact.messages) {
            if ((m.type === 'file' || (m.msg_id && m.msg_id.startsWith('f_'))) &&
                m.from !== 'me' &&
                (m.status === 'downloading' || m.status === 'waiting')) {
                m.status = 'failed';
                saveFileMessage(uuid, m);
                changed = true;
            }
        }
        if (changed && currentChat === uuid) renderMessages(uuid);
    }
}

async function deleteCurrentContact() {
    if (!currentChat) return;
    const uuid = currentChat;
    const contact = contacts.get(uuid);
    const peerName = contact ? contact.name : '对方';

    // 先检查是否有正在进行的文件传输，有则阻止删除
    if (hasActiveTransferWithPeer(uuid)) {
        showCenterToast('有文件正在传输，请等待传输完成或取消后再删除联系人');
        return;
    }

    const ok = await showConfirmModal(
        '删除联系人',
        `确定删除联系人 ${peerName} 及其所有聊天记录？此操作不可恢复。`,
        '删除',
        true
    );
    if (!ok) return;

    // ===== 清理所有与该对端的连接和状态 =====

    // 1. 关闭本方 outgoing WS
    const chatWs = activeChats.get(uuid);
    if (chatWs) {
        try { chatWs.close(); } catch (e) { /* ignore */ }
    }

    // 2. 中止所有进行中的文件传输
    abortTransfersForPeer(uuid);
    for (const [tid, t] of Object.entries(pendingFileTransfers)) {
        if (t.uuid === uuid) delete pendingFileTransfers[tid];
    }

    // 3. 清理前端连接状态（始终执行，不管之前是否"已连接"）
    activeChats.delete(uuid);
    connectedPeers.delete(uuid);
    markDisconnected(uuid);
    pendingRequests.delete(uuid);

    // 4. 通知后端删除联系人（后端会先通知对端，再关闭连接，最后删数据）
    try {
        controlWs.send(JSON.stringify({ type: 'delete_contact', uuid: uuid }));
    } catch (e) { /* ignore */ }

    // 5. 清理前端联系人数据
    contacts.delete(uuid);
    closeCurrentChat();
    renderOnlineList();
    renderContactsList();
    renderPendingList();
    showToast('联系人已删除');
}

function updateChatHeaderStatus() {
    if (!currentChat) return;
    const chatWs = activeChats.get(currentChat);
    const wsConnected = isPeerConnected(currentChat);
    const discoverable = isPeerDiscoverable(currentChat);

    let statusText, statusClass;
    if (wsConnected) {
        statusText = '🟢 已连接';
        statusClass = 'online';
    } else if (discoverable) {
        statusText = '🟡 在线（未建立聊天连接）';
        statusClass = 'online';
    } else {
        statusText = '🔴 未发现';
        statusClass = 'offline';
    }
    chatPeerStatus.textContent = statusText;
    chatPeerStatus.className = statusClass;
    chatConnectBar.style.display = (discoverable && !wsConnected) ? '' : 'none';
    btnDisconnect.style.display = wsConnected ? '' : 'none';
}

// ===== 发送消息 =====
function sendCurrentMessage() {
    const content = msgInput.value.trim();
    if (!content || !currentChat) return;

    // 会话态：仅校验 Chat WS 是否已连接，不依赖 UDP 在线列表
    const chatWs = activeChats.get(currentChat);
    if (!isPeerConnected(currentChat)) {
        showCenterToast('连接按钮都懒得点，那就别想和我聊天~');
        return;
    }

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

    // 操作按钮
    const showRetry = (status === 'failed' || status === 'cancelled') && isSent && transferId;
    let actionHtml = '';
    if (showOpen) {
        actionHtml += `<button class="btn-open-file" onclick="openDownloadedFile('${escAttr(fileName)}')">📂 打开文件</button>`;
    }
    if (showRetry) {
        actionHtml += `<button class="btn-retry-file" data-transfer-id="${escAttr(transferId)}">🔄 重新发送</button>`;
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
    if (!file || !currentChat) {
        fileInput.value = '';
        return;
    }

    if (!isPeerConnected(currentChat)) {
        showCenterToast('连接按钮都懒得点，那就别想和我聊天~');
        fileInput.value = '';
        return;
    }

    fileInput.value = '';
    sendFile(currentChat, file);
}

/**
 * 发送文件：添加文件消息气泡 → 发 file_request → 等对方响应后自动开始上传。
 */
async function sendFile(uuid, file) {
    if (!isPeerConnected(uuid)) {
        showCenterToast('连接按钮都懒得点，那就别想和我聊天~');
        return;
    }

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
        aborted: false,
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

    const result = findFileMsgByTransferId(transferId);
    const fileMsg = result ? result.msg : null;
    if (result) {
        fileMsg.status = 'uploading';
        saveFileMessage(t.uuid, fileMsg);
        if (currentChat === t.uuid) renderMessages(t.uuid);
    }

    const peer = getPeerEndpoint(t.uuid);
    if (!peer || !peer.ip) {
        showToast('缺少对方地址信息，无法发送文件');
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
        // 检查连接是否被中断（断开连接 / 对方下线）
        if (t.aborted) {
            if (fileMsg) {
                fileMsg.status = 'cancelled';
                saveFileMessage(t.uuid, fileMsg);
                if (currentChat === t.uuid) renderMessages(t.uuid);
            }
            return; // 连接中断，中止上传
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);

        let dataB64;
        try {
            dataB64 = await readAsBase64(blob);
        } catch (e) {
            // 文件读取失败（权限变更、文件被删、磁盘错误等），不可恢复
            t.failed = true;
            if (fileMsg) {
                fileMsg.status = 'failed';
                saveFileMessage(t.uuid, fileMsg);
                if (currentChat === t.uuid) renderMessages(t.uuid);
            }
            return;
        }

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
            t.failed = true;
            if (fileMsg) {
                fileMsg.status = 'failed';
                saveFileMessage(t.uuid, fileMsg);
                if (currentChat === t.uuid) renderMessages(t.uuid);
            }
            return; // 传输中断（保留 t 以便续传）
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

/**
 * 重新发送（续传）失败的文件。查询接收方已收分片，只补发缺失部分。
 * @param {string} transferId - 原传输 ID
 */
async function retryFileTransfer(transferId) {
    // 1. 检查是否有文件数据（页面刷新后 File 对象会丢失）
    const t = pendingFileTransfers[transferId];
    if (!t || !t.file) {
        showToast('无法续传：文件数据已丢失，请重新选择文件发送');
        return;
    }

    const peer = getPeerEndpoint(t.uuid);
    if (!isPeerConnected(t.uuid)) {
        showCenterToast('连接按钮都懒得点，那就别想重传文件~');
        return;
    }
    if (!peer || !peer.ip) {
        showCenterToast('缺少对方地址信息，无法重传');
        return;
    }

    let receivedChunks = 0;
    const peerPort = peer.ws_port || 50002;
    try {
        const resp = await fetch(`http://${peer.ip}:${peerPort}/api/transfer/status/${transferId}`);
        if (resp.ok) {
            const status = await resp.json();
            receivedChunks = status.received_chunks_count || 0;
        }
    } catch (e) {
        // 进度丢失，从头开始
        console.log('[Retry] 无法获取进度，从头开始:', e.message);
    }

    // 4. 更新传输状态 — 从已收到的下一片开始
    t.currentChunk = receivedChunks;
    t.started = false;
    t.failed = false;
    t.aborted = false;

    // 5. 更新文件消息气泡
    const result = findFileMsgByTransferId(transferId);
    if (result) {
        result.msg.status = 'waiting';
        result.msg.progress = Math.round(receivedChunks / t.totalChunks * 100);
        saveFileMessage(t.uuid, result.msg);
        if (currentChat === t.uuid) renderMessages(t.uuid);
    }

    // 6. 重新发送 file_request（带 resume 标记，接收方会跳过确认直接接受）
    const fileRequestMsg = {
        transfer_id: transferId,
        file_name: t.file.name,
        file_size: t.file.size,
        chunk_size: t.CHUNK_SIZE,
        total_chunks: t.totalChunks,
        resume: true,
    };

    const ws = activeChats.get(t.uuid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'file_request', ...fileRequestMsg }));
    } else {
        // 回退路径：通过 control WS 转发
        controlWs.send(JSON.stringify({
            type: 'file_request',
            to_uuid: t.uuid,
            ...fileRequestMsg,
        }));
    }
}

function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            // 去掉 "data:...;base64," 前缀
            const b64 = result.split(',')[1] || result;
            resolve(b64);
        };
        reader.onerror = () => {
            reject(new Error('文件读取失败'));
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

        // 检查是否已存在同 transfer_id 的文件消息，避免重复插入
        const uuid = msg.from_uuid;
        if (!contacts.has(uuid)) {
            contacts.set(uuid, { name: msg.from_name, ip: '', status: 'online', messages: [] });
        }
        const contact = contacts.get(uuid);
        const msgId = 'f_' + msg.transfer_id;
        const existingIdx = contact.messages.findIndex(m => m.msg_id === msgId);
        if (existingIdx >= 0) {
            // 续传/重发的文件请求：更新已有消息状态，保留旧进度
            contact.messages[existingIdx].status = 'downloading';
            // progress 保持中断前的值，后续由 transfer_progress 更新
            saveFileMessage(uuid, contact.messages[existingIdx]);
        } else {
            // 全新文件传输：插入新消息
            const fileMsg = {
                from: uuid,
                type: 'file',
                msg_id: msgId,
                timestamp: new Date().toISOString(),
                file_name: msg.file_name,
                file_size: msg.file_size,
                transfer_id: msg.transfer_id,
                direction: 'receive',
                status: 'downloading',
                progress: 0,
            };
            contact.messages.push(fileMsg);
            saveFileMessage(uuid, fileMsg);
        }
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
                    return { msg: contact.messages[i], peerUuid: uuid };
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

// ===== 通用确认弹窗 =====

/**
 * 显示确认弹窗，返回 Promise<boolean>。
 * 替代 window.confirm()，风格与修改昵称弹窗一致。
 */
function showConfirmModal(title, message, confirmLabel = '确认', isDanger = false) {
    return new Promise((resolve) => {
        $('confirm-modal-title').textContent = title;
        $('confirm-modal-body').textContent = message;
        $('confirm-modal-overlay').style.display = '';

        const btnOk = $('btn-confirm-ok');
        const btnCancel = $('btn-confirm-cancel');
        btnOk.textContent = confirmLabel;

        // 危险操作确认按钮用红色，取消用蓝色
        btnOk.className = isDanger ? 'btn-danger' : 'btn-primary';
        btnCancel.className = 'btn-primary';

        function cleanup(result) {
            $('confirm-modal-overlay').style.display = 'none';
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            resolve(result);
        }

        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

// ===== 昵称编辑弹窗 =====
function showEditNameModal() {
    modalNameInput.value = myInfo.name;
    $('modal-name-error').classList.remove('show');
    modalOverlay.style.display = '';
    modalNameInput.focus();
}
function hideEditNameModal() {
    modalOverlay.style.display = 'none';
}
function saveName() {
    const newName = modalNameInput.value.trim();
    const errEl = $('modal-name-error');
    if (!newName) {
        errEl.textContent = '昵称不能为空';
        errEl.classList.add('show');
        modalNameInput.focus();
        // 3 秒后逐渐消失
        setTimeout(() => { errEl.classList.remove('show'); }, 3000);
        return;
    }
    errEl.classList.remove('show');
    if (newName === myInfo.name) {
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
    // 简单的 toast 提示（右上角，系统通知用）
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:60px;right:20px;background:#333;color:#fff;padding:10px 20px;border-radius:6px;z-index:200;font-size:13px;animation:fadeOut 2s forwards';
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2200);
}

/** 居中提示：弹出后渐隐，用于连接阻断等需要用户注意的反馈 */
function showCenterToast(text) {
    const div = document.createElement('div');
    div.style.cssText = [
        'position:fixed; top:50%; left:50%',
        'transform:translate(-50%,-50%)',
        'background:#fff; color:#222',
        'padding:14px 28px; border-radius:8px',
        'box-shadow:0 4px 24px rgba(0,0,0,0.18)',
        'z-index:300; font-size:15px',
        'text-align:center; white-space:nowrap',
        'pointer-events:none',
        'animation:centerToastPop 1.75s forwards',
    ].join(';');
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 1850);
}

// ===== 启动 =====
init();
