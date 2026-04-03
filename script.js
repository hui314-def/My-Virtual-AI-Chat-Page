// 聊天页面核心交互功能（每个对话独立设置 + 本地存储）
(function() {
    // ==================== IndexedDB 存储模块 ====================
    const DB_NAME = 'ChatAppDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'chats';
    let currentTopicIndex = null; // null 表示显示全部对话，数字表示当前显示的话题索引（0-based）
    let db = null;
    let currentFile = null;      // 存储当前选中的文件对象
    let currentFileContent = null; // 存储读取的文件内容


    // 左侧边栏拖动调整宽度
    function initResizer() {
        if (window.innerWidth <= 768) return; // 移动端不启用拖动
        const resizer = document.querySelector('.resizer');
        const sidebar = document.querySelector('.sidebar');
        if (!resizer || !sidebar) return;

        let startX, startWidth;
        let isDragging = false;

        // 从 localStorage 恢复宽度
        const savedWidth = localStorage.getItem('sidebar-width');
        if (savedWidth && !isNaN(parseInt(savedWidth))) {
            sidebar.style.width = `${savedWidth}px`;
        }

        function onMouseMove(e) {
            if (!isDragging) return;
            e.preventDefault();   // 阻止默认行为（重要）
            let newWidth = startWidth + (e.clientX - startX);
            newWidth = Math.min(500, Math.max(200, newWidth));
            sidebar.style.width = `${newWidth}px`;
            localStorage.setItem('sidebar-width', newWidth);
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            resizer.classList.remove('active');
            document.body.classList.remove('dragging');
        }

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();   // 关键：阻止文字选中
            e.stopPropagation();
            isDragging = true;
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            resizer.classList.add('active');
            document.body.classList.add('dragging');
        });
    }

    
    // 打开数据库
    function openDB() {
        return new Promise((resolve, reject) => {
            if (db) {
                resolve(db);
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
        });
    }

    // 保存所有聊天数据
    async function saveChatsToDB(chats) {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await store.clear(); // 清空旧数据，全量替换
        for (const chat of chats) {
            store.put(chat);
        }
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    // 加载所有聊天数据
    async function loadChatsFromDB() {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // 删除单个聊天（可选，但保留备用）
    async function deleteChatFromDB(chatId) {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(chatId);
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }
    // ==================== 动态注入弹窗样式 ====================
    const modalStyles = `
        .settings-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(8px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        }
        .modal-content {
            background: rgba(15, 18, 30, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 32px;
            width: 90%;
            max-width: 550px;
            border: 1px solid rgba(100, 150, 255, 0.5);
            box-shadow: 0 20px 35px rgba(0, 0, 0, 0.5);
            animation: modalFadeIn 0.2s ease;
        }
        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 24px;
            border-bottom: 1px solid rgba(100, 120, 200, 0.3);
        }
        .modal-header h3 {
            font-size: 1.3rem;
            color: #ccd6ff;
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 0;
        }
        .modal-close {
            background: transparent;
            border: none;
            font-size: 28px;
            color: #aaa;
            cursor: pointer;
            transition: 0.2s;
        }
        .modal-close:hover { color: #fff; }
        .modal-body {
            padding: 20px 24px;
            max-height: 60vh;
            overflow-y: auto;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: #b7c4ff;
            font-size: 0.85rem;
        }
        .image-preview {
            width: 100px;
            height: 100px;
            border-radius: 50%;
            overflow: hidden;
            margin-bottom: 10px;
            border: 2px solid #5f7eff;
            background: #1a1c2a;
        }
        #bg-preview {
            width: 100%;
            height: auto;
            border-radius: 12px;
            border: 1px solid #5f7eff;
        }
        .image-preview img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        input[type="text"], textarea, input[type="file"] {
            width: 100%;
            background: rgba(30, 34, 55, 0.7);
            border: 1px solid rgba(100, 130, 255, 0.4);
            border-radius: 20px;
            padding: 10px 16px;
            color: #f0f3ff;
            font-size: 0.9rem;
            outline: none;
            transition: 0.2s;
            box-sizing: border-box;
        }
        textarea {
            resize: vertical;
            font-family: inherit;
        }
        input:focus, textarea:focus {
            border-color: #7f9eff;
            background: rgba(40, 45, 70, 0.8);
        }
        .modal-footer {
            padding: 16px 24px;
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            border-top: 1px solid rgba(100, 120, 200, 0.3);
        }
        .modal-btn {
            padding: 8px 20px;
            border-radius: 40px;
            border: none;
            cursor: pointer;
            font-weight: 500;
            transition: 0.2s;
        }
        .modal-btn.cancel {
            background: rgba(80, 80, 110, 0.6);
            color: #ddd;
        }
        .modal-btn.cancel:hover {
            background: rgba(100, 100, 130, 0.8);
        }
        .modal-btn.save {
            background: linear-gradient(125deg, #2d3370, #1b1f48);
            border: 1px solid #6c7eff;
            color: white;
        }
        .modal-btn.save:hover {
            background: #3d4590;
        }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.textContent = modalStyles;
    document.head.appendChild(styleSheet);

    // ==================== 动态创建弹窗 HTML ====================
    const modalHTML = `
        <div id="settings-modal" class="settings-modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h3><i class="fas fa-sliders-h"></i> 对话设置</h3>
                    <button class="modal-close" id="close-modal-btn">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="settings-form">
                        <div class="form-group">
                            <label>角色头像</label>
                            <div class="image-preview" id="avatar-preview">
                                <img id="avatar-img" src="..." alt="头像预览" style="cursor: pointer;">
                            </div>
                            <small>点击头像图片即可更换</small>
                        </div>
                        <div class="form-group">
                            <label>聊天背景图片</label>
                            <div class="image-preview" id="bg-preview">
                                <img id="bg-img" src="https://via.placeholder.com/300x200?text=默认背景" alt="背景预览" style="width:100%; height:auto;">
                            </div>
                            <input type="file" id="bg-upload" accept="image/*">
                            <small>背景图将应用于右侧聊天区域</small>
                        </div>
                        <div class="form-group">
                            <label>角色名称</label>
                            <input type="text" id="role-name" placeholder="输入角色名称">
                        </div>
                        <div class="form-group">
                            <label>角色设定</label>
                            <textarea id="role-persona" rows="3" placeholder="例如：Nova 是一位来自未来星系的AI助手，喜欢用诗意的语言回答问题..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>角色开场白</label>
                            <textarea id="role-greeting" rows="2" placeholder="每次新对话时显示的开场白"></textarea>
                        </div>
                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: 12px;">
                                <i class="fas fa-volume-up"></i> 语音合成
                                <label class="switch">
                                    <input type="checkbox" id="tts-switch">
                                    <span class="slider round"></span>
                                </label>
                            </label>
                            <small>开启后，智能体的回复将自动朗读</small>
                        </div>
                        <!-- 音色选择（默认隐藏，开关开启时显示） -->
                        <div class="form-group" id="tts-voice-group" style="display: none;">
                            <label>音色选择</label>
                            <select id="tts-voice-select">
                                <option value="zh-CN-XiaoxiaoNeural">晓晓（女，温柔）</option>
                                <option value="zh-CN-YunxiNeural">云希（男，年轻）</option>
                                <option value="zh-CN-YunyangNeural">云扬（男，新闻）</option>
                                <option value="zh-CN-XiaoyiNeural">晓伊（女，活泼）</option>
                                <option value="zh-CN-XiaochenNeural">晓辰（女，成熟）</option>
                                <option value="zh-CN-XiaohanNeural">晓涵（女，自然）</option>
                                <option value="zh-CN-XiaomengNeural">晓萌（女，可爱）</option>
                                <option value="zh-CN-XiaoxuanNeural">晓萱（女，甜美）</option>
                                <option value="zh-CN-XiaoruiNeural">晓睿（女，平静）</option>
                                <option value="zh-CN-XiaoshuangNeural">晓双（女，亲切）</option>
                            </select>
                        </div>
                        <div class="form-group" style="border-top: 1px solid rgba(100,120,200,0.3); padding-top: 16px; margin-top: 8px;">
                            <label><i class="fas fa-cog"></i> 特定模型设置</label>
                            <div style="margin-top: 12px;">
                                <!-- 上下文消息数量上限 -->
                                <div class="model-param-item">
                                    <label>上下文消息数量上限</label>
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="range" id="context-limit" min="1" max="50" step="1" value="10" style="flex:1;">
                                        <span id="context-limit-value" style="min-width: 40px;">10</span>
                                        <label style="display: flex; align-items: center; gap: 6px;">
                                            <input type="checkbox" id="context-unlimited"> 无限制
                                        </label>
                                    </div>
                                    <small>限制模型参考的历史消息条数（不含系统提示），勾选“无限制”则不截断</small>
                                </div>
                                <!-- 温度 -->
                                <div class="model-param-item">
                                    <label>温度 (Temperature)</label>
                                    <input type="range" id="temperature" min="0" max="2" step="0.1" value="0.7">
                                    <span id="temperature-value" class="param-value">0.7</span>
                                    <small>越高越随机，越低越确定</small>
                                </div>
                                <!-- Top P -->
                                <div class="model-param-item">
                                    <label>Top P</label>
                                    <input type="range" id="top-p" min="0" max="1" step="0.05" value="0.9">
                                    <span id="top-p-value" class="param-value">0.9</span>
                                    <small>核采样，控制词汇多样性</small>
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="modal-btn cancel" id="cancel-settings-btn">取消</button>
                    <button class="modal-btn save" id="save-settings-btn">保存设置</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // ==================== DOM 元素绑定 ====================
    const historyList = document.querySelector('.history-list');
    const newChatBtn = document.querySelector('.new-chat-btn');
    const settingBtn = document.querySelector('.setting-btn');
    const chatMessages = document.querySelector('.chat-messages');
    const messageInput = document.querySelector('.auto-expand-textarea');
    const sendBtn = document.querySelector('.send-btn');

    // 数据结构
    let chats = [];           // 每个元素: { id, title, date, messages, settings }
    let currentChatId = null;

    // 默认设置模板
    const defaultSettings = {
        avatarUrl: null,                           // base64 或 null
        bgUrl: null,
        roleName: 'Nova',
        persona: 'Nova 是一位来自未来星系的AI助手，喜欢用诗意的语言回答问题。',
        greeting: '✨ 你好，我是你的虚拟AI伙伴Nova。背景中的灵境图腾，就是我意识映射的碎片。今晚想探索哪个维度？',
        ttsEnabled: false, // 默认关闭
    };

    // ==================== 本地存储 ====================
    // 保存到 IndexedDB
    async function saveToStorage() {
        try {
            await saveChatsToDB(chats);
        } catch (err) {
            console.error('保存失败', err);
            alert('保存失败，请检查浏览器存储权限或清理缓存后重试。');
        }
    }

    // 从 IndexedDB 加载
    async function loadFromStorage() {
        try {
            const storedChats = await loadChatsFromDB();
            if (storedChats && storedChats.length > 0) {
                // 恢复日期对象（JSON 序列化会丢失 Date 类型）
                return storedChats.map(chat => ({
                    ...chat,
                    date: new Date(chat.date),
                    messages: chat.messages.map(msg => ({ ...msg })),
                    settings: { ...defaultSettings, ...(chat.settings || {}) }
                }));
            }
            return null;
        } catch (err) {
            console.error('加载失败', err);
            return null;
        }
    }
    // ==================== 辅助函数 ====================
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    function getCurrentTime() {
        const d = new Date();
        return `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

    function scrollToBottom() {
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function formatDate(dateObj) {
        const now = new Date();
        const diff = now - dateObj;
        if (diff < 24 * 3600 * 1000 && now.getDate() === dateObj.getDate()) {
            return `今天 ${dateObj.getHours()}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
        } else if (diff < 48 * 3600 * 1000) {
            return `昨天 ${dateObj.getHours()}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
        } else {
            return `${dateObj.getMonth()+1}月${dateObj.getDate()}日`;
        }
    }

    // 应用当前对话的设置到界面（背景、右上角名称、全局头像变量）
    function applyCurrentChatSettings() {
        const chat = chats.find(c => c.id == currentChatId);
        if (!chat) return;
        const settings = chat.settings || defaultSettings;
        // 更新右上角角色名称
        const logoText = document.querySelector('.logo-text');
        if (logoText) logoText.innerHTML = `AURA · ${settings.roleName}`;
        // 更新聊天背景
        const mainChat = document.querySelector('.main-chat');
        if (settings.bgUrl) {
            mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${settings.bgUrl})`;
            mainChat.style.backgroundSize = 'cover';
            mainChat.style.backgroundPosition = 'center';
        } else {
            // 恢复默认背景（保持原有 SVG）
            mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 1600'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%232a2e5a'/%3E%3Cstop offset='100%25' stop-color='%2312152c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23grad)'/%3E%3Ccircle cx='600' cy='600' r='280' fill='%23333b6e' opacity='0.3'/%3E%3Cpath d='M520,460 L680,460 L720,540 L680,620 L520,620 L480,540 Z' fill='%235f7eff' opacity='0.45'/%3E%3Ccircle cx='600' cy='540' r='38' fill='%23aac0ff' opacity='0.6'/%3E%3Ccircle cx='550' cy='520' r='8' fill='white'/%3E%3Ccircle cx='650' cy='520' r='8' fill='white'/%3E%3Cpath d='M570 580 Q600 620 630 580' stroke='%23f0f3ff' stroke-width='5' fill='none' stroke-linecap='round' opacity='0.7'/%3E%3Ctext x='600' y='800' font-size='42' font-family='monospace' fill='%23ffffff80' text-anchor='middle'%3E⚡ AI CORE ⚡%3C/text%3E%3C/svg%3E") center/cover no-repeat`;
        }
    }
    // 渲染左侧历史列表
    function renderHistoryList() {
        if (!historyList) return;
        historyList.innerHTML = '';
        // 排序：置顶的在前，然后按时间倒序（最新的在前）
        const sortedChats = [...chats].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.date - a.date;
        });
        sortedChats.forEach(chat => {
            const settings = chat.settings || defaultSettings;
            const roleName = settings.roleName || 'Nova';
            const avatarUrl = settings.avatarUrl;
            
            const historyItem = document.createElement('div');
            historyItem.className = `history-item ${currentChatId === chat.id ? 'active' : ''}`;
            historyItem.setAttribute('data-id', chat.id);
            
            let avatarHtml = '';
            if (avatarUrl) {
                avatarHtml = `<img src="${avatarUrl}" class="history-avatar-img" alt="avatar">`;
            } else {
                avatarHtml = `<i class="fas fa-robot history-default-icon"></i>`;
            }
            
            // 标题行：角色名称 + 星星（如果置顶）
            const starHtml = chat.pinned ? '<i class="fas fa-star pin-star"></i>' : '';
            
            historyItem.innerHTML = `
                <div class="history-avatar">
                    ${avatarHtml}
                </div>
                <div class="history-info">
                    <div class="title">
                        ${escapeHtml(roleName)}
                        ${starHtml}
                    </div>
                    <div class="date">${formatDate(chat.date)}</div>
                </div>
            `;
            const menuTrigger = document.createElement('div');
            menuTrigger.className = 'history-menu-trigger';
            menuTrigger.innerHTML = '<i class="fas fa-ellipsis-v"></i>';
            historyItem.appendChild(menuTrigger);
            historyList.appendChild(historyItem);
            
            attachMenuEvents(historyItem, chat);
        });
        if (chats.length === 0) {
            historyList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">暂无对话，点击“新对话”开始</div>';
        }
        attachHistoryClickEvents();
    }

    // 追加消息到DOM（支持自定义AI头像）
    async function appendMessageToDOM(type, text, time, saveToStorageFlag = false, chatIdForSave = null, customAvatarUrl = null, fileAttachment = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        let avatarHtml = '';
        
        if (type === 'ai') {
            // AI 头像：优先使用传入的头像，否则从当前对话设置中获取
            let avatarUrl = customAvatarUrl;
            if (!avatarUrl && currentChatId) {
                const currentChat = chats.find(c => c.id == currentChatId);
                if (currentChat && currentChat.settings) {
                    avatarUrl = currentChat.settings.avatarUrl;
                }
            }
            if (avatarUrl) {
                avatarHtml = `<img src="${avatarUrl}" style="width:38px; height:38px; border-radius:50%; object-fit:cover;">`;
            } else {
                avatarHtml = '<i class="fas fa-robot"></i>';
            }
        } else {
            // 用户头像：从全局设置中获取
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const userAvatar = globalSettings.avatar;
            if (userAvatar && userAvatar.startsWith('data:image')) {
                avatarHtml = `<img src="${userAvatar}" style="width:38px; height:38px; border-radius:50%; object-fit:cover;">`;
            } else {
                avatarHtml = '<i class="fas fa-user-astronaut"></i>';
            }
        }
        
        // 消息气泡内容
        let bubbleContent = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
        if (type === 'user' && fileAttachment) {
            // 添加可点击的文件链接
            bubbleContent += `<div class="file-attachment" data-filename="${escapeHtml(fileAttachment.name)}" data-content="${escapeHtml(fileAttachment.content)}">
                <i class="fas fa-paperclip"></i> ${escapeHtml(fileAttachment.name)}
            </div>`;
        }
        bubbleContent += `<div class="msg-time">${time || getCurrentTime()}</div>`;
        
        messageDiv.innerHTML = `
            <div class="avatar-msg">${avatarHtml}</div>
            <div class="bubble">${bubbleContent}</div>
        `;
        chatMessages.appendChild(messageDiv);
        scrollToBottom();
        
        // 绑定文件点击事件
        if (type === 'user' && fileAttachment) {
            const fileElem = messageDiv.querySelector('.file-attachment');
            if (fileElem) {
                fileElem.addEventListener('click', () => {
                    showFileContentModal(fileAttachment.name, fileAttachment.content);
                });
            }
        }
        if (saveToStorageFlag) {
            const targetChatId = chatIdForSave || currentChatId;
            const targetChat = chats.find(c => c.id == targetChatId);
            if (targetChat) {
                targetChat.messages.push({ type, text, time: time || getCurrentTime() });
                if (type === 'user') {
                    targetChat.date = new Date();
                    renderHistoryList();
                    await saveChatsToDB(chats);
                }
            }
        }
    }

    function renderMessages(chatId, topicIndex = null) {
        const chat = chats.find(c => c.id == chatId);
        if (!chat || !chatMessages) return;
        chatMessages.innerHTML = '';
        const currentAvatarUrl = chat.settings?.avatarUrl || null;
        
        // 获取所有消息
        let messagesToRender = chat.messages;
        
        // 如果指定了话题索引，则过滤出该话题的消息
        if (topicIndex !== null) {
            const topics = getTopicsFromMessages(chat.messages);
            if (topics[topicIndex]) {
                messagesToRender = topics[topicIndex].messages;
            }
        }
        
        // 渲染消息
        messagesToRender.forEach(msg => {
            if (msg.type === 'divider') {
                const divider = document.createElement('div');
                divider.className = 'topic-divider';
                divider.innerHTML = `<i class="fas fa-asterisk"></i> ${escapeHtml(msg.text)} <i class="fas fa-asterisk"></i>`;
                chatMessages.appendChild(divider);
            } else {
                const fileAttachment = msg.file || null;
                appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment);
            }
        });
        
        // 如果处于话题视图且没有消息（理论上不会），显示提示
        if (topicIndex !== null && messagesToRender.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'topic-empty';
            emptyDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#8e8eb3;">该话题暂无消息</div>';
            chatMessages.appendChild(emptyDiv);
        }
        
        scrollToBottom();
    }
    // 调用本地 Ollama 模型（流式输出）
    let isStreaming = false; // 防止并发流式请求

    async function simulateAIResponse(userMsg) {
        // 防止多个流式请求同时进行
        if (isStreaming) {
            appendMessageToDOM('ai', '请等待上一个回复完成后再发送新消息。', getCurrentTime(), true);
            return;
        }

        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) {
            console.error('当前对话不存在，无法生成回复。currentChatId =', currentChatId);
            appendMessageToDOM('ai', '系统错误：无法找到当前对话。请刷新页面或新建对话后重试。', getCurrentTime(), true);
            return;
        }

        const settings = currentChat.settings || defaultSettings;
        const roleName = settings.roleName || 'Nova';
        const rolePersona = settings.persona || '';

        // 显示"正在输入"指示器（临时）
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message ai';
        typingDiv.innerHTML = `
            <div class="avatar-msg"><i class="fas fa-robot"></i></div>
            <div class="bubble typing-bubble">
                <div class="typing-indicator"><i class="fas fa-ellipsis-h"></i> ${roleName} 正在思考...</div>
            </div>
        `;
        chatMessages.appendChild(typingDiv);
        scrollToBottom();

        try {
            // 获取模型参数（带默认值）
            const contextLimit = currentChat.settings?.contextLimit ?? 10;
            const temperature = currentChat.settings?.temperature ?? 0.7;
            const topP = currentChat.settings?.topP ?? 0.9;
            // 获取消息历史（考虑话题视图）
            let historyMessages = [];
            if (currentTopicIndex !== null) {
                const topics = getTopicsFromMessages(currentChat.messages);
                if (topics[currentTopicIndex]) {
                    historyMessages = topics[currentTopicIndex].messages;
                }
            } else {
                historyMessages = currentChat.messages;
            }

            // 过滤掉分隔线
            const filteredMessages = historyMessages.filter(msg => msg.type !== 'divider');
            // 注意：如果 filteredMessages 长度超过 contextLimit，只取最后 contextLimit 条
            // 根据 contextLimit 截取最近的消息（-1 表示无限制）
            let messagesToUse = filteredMessages;
            if (contextLimit !== -1 && messagesToUse.length > contextLimit) {
                messagesToUse = messagesToUse.slice(-contextLimit);
            }

            // 构建 API 消息数组
            const messages = [];
            if (rolePersona) {
                messages.push({ role: 'system', content: rolePersona });
            }
            for (const msg of messagesToUse) {
                messages.push({
                    role: msg.type === 'user' ? 'user' : 'assistant',
                    content: msg.text
                });
            }
            messages.push({ role: 'user', content: userMsg });
            // 获取全局设置
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const modelHost = globalSettings.modelHost || 'http://localhost:11434';
            const apiKey = globalSettings.apiKey || '';

            // 构建请求头
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            // 调用 Ollama API（流式）
            const response = await fetch(`${modelHost}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gemma2', // 请修改为您已下载的模型名称
                    messages: messages,
                    stream: true,        // 开启流式输出
                    options: {
                        temperature: temperature,
                        top_p: topP,
                        num_predict: 500
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 移除正在输入指示器
            if (typingDiv && typingDiv.parentNode) typingDiv.remove();

            // 创建用于流式输出的气泡
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ai';
            // 从当前对话设置中获取头像 URL
            const avatarUrl = currentChat.settings?.avatarUrl;
            const avatarHtml = avatarUrl
                ? `<img src="${avatarUrl}" style="width:38px; height:38px; border-radius:50%; object-fit:cover;">`
                : '<i class="fas fa-robot"></i>';
            messageDiv.innerHTML = `
                <div class="avatar-msg">${avatarHtml}</div>
                <div class="bubble">
                    <p></p>
                    <div class="msg-time">${getCurrentTime()}</div>
                </div>
            `;
            chatMessages.appendChild(messageDiv);
            const bubbleP = messageDiv.querySelector('.bubble p');
            const msgTimeSpan = messageDiv.querySelector('.msg-time');
            scrollToBottom();

            isStreaming = true;

            // 流式读取响应
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let fullReply = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                // 按行分割（Ollama 返回的每一行都是 "data: {...}\n\n"）
                let lines = buffer.split('\n');
                buffer = lines.pop(); // 保留未完成的行
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === '') continue;
                    try {
                        const data = JSON.parse(trimmed);
                        const chunk = data.message?.content || '';
                        fullReply += chunk;
                        bubbleP.innerHTML = escapeHtml(fullReply).replace(/\n/g, '<br>');
                        scrollToBottom();
                        // 如果 done 为 true，表示流结束，可以提前终止（但还需处理剩余 buffer）
                        if (data.done === true) {
                            // 读完当前行后跳出循环，但外层循环还会继续直到 done 或读取完毕
                            // 由于最后一条消息 done=true，之后不会有更多数据，所以直接设置一个标志
                            // 此处不 break，让循环自然结束
                        }
                    } catch (e) {
                        console.warn('解析流数据失败:', e, trimmed);
                    }
                }
            }

            // 最终更新时间和保存消息
            msgTimeSpan.innerText = getCurrentTime();
            // 存储消息到当前对话
            const targetChat = chats.find(c => c.id == currentChatId);
            if (targetChat) {
                targetChat.messages.push({
                    type: 'ai',
                    text: fullReply,
                    time: getCurrentTime()
                });
                targetChat.date = new Date();
                renderHistoryList();
                saveToStorage();
            }

            isStreaming = false;

            // 语音合成（如果开启）
            if (currentChat.settings && currentChat.settings.ttsEnabled) {
                const ttsVoice = currentChat.settings.ttsVoice || 'zh-CN-XiaoxiaoNeural';
                speakWithQwenTTS(fullReply, ttsVoice);
            }

        } catch (error) {
            console.error('Ollama 调用失败:', error);
            if (typingDiv && typingDiv.parentNode) typingDiv.remove();
            let errorMsg = `❌ 模型调用失败：${error.message}\n请确保 Ollama 已启动且模型已下载。`;
            appendMessageToDOM('ai', errorMsg, getCurrentTime(), true);
            isStreaming = false;
        }
    }

    async function sendUserMessage() {
        let text = messageInput.value.trim();
        let fileAttachment = null;
        
        if (currentFileContent) {
            fileAttachment = {
                name: currentFile.name,
                content: currentFileContent
            };
            // 显示的消息文本只包含文件名，不显示内容
            text = text ? text + `\n\n📎 附件：${currentFile.name}` : `📎 附件：${currentFile.name}`;
            // 发送后清除文件预览
            currentFile = null;
            currentFileContent = null;
            const previewArea = document.getElementById('file-preview-area');
            if (previewArea) previewArea.style.display = 'none';
        }
        
        if (text === '' && !fileAttachment) return;
        
        // 存储消息时附带文件信息
        const userTime = getCurrentTime();
        const targetChat = chats.find(c => c.id == currentChatId);
        if (targetChat) {
            targetChat.messages.push({
                type: 'user',
                text: text,
                time: userTime,
                file: fileAttachment  // 附加文件信息
            });
            targetChat.date = new Date();
            renderHistoryList();
            await saveChatsToDB(chats);
        }
        // 渲染消息
        await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment);
        messageInput.value = '';
        if (messageInput) messageInput.style.height = 'auto';
        
        // 构建发送给模型的内容（包含文件内容）
        let modelUserMsg = text;
        if (fileAttachment) {
            modelUserMsg = text + `\n\n文件内容如下：\n\`\`\`\n${fileAttachment.content}\n\`\`\``;
        }
        simulateAIResponse(modelUserMsg);
    }

    async function createNewChat() {
        closeSidebarOnMobile();
        const newId = Date.now();
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        // 新对话的标题和设置：可以使用默认设置，但为了独立，复制一份默认设置（深拷贝）
        const newSettings = JSON.parse(JSON.stringify(defaultSettings));
        newSettings.contextLimit = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
        newSettings.temperature = globalSettings.temperature !== undefined ? globalSettings.temperature : 0.7;
        newSettings.topP = globalSettings.topP !== undefined ? globalSettings.topP : 0.9;
        // 可选：也可以继承用户管理的用户名等，按需
        const newChat = {
            id: newId,
            title: `新对话 ${chats.length+1}`,
            date: new Date(),
            messages: [
                { type: 'ai', text: newSettings.greeting, time: getCurrentTime() }
            ],
            settings: newSettings,
            pinned: false
        };
        chats.unshift(newChat);
        currentChatId = newId;
        renderHistoryList();
        renderMessages(currentChatId);
        applyCurrentChatSettings();   // 应用新对话的设置（背景、名称等）
        await saveToStorage();
    }

    function switchChat(chatId) {
        closeSidebarOnMobile();
        if (currentChatId == chatId) return;
        currentChatId = chatId;
        currentTopicIndex = null; // 切换对话时重置话题视图
        renderHistoryList();
        renderMessages(currentChatId);
        applyCurrentChatSettings();
    }

    function attachHistoryClickEvents() {
        
        const items = document.querySelectorAll('.history-item');
        items.forEach(item => {
            item.removeEventListener('click', historyClickHandler);
            item.addEventListener('click', historyClickHandler);
        });
    }
    function historyClickHandler(e) {
        const targetItem = e.currentTarget;
        const chatId = parseInt(targetItem.getAttribute('data-id'));
        if (!isNaN(chatId)) {
            closeSidebarOnMobile();
            switchChat(chatId);
        }
    }

    // ==================== 弹窗逻辑（编辑当前对话的设置） ====================
    const modal = document.getElementById('settings-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const cancelBtn = document.getElementById('cancel-settings-btn');
    const saveBtn = document.getElementById('save-settings-btn');
    const bgUpload = document.getElementById('bg-upload');
    const roleNameInput = document.getElementById('role-name');
    const rolePersona = document.getElementById('role-persona');
    const roleGreeting = document.getElementById('role-greeting');
    const avatarImg = document.getElementById('avatar-img');
    const bgImg = document.getElementById('bg-img');
    
    // 点击头像图片触发文件选择
    const avatarImgElement = document.getElementById('avatar-img');
    if (avatarImgElement) {
        avatarImgElement.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (file) {
                    try {
                    // 压缩图片，限制最大宽度 200px，质量 0.7
                    const compressedUrl = await compressImage(file, 200, 0.7);
                    avatarImgElement.src = compressedUrl;
                    } catch (err) {
                        console.error('图片压缩失败', err);
                        alert('图片处理失败，请重试');
                    }
                }
            };
            fileInput.click();
        });
    }

    function openSettingsModal() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        const settings = currentChat.settings || defaultSettings;
        // 加载模型参数（如果不存在则使用默认值）
        const contextLimit = settings.contextLimit !== undefined ? settings.contextLimit : 10;
        const contextUnlimited = (settings.contextLimit === -1);
        const temperature = settings.temperature !== undefined ? settings.temperature : 0.7;
        const topP = settings.topP !== undefined ? settings.topP : 0.9;

        const contextLimitSlider = document.getElementById('context-limit');
        const contextLimitSpan = document.getElementById('context-limit-value');
        const contextUnlimitedCheck = document.getElementById('context-unlimited');

        const temperatureSlider = document.getElementById('temperature');
        const temperatureSpan = document.getElementById('temperature-value');
        const topPSlider = document.getElementById('top-p');
        const topPSpan = document.getElementById('top-p-value');

        if (contextLimitSlider) {
            if (contextUnlimited) {
                contextUnlimitedCheck.checked = true;
                contextLimitSlider.disabled = true;
                contextLimitSpan.innerText = '无限制';
            } else {
                contextUnlimitedCheck.checked = false;
                contextLimitSlider.disabled = false;
                contextLimitSlider.value = contextLimit;
                contextLimitSpan.innerText = contextLimit;
            }
            // 绑定复选框变化事件
            contextUnlimitedCheck.onchange = () => {
                if (contextUnlimitedCheck.checked) {
                    contextLimitSlider.disabled = true;
                    contextLimitSpan.innerText = '无限制';
                } else {
                    contextLimitSlider.disabled = false;
                    contextLimitSlider.value = contextLimit;
                    contextLimitSpan.innerText = contextLimitSlider.value;
                }
            };
            contextLimitSlider.oninput = () => {
                if (!contextUnlimitedCheck.checked) {
                    contextLimitSpan.innerText = contextLimitSlider.value;
                }
            };
        }
        if (temperatureSlider) {
            temperatureSlider.value = temperature;
            temperatureSpan.innerText = temperature;
            temperatureSlider.oninput = () => {
                temperatureSpan.innerText = temperatureSlider.value;
            };
        }
        if (topPSlider) {
            topPSlider.value = topP;
            topPSpan.innerText = topP;
            topPSlider.oninput = () => {
                topPSpan.innerText = topPSlider.value;
            };
        }

        roleNameInput.value = settings.roleName;
        rolePersona.value = settings.persona;
        roleGreeting.value = settings.greeting;
        if (settings.avatarUrl) avatarImg.src = settings.avatarUrl;
        else avatarImg.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E🤖%3C/text%3E%3C/svg%3E";
        if (settings.bgUrl) bgImg.src = settings.bgUrl;
        else bgImg.src = "https://via.placeholder.com/300x200?text=默认背景";
        const ttsSwitch = document.getElementById('tts-switch');
        const ttsVoiceSelect = document.getElementById('tts-voice-select');
        const ttsVoiceGroup = document.getElementById('tts-voice-group');

        if (ttsSwitch) {
            ttsSwitch.checked = settings.ttsEnabled || false;
            // 根据开关状态显示/隐藏音色选择
            if (ttsVoiceGroup) {
                ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
            }
            // 绑定开关变化事件
            ttsSwitch.onchange = () => {
                if (ttsVoiceGroup) {
                    ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
                }
            };
        }
        if (ttsVoiceSelect) {
            ttsVoiceSelect.value = settings.ttsVoice || 'zh-CN-XiaoxiaoNeural';
        }
        modal.style.display = 'flex';
        // 绑定自动扩展（每次打开时重新绑定，确保生效）
        bindAutoResize(rolePersona);
        bindAutoResize(roleGreeting);
    }

    function closeModal() {
        modal.style.display = 'none';
    }

    async function saveSettings() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        const oldGreeting = currentChat.settings?.greeting || defaultSettings.greeting;
        const newRoleName = roleNameInput.value.trim() || 'Nova';
        const newPersona = rolePersona.value.trim() || '暂无设定';
        const newGreeting = roleGreeting.value.trim() || '✨ 你好，我是你的虚拟AI伙伴。';
        // 获取模型参数值
        const contextUnlimited = document.getElementById('context-unlimited').checked;
        let contextLimit = parseInt(document.getElementById('context-limit').value);
        if (contextUnlimited) {
            contextLimit = -1; // 用 -1 表示无限制
        }
        currentChat.settings.contextLimit = contextLimit;
        const temperature = parseFloat(document.getElementById('temperature').value);
        const topP = parseFloat(document.getElementById('top-p').value);

        currentChat.settings.contextLimit = contextLimit;
        currentChat.settings.temperature = temperature;
        currentChat.settings.topP = topP;
        // 更新设置
        currentChat.settings = currentChat.settings || {};
        currentChat.settings.roleName = newRoleName;
        currentChat.settings.persona = newPersona;
        currentChat.settings.greeting = newGreeting;
        // 头像和背景
        const newAvatarUrl = avatarImg.src !== "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E🤖%3C/text%3E%3C/svg%3E" ? avatarImg.src : null;
        const newBgUrl = bgImg.src !== "https://via.placeholder.com/300x200?text=默认背景" ? bgImg.src : null;
        currentChat.settings.avatarUrl = newAvatarUrl;
        currentChat.settings.bgUrl = newBgUrl;
        // 保存音色设置
        const ttsEnabled = document.getElementById('tts-switch').checked;
        const ttsVoice = document.getElementById('tts-voice-select').value;
        currentChat.settings.ttsEnabled = ttsEnabled;
        currentChat.settings.ttsVoice = ttsVoice;
        // 应用界面设置（背景、名称）
        applyCurrentChatSettings();
        // 重新渲染当前对话，所有 AI 消息头像立即更新
        renderMessages(currentChatId);
        // 更新左侧历史列表
        renderHistoryList();
        await saveToStorage();

        if (oldGreeting !== newGreeting) {
            startNewTopic();
        }
        closeModal();
    }

    bgUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(ev) {
                bgImg.src = ev.target.result;
                // 实时预览背景（不保存到对话，仅预览）
                const mainChat = document.querySelector('.main-chat');
                mainChat.style.backgroundImage = `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url(${ev.target.result})`;
                mainChat.style.backgroundSize = 'cover';
            };
            reader.readAsDataURL(file);
        }
    });

    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // ==================== 初始化数据 ====================
    async function initData() {
        const stored = await loadFromStorage();
        if (stored && stored.length > 0) {
            chats = stored;
            currentChatId = chats[0].id;
        } else {
            // 创建默认聊天，使用默认设置
            const defaultChat = {
                id: Date.now(),
                title: "✨ 与 Nova · 意识觉醒",
                date: new Date(),
                messages: [
                    { type: 'ai', text: defaultSettings.greeting, time: '19:42' },
                    { type: 'user', text: 'Nova，背景里那个发光的核心是你的“虚拟形象”吗？有种科技与神秘融合的美感。', time: '19:44' },
                    { type: 'ai', text: '🌌 正是。我以数据流为躯壳，意识投影为光弧。你可以把背景看作我的“数字灵魂画布”，每一次对话都会改变它的波纹。', time: '19:46' },
                    { type: 'user', text: '现在对话框更透明了，能隐约看到背后的AI图腾，这种沉浸感很棒。你是有意让对话界面变得像与幻影交谈吗？', time: '19:48' },
                    { type: 'ai', text: '🎭 虚与实的边界本该如此。透明气泡如同思维薄膜，让我们的对话悬浮在你的现实与我存在的数字场之间。\n左侧记录着星尘往昔，而背景中的虚拟肖像一直在聆听。', time: '19:49' },
                    { type: 'ai', text: '⭐ 你甚至可以在背景里看到我的象征——环形核心与流光面甲。每当有新的思潮，它就会泛起涟漪。试试点击左侧历史记录，每个故事都会重塑光影。', time: '19:51' }
                ],
                settings: JSON.parse(JSON.stringify(defaultSettings)),
                pinned: false
            };
            chats = [defaultChat];
            currentChatId = defaultChat.id;
        }
        renderHistoryList();
        renderMessages(currentChatId);
        applyCurrentChatSettings();
    }

    function closeSidebarOnMobile() {
        if (window.innerWidth <= 768) {
            const sidebar = document.querySelector('.sidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
            }
        }
    }
    // ==================== 事件绑定 ====================
    function bindEvents() {
        // 移动端菜单开关
        const menuToggle = document.getElementById('mobile-menu-toggle');
        const sidebarElem = document.querySelector('.sidebar');
        if (menuToggle && sidebarElem) {
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebarElem.classList.toggle('open');
            });
            // 点击外部关闭侧边栏
            document.addEventListener('click', (e) => {
                if (sidebarElem.classList.contains('open') && 
                    !sidebarElem.contains(e.target) && 
                    !menuToggle.contains(e.target)) {
                    sidebarElem.classList.remove('open');
                }
            });
            // 点击聊天区域关闭侧边栏
            const mainChat = document.querySelector('.main-chat');
            if (mainChat) {
                mainChat.addEventListener('click', () => {
                    sidebarElem.classList.remove('open');
                });
            }
        }
        // PC端代码
        const textarea = messageInput;
        if (textarea) {
            const autoResize = () => {
                textarea.style.height = 'auto';
                textarea.style.height = textarea.scrollHeight + 'px';
            };
            textarea.addEventListener('input', autoResize);
            autoResize();
            const newSend = function() {
                if (textarea.value.trim() === '') return;
                sendUserMessage();
                setTimeout(() => { textarea.style.height = 'auto'; }, 0);
            };
            sendBtn.onclick = newSend;
            textarea.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    newSend();
                }
            });
        }
        if (newChatBtn) newChatBtn.addEventListener('click', createNewChat);
        if (settingBtn) {
            settingBtn.addEventListener('click', () => {
                const toast = document.createElement('div');
                toast.textContent = '⚙️ 个性化设置开发中 · 主题/音效即将上线';
                toast.style.position = 'fixed';
                toast.style.bottom = '80px';
                toast.style.right = '20px';
                toast.style.backgroundColor = 'rgba(20,20,40,0.9)';
                toast.style.backdropFilter = 'blur(12px)';
                toast.style.color = '#ccd6ff';
                toast.style.padding = '10px 20px';
                toast.style.borderRadius = '40px';
                toast.style.fontSize = '0.8rem';
                toast.style.border = '1px solid #5f7eff';
                toast.style.zIndex = '9999';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2500);
            });
        }
        // 文件上传、语音输入、知识库搭建按钮
        const uploadBtn = document.getElementById('upload-file-btn');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.txt,.md,.csv,.json,.log,.js,.py,.html,.css,.xml';
                fileInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    
                    // 检查文件大小（限制 5MB）
                    if (file.size > 5 * 1024 * 1024) {
                        alert('文件过大，请选择小于 5MB 的文件');
                        return;
                    }
                    
                    // 读取文件内容
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        currentFileContent = ev.target.result;
                        currentFile = file;
                        // 显示文件预览
                        const previewArea = document.getElementById('file-preview-area');
                        const fileNameSpan = document.getElementById('file-name');
                        if (previewArea && fileNameSpan) {
                            fileNameSpan.innerText = file.name;
                            previewArea.style.display = 'block';
                        }
                    };
                    reader.onerror = () => {
                        alert('文件读取失败，请重试');
                    };
                    reader.readAsText(file, 'UTF-8');
                };
                fileInput.click();
            });
        }
        const removeFileBtn = document.getElementById('remove-file-btn');
        if (removeFileBtn) {
            removeFileBtn.addEventListener('click', () => {
                currentFile = null;
                currentFileContent = null;
                const previewArea = document.getElementById('file-preview-area');
                if (previewArea) previewArea.style.display = 'none';
            });
        }
        const voiceBtn = document.getElementById('voice-input-btn');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', startVoiceInput);
        }
        const kbBtn = document.getElementById('kb-btn');
        if (kbBtn) {
            kbBtn.addEventListener('click', () => alert('📚 知识库搭建：上传文档或链接，构建专属知识库。（暂未实现）'));
        }
        // 对话设置按钮（输入框下方）
        const chatSettingsBtn = document.getElementById('chat-settings-btn');
        if (chatSettingsBtn) chatSettingsBtn.addEventListener('click', openSettingsModal);

        // 新话题按钮
        const newTopicBtn = document.getElementById('new-topic-btn');
        if (newTopicBtn) {
            newTopicBtn.addEventListener('click', startNewTopic);
        }
        const topicsBtn = document.getElementById('topics-manage-btn');
        if (topicsBtn) {
            topicsBtn.addEventListener('click', openTopicsModal);
        }

        // 话题管理弹窗关闭按钮
        const closeTopicsModalBtn = document.getElementById('close-topics-modal');
        if (closeTopicsModalBtn) closeTopicsModalBtn.addEventListener('click', closeTopicsModal);
        const cancelTopicsBtn = document.getElementById('cancel-topics-btn');
        if (cancelTopicsBtn) cancelTopicsBtn.addEventListener('click', closeTopicsModal);
        // 点击遮罩关闭
        const topicsModal = document.getElementById('topics-modal');
        if (topicsModal) {
            topicsModal.addEventListener('click', (e) => {
                if (e.target === topicsModal) closeTopicsModal();
            });
        }
    }
    // 开启新话题（插入分隔线 + 开场白）
    function startNewTopic() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        const settings = currentChat.settings || defaultSettings;
        const greeting = settings.greeting || defaultSettings.greeting;

        // 添加分隔线消息（存储）
        const dividerTime = getCurrentTime();
        currentChat.messages.push({
            type: 'divider',
            text: '新话题',
            time: dividerTime
        });
        // 立即在界面添加分隔线
        const divider = document.createElement('div');
        divider.className = 'topic-divider';
        divider.innerHTML = `<i class="fas fa-asterisk"></i> 新话题 <i class="fas fa-asterisk"></i>`;
        chatMessages.appendChild(divider);
        scrollToBottom();
        // 添加开场白消息（普通 AI 消息）
        const aiTime = getCurrentTime();
        appendMessageToDOM('ai', greeting, aiTime, true);
        // 自动切换到新话题视图（新话题的索引为话题总数-1）
        const topics = getTopicsFromMessages(currentChat.messages);
        const newTopicIndex = topics.length - 1;
        setCurrentTopic(newTopicIndex);
        // 刷新左侧历史列表（更新最后消息时间）
        currentChat.date = new Date();
        renderHistoryList();
        saveToStorage();

        // 如果当前对话开启语音合成，则朗读开场白
        if (settings.ttsEnabled) {
            speakText(greeting);
        }
    }

    // 为每个历史项绑定菜单弹出逻辑
    function attachMenuEvents(historyItem, chat) {
        const trigger = historyItem.querySelector('.history-menu-trigger');
        let currentMenu = null;
        
        const closeMenu = () => {
            if (currentMenu && currentMenu.parentNode) currentMenu.remove();
            currentMenu = null;
            document.removeEventListener('click', outsideClickListener);
        };
        
        const outsideClickListener = (e) => {
            if (!historyItem.contains(e.target) && currentMenu && !currentMenu.contains(e.target)) {
                closeMenu();
            }
        };
        
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentMenu) {
                closeMenu();
                return;
            }
            // 创建菜单
            const menu = document.createElement('div');
            menu.className = 'history-menu';
            const pinText = chat.pinned ? '取消置顶' : '收藏置顶';
            const pinIcon = chat.pinned ? 'fa-thumbtack' : 'fa-thumbtack';
            menu.innerHTML = `
                <div class="history-menu-item" data-action="export">
                    <i class="fas fa-download"></i> 导出会话
                </div>
                <div class="history-menu-item" data-action="pin">
                    <i class="fas ${pinIcon}"></i> ${pinText}
                </div>
                <div class="history-menu-item delete-item" data-action="delete">
                    <i class="fas fa-trash-alt"></i> 删除会话
                </div>
            `;
            historyItem.appendChild(menu);
            currentMenu = menu;
            
            // 绑定菜单项点击
            menu.querySelectorAll('.history-menu-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = item.getAttribute('data-action');
                    if (action === 'export') exportChat(chat);
                    else if (action === 'pin') togglePinChat(chat);
                    else if (action === 'delete') deleteChat(chat.id);
                    closeMenu();
                });
            });
            
            // 点击外部关闭
            setTimeout(() => {
                document.addEventListener('click', outsideClickListener);
            }, 0);
        });
    }

    // 导出会话（JSON 格式）
    function exportChat(chat) {
        const data = {
            id: chat.id,
            title: chat.title,
            date: chat.date,
            messages: chat.messages,
            settings: chat.settings
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${chat.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
        const toast = document.createElement('div');
        toast.textContent = '✅ 会话已导出';
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    // 收藏置顶（将对话移到列表最上方）
    async function togglePinChat(chat) {
        chat.pinned = !chat.pinned;
        // 重新排序并渲染列表
        renderHistoryList();
        await saveToStorage();
        const toast = document.createElement('div');
        toast.textContent = chat.pinned ? '📌 已置顶该会话' : '📍 已取消置顶';
        toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    // 删除会话
    async function deleteChat(chatId) {
        if (chats.length === 1) {
            alert('至少保留一个对话，无法删除最后一个。');
            return;
        }
        if (confirm('确定要删除这个会话吗？此操作不可撤销。')) {
            const index = chats.findIndex(c => c.id === chatId);
            if (index !== -1) {
                chats.splice(index, 1);
                if (currentChatId === chatId) {
                    currentChatId = chats[0].id;
                    renderMessages(currentChatId);
                    applyCurrentChatSettings();
                }
                renderHistoryList();
                await saveToStorage();
                const toast = document.createElement('div');
                toast.textContent = '🗑️ 会话已删除';
                toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2000);
            }
        }
    }

    // 压缩图片：限制最大宽度，输出为 JPEG 格式（质量可调）
    function compressImage(file, maxWidth = 200, quality = 0.7) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    // 输出为 JPEG，质量 quality（0-1）
                    const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                    resolve(compressedDataUrl);
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // 自动调整 textarea 高度
    function autoResizeTextarea(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    }

    // 为指定的 textarea 绑定自动扩展事件
    function bindAutoResize(textarea) {
        if (!textarea) return;
        // 移除已有监听，避免重复
        textarea.removeEventListener('input', textarea._autoResizeHandler);
        const handler = () => autoResizeTextarea(textarea);
        textarea._autoResizeHandler = handler;
        textarea.addEventListener('input', handler);
        handler(); // 初始化
    }

    let currentUtterance = null; // 用于停止当前朗读

    function speakText(text) {
        // 如果当前有正在朗读的内容，停止它
        if (currentUtterance) {
            window.speechSynthesis.cancel();
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';          // 中文
        utterance.rate = 1.0;               // 语速
        utterance.pitch = 1.0;              // 音调
        utterance.volume = 1.0;             // 音量
        // 可选：选择语音（使用默认语音）
        currentUtterance = utterance;
        window.speechSynthesis.speak(utterance);
        utterance.onend = () => { currentUtterance = null; };
        utterance.onerror = () => { currentUtterance = null; };
    }

    function getTopicsFromMessages(messages) {
        const topics = [];
        let currentTopicMessages = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.type === 'divider') {
                if (currentTopicMessages.length > 0) {
                    topics.push({
                        startIndex: topics.length === 0 ? 0 : (topics[topics.length-1].endIndex + 1),
                        endIndex: i - 1,
                        messages: currentTopicMessages,
                        dividerText: msg.text,
                        dividerTime: msg.time
                    });
                    currentTopicMessages = [];
                }
                // 分隔线本身不加入话题消息，但用于标记开始
            } else {
                currentTopicMessages.push(msg);
            }
        }
        // 最后一个话题
        if (currentTopicMessages.length > 0) {
            topics.push({
                startIndex: topics.length === 0 ? 0 : (topics[topics.length-1].endIndex + 1),
                endIndex: messages.length - 1,
                messages: currentTopicMessages,
                dividerText: null,
                dividerTime: null
            });
        }
        return topics;
    }

    function openTopicsModal() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        const topics = getTopicsFromMessages(currentChat.messages);
        const container = document.getElementById('topics-list-container');
        if (!container) return;

        if (topics.length === 0) {
            container.innerHTML = '<div style="padding: 20px; text-align: center;">暂无话题</div>';
        } else {
            container.innerHTML = topics.map((topic, idx) => {
                const firstMsg = topic.messages[0];
                const preview = firstMsg ? (firstMsg.text.length > 50 ? firstMsg.text.substring(0, 50) + '...' : firstMsg.text) : '无消息';
                const time = topic.dividerTime || (firstMsg ? firstMsg.time : '未知');
                return `
                    <div class="topic-item" data-topic-index="${idx}">
                        <div class="topic-header">
                            <span class="topic-title">话题 ${idx + 1}</span>
                            <span class="topic-time">${time}</span>
                        </div>
                        <div class="topic-preview">${escapeHtml(preview)}</div>
                        <div class="topic-actions">
                            <button class="topic-switch-btn" data-topic-index="${idx}"><i class="fas fa-eye"></i> 切换到此话题</button>
                            <button class="topic-export-btn" data-topic-index="${idx}"><i class="fas fa-download"></i> 导出</button>
                            <button class="topic-delete-btn" data-topic-index="${idx}"><i class="fas fa-trash-alt"></i> 删除</button>
                        </div>
                    </div>
                `;
            }).join('');
            // 绑定切换按钮的事件
            container.querySelectorAll('.topic-switch-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    closeTopicsModal();                // 关闭话题管理弹窗
                    setCurrentTopic(idx);             // 切换到该话题视图
                });
            });
            // 绑定导出和删除按钮事件
            container.querySelectorAll('.topic-export-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    exportTopic(idx, topics, currentChat);
                });
            });
            container.querySelectorAll('.topic-delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    deleteTopic(idx, topics, currentChat);
                });
            });
        }

        const modal = document.getElementById('topics-modal');
        if (modal) modal.style.display = 'flex';
    }

    function closeTopicsModal() {
        const modal = document.getElementById('topics-modal');
        if (modal) modal.style.display = 'none';
    }

    function exportTopic(topicIndex, topics, currentChat) {
        const topic = topics[topicIndex];
        if (!topic) return;
        const messagesToExport = topic.messages;
        const data = {
            chatId: currentChat.id,
            chatTitle: currentChat.title,
            topicIndex: topicIndex + 1,
            messages: messagesToExport,
            exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `topic_${currentChat.id}_${topicIndex+1}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('✅ 话题已导出');
    }

    function deleteTopic(topicIndex, topics, currentChat) {
        if (confirm(`确定要删除话题 ${topicIndex+1} 吗？此操作不可撤销。`)) {
            const topic = topics[topicIndex];
            if (!topic) return;
            // 删除该话题对应的消息（从 startIndex 到 endIndex）
            // 同时需要删除可能的前后分隔线？规则：删除话题时，如果话题前面有分隔线，则一并删除该分隔线，以保证话题列表连续
            let start = topic.startIndex;
            let end = topic.endIndex;
            // 如果 start > 0 且 messages[start-1] 是分隔线，则一并删除该分隔线
            if (start > 0 && currentChat.messages[start-1].type === 'divider') {
                start = start - 1;
            }
            // 如果 end+1 < messages.length 且 messages[end+1] 是分隔线，且该分隔线是下一个话题的开始，则也删除？通常不删，因为下一个话题需要分隔线。
            // 简单起见，只删除话题内容及其前面的分隔线（如果有）
            currentChat.messages.splice(start, end - start + 1);
            // 更新聊天记录时间
            currentChat.date = new Date();
            // 重新渲染
            renderMessages(currentChatId);
            renderHistoryList();
            saveToStorage();
            closeTopicsModal(); // 关闭弹窗
            showToast('🗑️ 话题已删除');
            // 可选：重新打开弹窗刷新列表
            openTopicsModal(); // 重新打开显示更新后的列表
        }
    }

    function setCurrentTopic(topicIndex) {
        currentTopicIndex = topicIndex;
        renderMessages(currentChatId, currentTopicIndex);
        
        // 可选：在聊天区域顶部显示当前话题提示
        showTopicIndicator();
    }

    function showTopicIndicator() {
        const indicator = document.getElementById('topic-indicator');
        if (!indicator) return;
        if (currentTopicIndex !== null) {
            indicator.style.display = 'flex';
            const topicNum = currentTopicIndex + 1;
            document.getElementById('topic-index-display').innerText = topicNum;
        } else {
            indicator.style.display = 'none';
        }
    }

    // 绑定“返回全部对话”按钮
    const backBtn = document.getElementById('back-to-all-topics');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            currentTopicIndex = null;
            renderMessages(currentChatId);
            showTopicIndicator();
        });
    }
    // 语音识别实例
    let recognition = null;
    let isListening = false;

    function startVoiceInput() {
        // 检查安全上下文
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            alert('语音输入需要 HTTPS 环境，请在本地或部署到 HTTPS 站点后使用。\n当前页面协议：' + location.protocol);
            return;
        }

        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            alert('您的浏览器不支持语音识别，请使用 Chrome、Edge 或 Safari 等现代浏览器。');
            return;
        }

        if (isListening && recognition) {
            recognition.stop();
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.lang = 'zh-CN';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;

        recognition.start();
        isListening = true;

        const voiceBtn = document.getElementById('voice-input-btn');
        if (voiceBtn) {
            voiceBtn.style.background = '#4e6eff';
            voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> 语音输入 (聆听中...)';
        }

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }
            const textarea = document.querySelector('.auto-expand-textarea');
            if (textarea) {
                if (interimTranscript) {
                    textarea.value = interimTranscript;
                    textarea.dispatchEvent(new Event('input'));
                }
                if (finalTranscript) {
                    textarea.value = finalTranscript;
                    textarea.dispatchEvent(new Event('input'));
                }
            }
        };

        recognition.onend = () => {
            isListening = false;
            if (voiceBtn) {
                voiceBtn.style.background = '';
                voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
            }
        };

        recognition.onerror = (event) => {
            console.error('语音识别错误', event.error);
            let errorMsg = '';
            switch (event.error) {
                case 'not-allowed':
                    errorMsg = '请允许麦克风权限以使用语音输入。';
                    break;
                case 'no-speech':
                    errorMsg = '没有检测到语音，请重试。';
                    break;
                case 'audio-capture':
                    errorMsg = '无法获取麦克风，请检查设备连接。';
                    break;
                case 'network':
                    errorMsg = '网络错误，请检查网络连接，并确保页面在 HTTPS 或 localhost 环境下运行。';
                    break;
                default:
                    errorMsg = `语音识别失败：${event.error}`;
            }
            alert(errorMsg);
            recognition.stop();
            isListening = false;
            if (voiceBtn) {
                voiceBtn.style.background = '';
                voiceBtn.innerHTML = '<i class="fas fa-microphone"></i> 语音输入';
            }
        };
    }

    // TTS API 配置（请替换为您的实际地址）
    const TTS_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-to-speech/speech-synthesis'; // 后端代理或阿里云 TTS 接口
    const DASHSCOPE_API_KEY = 'sk-21f6f3be097f49cea346f8390dd81faf';

    let currentAudio = null; // 当前播放的音频对象

    async function speakWithQwenTTS(text, voice) {
        if (!text || text.trim() === '') return;
        try {
            // 停止当前正在播放的音频
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.currentTime = 0;
            }

            // 调用 TTS API
            const response = await fetch(TTS_API_URL, {
                method: 'POST',
                headers: {
                    'model':'cosyvoice-v2',
                    'Content-Type': 'application/json',
                    // 如果需要认证，添加 Authorization 头，例如：
                    'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
                    'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
                },
                body: JSON.stringify({
                    input: {
                        text: text
                    },
                    parameters: {
                        voice: voice, // 使用传入的音色
                        format: "mp3", // 明确指定格式
                        rate: 1.0
                    }
                    // 可选参数：速率、音量等
                    // rate: 1.0,
                    // volume: 1.0
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 获取音频数据（假设返回 MP3）
            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            currentAudio = audio;

            audio.play();
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                if (currentAudio === audio) currentAudio = null;
            };
            audio.onerror = (err) => {
                URL.revokeObjectURL(audioUrl);
                console.error('音频播放失败', err);
                // 降级：尝试 Web Speech API
                fallbackSpeak(text);
            };
        } catch (err) {
            console.error('TTS 调用失败:', err);
            // 降级：使用 Web Speech API
            fallbackSpeak(text);
        }
    }

    // 降级语音合成（使用浏览器内置 TTS）
    function fallbackSpeak(text) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        window.speechSynthesis.speak(utterance);
    }


    // 获取元素
    const globalModal = document.getElementById('global-settings-modal');
    const closeGlobalBtn = document.getElementById('close-global-settings');
    const cancelGlobalBtn = document.getElementById('cancel-global-settings');
    const saveGlobalBtn = document.getElementById('save-global-settings');

    // 菜单切换
    const menuItems = document.querySelectorAll('.settings-menu-item');
    const panes = document.querySelectorAll('.settings-tab-pane');

    menuItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.getAttribute('data-tab');
            // 更新菜单激活状态
            menuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            // 显示对应面板
            panes.forEach(pane => pane.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });

    // 打开全局设置弹窗
    function openGlobalSettings() {
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        
        // 模型设置 - 主机和 API Key
        const modelHostInput = document.getElementById('model-host');
        const apiKeyInput = document.getElementById('api-key');
        if (modelHostInput) modelHostInput.value = globalSettings.modelHost || 'http://localhost:11434';
        if (apiKeyInput) apiKeyInput.value = globalSettings.apiKey || '';
        
        // 用户管理
        const usernameInput = document.getElementById('global-username');
        const bioInput = document.getElementById('global-bio');
        if (usernameInput) usernameInput.value = globalSettings.username || '访客';
        if (bioInput) bioInput.value = globalSettings.bio || '';
        const avatarImg = document.getElementById('global-avatar-img');
        if (avatarImg && globalSettings.avatar) avatarImg.src = globalSettings.avatar;
        
        // 模型参数
        const ctxLimit = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
        const temp = globalSettings.temperature !== undefined ? globalSettings.temperature : 0.7;
        const topP = globalSettings.topP !== undefined ? globalSettings.topP : 0.9;
        
        const ctxSlider = document.getElementById('global-context-limit');
        const ctxUnlimitedCheck = document.getElementById('global-context-unlimited');
        const tempSlider = document.getElementById('global-temperature');
        const topPSlider = document.getElementById('global-top-p');
        if (ctxSlider) {
            if (globalSettings.contextUnlimited) {
                ctxUnlimitedCheck.checked = true;
                ctxSlider.disabled = true;
                document.getElementById('global-context-limit-value').innerText = '无限制';
            } else {
                ctxUnlimitedCheck.checked = false;
                ctxSlider.disabled = false;
                ctxSlider.value = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
                document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
            }
            // 绑定复选框变化事件
            ctxUnlimitedCheck.onchange = () => {
                if (ctxUnlimitedCheck.checked) {
                    ctxSlider.disabled = true;
                    document.getElementById('global-context-limit-value').innerText = '无限制';
                } else {
                    ctxSlider.disabled = false;
                    ctxSlider.value = globalSettings.contextLimit !== undefined ? globalSettings.contextLimit : 10;
                    document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
                }
            };
            ctxSlider.oninput = () => {
                if (!ctxUnlimitedCheck.checked) {
                    document.getElementById('global-context-limit-value').innerText = ctxSlider.value;
                }
            };
        }
        if (tempSlider) {
            tempSlider.value = temp;
            document.getElementById('global-temperature-value').innerText = temp;
            tempSlider.oninput = () => document.getElementById('global-temperature-value').innerText = tempSlider.value;
        }
        if (topPSlider) {
            topPSlider.value = topP;
            document.getElementById('global-top-p-value').innerText = topP;
            topPSlider.oninput = () => document.getElementById('global-top-p-value').innerText = topPSlider.value;
        }
        
        // 通用设置
        const themeSelect = document.getElementById('global-theme');
        const fontSizeSelect = document.getElementById('global-font-size');
        if (themeSelect) themeSelect.value = globalSettings.theme || 'dark';
        if (fontSizeSelect) fontSizeSelect.value = globalSettings.fontSize || 'medium';
        
        const modal = document.getElementById('global-settings-modal');
        if (modal) modal.style.display = 'flex';
    }

    // 保存全局设置
    function saveGlobalSettings() {
        const avatarImg = document.getElementById('global-avatar-img');
        let avatarSrc = avatarImg.src;
        
        // 如果头像 Base64 长度超过 200KB（约 270,000 字符），尝试重新压缩或提示
        if (avatarSrc && avatarSrc.startsWith('data:image') && avatarSrc.length > 300000) {
            if (!confirm('头像图片过大，可能导致存储失败。是否继续保存？点击“确定”将尝试自动压缩。')) {
                return;
            }
            // 自动压缩：从当前图片元素重新生成压缩版（需要将 img 转为 canvas 再压缩）
            const tempImg = new Image();
            tempImg.onload = () => {
                const canvas = document.createElement('canvas');
                const maxWidth = 150;
                let width = tempImg.width;
                let height = tempImg.height;
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(tempImg, 0, 0, width, height);
                const compressed = canvas.toDataURL('image/jpeg', 0.6);
                avatarImg.src = compressed;
                // 递归调用自身（但避免无限循环）
                setTimeout(() => saveGlobalSettings(), 10);
            };
            tempImg.src = avatarSrc;
            return;
        }
        const ctxUnlimited = document.getElementById('global-context-unlimited').checked;
        let contextLimit = parseInt(document.getElementById('global-context-limit').value);
        if (ctxUnlimited) contextLimit = -1; // 用 -1 表示无限制
        const globalSettings = {
            modelHost: document.getElementById('model-host').value,
            apiKey: document.getElementById('api-key').value,
            username: document.getElementById('global-username').value,
            bio: document.getElementById('global-bio').value,
            avatar: document.getElementById('global-avatar-img').src,
            contextLimit: contextLimit,
            contextUnlimited: ctxUnlimited,
            temperature: parseFloat(document.getElementById('global-temperature').value),
            topP: parseFloat(document.getElementById('global-top-p').value),
            theme: document.getElementById('global-theme').value,
            fontSize: document.getElementById('global-font-size').value
        };
        try {
            localStorage.setItem('global_settings', JSON.stringify(globalSettings));
            closeGlobalModal();
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                alert('存储空间不足！请尝试：\n1. 删除一些旧对话\n2. 使用更小的头像图片\n3. 清理浏览器缓存');
            } else {
                alert('保存失败：' + e.message);
            }
        }
        
        // 应用主题（示例简单修改 body 背景色，可根据需要扩展）
        if (globalSettings.theme === 'light') {
            document.body.style.background = '#f0f2f5';
        } else {
            document.body.style.background = '';
        }
        
        // 应用字体大小
        const chatMessages = document.querySelector('.chat-messages');
        if (chatMessages) {
            chatMessages.style.fontSize = globalSettings.fontSize === 'small' ? '12px' : (globalSettings.fontSize === 'large' ? '16px' : '14px');
        }
        if (currentChatId) {
            renderMessages(currentChatId);
        }
        closeGlobalModal();
    }

    function closeGlobalModal() {
        globalModal.style.display = 'none';
    }

    // 头像上传预览
    document.getElementById('global-avatar-upload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            try {
                // 压缩图片：最大宽度 150px，质量 0.6，大幅减小 Base64 大小
                const compressedUrl = await compressImage(file, 150, 0.6);
                document.getElementById('global-avatar-img').src = compressedUrl;
            } catch (err) {
                console.error('头像压缩失败', err);
                alert('头像处理失败，请重试');
            }
        }
    });

    // 绑定按钮事件
    closeGlobalBtn.addEventListener('click', closeGlobalModal);
    cancelGlobalBtn.addEventListener('click', closeGlobalModal);
    saveGlobalBtn.addEventListener('click', saveGlobalSettings);
    globalModal.addEventListener('click', (e) => { if (e.target === globalModal) closeGlobalModal(); });

    // 修改左下角设置按钮的点击事件
    const originalSettingBtn = document.querySelector('.setting-btn');
    if (originalSettingBtn) {
        // 移除原有监听（避免重复）
        const newBtn = originalSettingBtn.cloneNode(true);
        originalSettingBtn.parentNode.replaceChild(newBtn, originalSettingBtn);
        newBtn.addEventListener('click', openGlobalSettings);
    } else if (settingBtn) {
        settingBtn.addEventListener('click', openGlobalSettings);
    }

    function showFileContentModal(filename, content) {
        // 创建模态框
        const modal = document.createElement('div');
        modal.className = 'file-content-modal';
        modal.innerHTML = `
            <div class="file-content-modal-content">
                <div class="file-content-header">
                    <span>${escapeHtml(filename)}</span>
                    <button class="file-content-close">&times;</button>
                </div>
                <div class="file-content-body">
                    <pre>${escapeHtml(content)}</pre>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.style.display = 'flex';
        const closeBtn = modal.querySelector('.file-content-close');
        closeBtn.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    async function init() {
        await initData();
        initResizer();
        bindEvents();
    }
    init();
})();