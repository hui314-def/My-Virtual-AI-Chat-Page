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
    let modelList = [];  // 存储模型名称字符串
    let autoScrollEnabled = true;     // 是否允许自动滚动
    const SCROLL_THRESHOLD = 20;      // 距离底部阈值（px）
    let currentTTSController = null;
    let isTTSSpeaking = false;   // 是否正在语音合成/播放

    function updateAutoScrollFlag() {
        if (!chatMessages) return;
        const { scrollTop, scrollHeight, clientHeight } = chatMessages;
        const atBottom = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
        autoScrollEnabled = atBottom;
    }

    function conditionalScrollToBottom() {
        if (autoScrollEnabled) {
            scrollToBottom();
        }
    }

    function forceScrollToBottom() {
        autoScrollEnabled = true;
        scrollToBottom();
    }

    function loadModelList() {
        const stored = localStorage.getItem('model_list');
        if (stored) {
            modelList = JSON.parse(stored);
        } else {
            // 默认模型列表（从全局设置中读取已有的模型名称作为初始项）
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const currentModel = globalSettings.modelName || 'gemma2';
            modelList = [currentModel];
            localStorage.setItem('model_list', JSON.stringify(modelList));
        }
        renderModelListUI();
    }

    function saveModelList() {
        localStorage.setItem('model_list', JSON.stringify(modelList));
        renderModelListUI();  // 刷新UI
        // 同时更新快速切换下拉菜单（如果已存在）
        updateModelSelector();
    }

    function renderModelListUI() {
        const container = document.getElementById('model-list-container');
        if (!container) return;
        if (modelList.length === 0) {
            container.innerHTML = '<div style="padding: 8px; text-align: center; opacity: 0.6;">暂无模型，请添加</div>';
            return;
        }
        container.innerHTML = modelList.map(model => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(100,130,255,0.2);">
                <span>🤖 ${escapeHtml(model)}</span>
                <div>
                    <button class="select-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #5f7eff; cursor: pointer; margin-right: 8px;">✓ 使用</button>
                    <button class="delete-model-btn" data-model="${escapeHtml(model)}" style="background: none; border: none; color: #ff8a7a; cursor: pointer;">🗑 删除</button>
                </div>
            </div>
        `).join('');

        // 绑定使用和删除事件
        document.querySelectorAll('.select-model-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const modelName = btn.getAttribute('data-model');
                // 更新全局设置中的当前模型
                const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
                globalSettings.modelName = modelName;
                localStorage.setItem('global_settings', JSON.stringify(globalSettings));
                // 更新全局设置弹窗中的模型名称输入框
                const modelNameInput = document.getElementById('global-model-name');
                if (modelNameInput) modelNameInput.value = modelName;
                // 刷新快速切换下拉菜单
                updateModelSelector();
                alert(`已切换到模型：${modelName}`);
            });
        });
        document.querySelectorAll('.delete-model-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const modelName = btn.getAttribute('data-model');
                if (modelList.length === 1) {
                    alert('至少保留一个模型');
                    return;
                }
                modelList = modelList.filter(m => m !== modelName);
                saveModelList();
                // 如果删除的是当前使用的模型，则自动切换到列表第一个
                const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
                if (globalSettings.modelName === modelName) {
                    globalSettings.modelName = modelList[0];
                    localStorage.setItem('global_settings', JSON.stringify(globalSettings));
                    const modelNameInput = document.getElementById('global-model-name');
                    if (modelNameInput) modelNameInput.value = modelList[0];
                    updateModelSelector();
                }
            });
        });
    }
    function updateModelSelector() {
        const select = document.getElementById('quick-model-select');
        if (!select) return;
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const currentModel = globalSettings.modelName || 'gemma2';
        select.innerHTML = '';
        modelList.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            if (model === currentModel) option.selected = true;
            select.appendChild(option);
        });
        if (modelList.length === 0) {
            select.innerHTML = '<option>无模型</option>';
        }
    }

    // 监听快速切换
    function bindQuickModelSwitch() {
        const select = document.getElementById('quick-model-select');
        if (!select) return;
        select.addEventListener('change', (e) => {
            const newModel = e.target.value;
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            globalSettings.modelName = newModel;
            localStorage.setItem('global_settings', JSON.stringify(globalSettings));
            // 同步更新全局设置弹窗中的输入框
            const modelNameInput = document.getElementById('global-model-name');
            if (modelNameInput) modelNameInput.value = newModel;
            // 可选：显示提示
            const toast = document.createElement('div');
            toast.textContent = `已切换到模型：${newModel}`;
            toast.style.cssText = 'position:fixed; bottom:80px; right:20px; background:#2a2f55; color:white; padding:8px 16px; border-radius:20px; z-index:10000;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
        });
    }
    // 添加模型
    function addModel(modelName) {
        modelName = modelName.trim();
        if (!modelName) return false;
        if (modelList.includes(modelName)) {
            alert('模型已存在');
            return false;
        }
        modelList.push(modelName);
        saveModelList();
        return true;
    }

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
            newWidth = Math.min(500, Math.max(220, newWidth));
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
                                <option value="">加载中...</option>
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
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
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
    async function appendMessageToDOM(type, text, time, saveToStorageFlag = false, chatIdForSave = null, customAvatarUrl = null, fileAttachment = null, modelName = null) {
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
                avatarHtml = `<img src="${avatarUrl}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">`;
            } else {
                avatarHtml = '<i class="fas fa-robot"></i>';
            }
        } else {
            // 用户头像：从全局设置中获取
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const userAvatar = globalSettings.avatar;
            if (userAvatar && userAvatar.startsWith('data:image')) {
                avatarHtml = `<img src="${userAvatar}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">`;
            } else {
                avatarHtml = '<i class="fas fa-user-astronaut"></i>';
            }
        }
        
        // 消息气泡内容
        let bubbleContent = '';
        if (type === 'ai') {
            bubbleContent = renderMessageWithThink(text);
        } else {
            bubbleContent = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
        }
        if (type === 'user' && fileAttachment) {
            // 添加可点击的文件链接
            bubbleContent += `<div class="file-attachment" data-filename="${escapeHtml(fileAttachment.name)}" data-content="${escapeHtml(fileAttachment.content)}">
                <i class="fas fa-paperclip"></i> ${escapeHtml(fileAttachment.name)}
            </div>`;
        }
        let displayTime = time || getCurrentTime();
        let timeHtml = `<div class="msg-time">`;
        if (type === 'ai' && modelName) {
            timeHtml += `<span style="margin-right: 8px; font-size: 0.65rem; opacity: 0.7;">🤖 ${escapeHtml(modelName)}</span>`;
        }
        timeHtml += `${escapeHtml(displayTime)}</div>`;
        bubbleContent += timeHtml;
        
        messageDiv.innerHTML = `
            <div class="avatar-msg">${avatarHtml}</div>
            <div class="bubble">${bubbleContent}</div>
        `;
        
        const aiAvatar = messageDiv.querySelector('.avatar-msg');
        if (type === 'ai' && aiAvatar) {
            aiAvatar.style.cursor = 'pointer';
            aiAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                openSettingsModal();   // 复用已有的打开对话设置函数
            });
        }

        // 添加点击气泡显示操作栏
        const bubble = messageDiv.querySelector('.bubble');
        if (bubble) {
            bubble.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                showMessageActions(messageDiv, type, text, displayTime, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment);
            });
        }

        chatMessages.appendChild(messageDiv);
        conditionalScrollToBottom();
        
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
        messagesToRender.forEach((msg, idx) => {
            if (msg.type === 'divider') {
                const divider = document.createElement('div');
                divider.className = 'topic-divider';
                divider.innerHTML = `<i class="fas fa-asterisk"></i> ${escapeHtml(msg.text)} <i class="fas fa-asterisk"></i>`;
                chatMessages.appendChild(divider);
            } else {
                const fileAttachment = msg.file || null;
                appendMessageToDOM(msg.type, msg.text, msg.time, false, null, currentAvatarUrl, fileAttachment, msg.modelName || null);
            }
        });
        
        // 如果处于话题视图且没有消息（理论上不会），显示提示
        if (topicIndex !== null && messagesToRender.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'topic-empty';
            emptyDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#8e8eb3;">该话题暂无消息</div>';
            chatMessages.appendChild(emptyDiv);
        }
        
        conditionalScrollToBottom();
    }
    // 调用本地 Ollama 模型（流式输出）
    let isStreaming = false; // 防止并发流式请求

    async function simulateAIResponse(userMsg) {
        if (currentTTSController) {
            currentTTSController.abort();
            currentTTSController = null;
        }
        if (isStreaming) {
            appendMessageToDOM('ai', '请等待上一个回复完成后再发送新消息。', getCurrentTime(), true);
            return;
        }

        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) {
            appendMessageToDOM('ai', '系统错误：无法找到当前对话。', getCurrentTime(), true);
            return;
        }
        updateStatusIndicator('thinking', '模型思考中 ...');
        const settings = currentChat.settings || defaultSettings;
        const roleName = settings.roleName || 'Nova';
        const rolePersona = settings.persona || '';

        // 获取全局模型配置
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        let modelHost = globalSettings.modelHost || 'http://localhost:11434';
        let apiKey = globalSettings.apiKey || '';
        let modelName = globalSettings.modelName || 'gemma2';

        // 判断是否是 Ollama 服务（简单判断：host 包含 :11434 或者路径包含 /api/chat）
        const isOllama = modelHost.includes(':11434') || modelHost.includes('/api/chat');

        // 显示正在输入指示器
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message ai';
        typingDiv.innerHTML = `<div class="avatar-msg"><i class="fas fa-robot"></i></div><div class="bubble typing-bubble"><div class="typing-indicator"><i class="fas fa-ellipsis-h"></i> ${roleName} 正在思考...</div></div>`;
        chatMessages.appendChild(typingDiv);
        scrollToBottom();

        try {
            // 获取对话历史（支持话题视图）
            let historyMessages = [];
            if (currentTopicIndex !== null) {
                const topics = getTopicsFromMessages(currentChat.messages);
                if (topics[currentTopicIndex]) historyMessages = topics[currentTopicIndex].messages;
            } else {
                historyMessages = currentChat.messages;
            }
            const filteredMessages = historyMessages.filter(msg => msg.type !== 'divider');
            let messagesToUse = filteredMessages;
            const contextLimit = currentChat.settings?.contextLimit ?? 10;
            if (contextLimit !== -1 && messagesToUse.length > contextLimit) {
                messagesToUse = messagesToUse.slice(-contextLimit);
            }

            // 构建 API 消息列表
            const messages = [];
            const userName = globalSettings.username || '用户';
            const userBio = globalSettings.bio || '';

            let systemPrompt = `你的角色名称是：${roleName}。${rolePersona ? rolePersona : ''}\n\n`;
            if (userBio) {
                systemPrompt += `关于当前用户的名称是：${userName}，简介：${userBio}`;
            } else {
                systemPrompt += `当前用户名称叫：${userName}`;
            }
            systemPrompt += '\n\n重要：请严格根据上述角色设定进行角色扮演，不要打破角色，不要以助手或AI的身份回答。必须始终以角色的身份和语气回复。\n\n回复格式规则：当你的回复中包含人物动作、环境描写、情绪描述等非语言表达的内容时，请使用括号（）将这些内容包裹起来。例如：（轻轻叹气）我相信你能做到。或（窗外的雨声淅沥）今天的任务完成得不错。';
            messages.push({ role: 'system', content: systemPrompt });
            for (const msg of messagesToUse) {
                messages.push({ role: msg.type === 'user' ? 'user' : 'assistant', content: msg.text });
            }
            messages.push({ role: 'user', content: userMsg });

            let response;
            let fullReply = '';
            let messageDiv;

            if (isOllama) {
                // ---------- Ollama 格式 ----------
                const url = modelHost.replace(/\/$/, '') + '/api/chat';
                const modelName = globalSettings.modelName || '未知模型';
                messageDiv = createMessageBubble('ai', '', getCurrentTime(), currentChat.settings?.avatarUrl, modelName);
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelName,
                        messages: messages,
                        stream: true,
                        options: {
                            temperature: currentChat.settings?.temperature ?? 0.7,
                            top_p: currentChat.settings?.topP ?? 0.9,
                            num_predict: 500
                        }
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                if (typingDiv.parentNode) typingDiv.remove();
                const bubbleP = messageDiv.querySelector('.bubble p');
                const msgTimeSpan = messageDiv.querySelector('.msg-time');
                chatMessages.appendChild(messageDiv);
                scrollToBottom();
                isStreaming = true;

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                while (true) {
                    if (!isStreaming) break;// 用户已切换对话，停止处理后续数据
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const data = JSON.parse(trimmed);
                            const chunk = data.message?.content || '';
                            fullReply += chunk;
                            bubbleP.innerHTML = escapeHtml(fullReply).replace(/\n/g, '<br>');
                            conditionalScrollToBottom();
                        } catch (e) { console.warn('解析错误', e, trimmed); }
                    }
                }
            } else {
                // ---------- OpenAI 兼容格式 (v1/chat/completions) ----------
                const url = modelHost.replace(/\/$/, '') + '/v1/chat/completions';
                const modelName = globalSettings.modelName || '未知模型';
                messageDiv = createMessageBubble('ai', '', getCurrentTime(), currentChat.settings?.avatarUrl, modelName);
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: messages,
                        stream: true,
                        temperature: currentChat.settings?.temperature ?? 0.7,
                        top_p: currentChat.settings?.topP ?? 0.9,
                        max_tokens: 500
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                if (typingDiv.parentNode) typingDiv.remove();
                const bubbleP = messageDiv.querySelector('.bubble p');
                const msgTimeSpan = messageDiv.querySelector('.msg-time');
                chatMessages.appendChild(messageDiv);
                scrollToBottom();
                isStreaming = true;

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                while (true) {
                    if (!isStreaming) break;// 用户已切换对话，停止处理后续数据
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;
                        const jsonStr = trimmed.slice(6);
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const data = JSON.parse(jsonStr);
                            const chunk = data.choices?.[0]?.delta?.content || '';
                            fullReply += chunk;
                            bubbleP.innerHTML = escapeHtml(fullReply).replace(/\n/g, '<br>');
                            conditionalScrollToBottom();
                        } catch (e) { console.warn('解析错误', e, trimmed); }
                    }
                }
            }
            // 最终更新消息气泡内容（解析思考标签）
            const bubble = messageDiv.querySelector('.bubble');
            const newHtml = renderMessageWithThink(fullReply);
            // 保留原有的模型名称（如果存在）
            const oldMsgTime = bubble.querySelector('.msg-time');
            let modelNameSpan = '';
            if (oldMsgTime) {
                const modelSpan = oldMsgTime.querySelector('span');
                if (modelSpan) {
                    modelNameSpan = modelSpan.outerHTML;
                }
            }
            const newTimeHtml = `<div class="msg-time">${modelNameSpan}${getCurrentTime()}</div>`;
            bubble.innerHTML = newHtml + newTimeHtml;
            // 重新绑定气泡点击事件（因为 innerHTML 会清除原有监听）
            const newBubble = messageDiv.querySelector('.bubble');
            if (newBubble) {
                newBubble.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    showMessageActions(messageDiv, 'ai', fullReply, getCurrentTime(), false, null, currentChat.settings?.avatarUrl, null);
                });
            }
            scrollToBottom();
            updateStatusIndicator('online');
            // 保存消息到存储
            const targetChat = chats.find(c => c.id == currentChatId);
            if (targetChat) {
                const modelName = globalSettings.modelName || '未知模型';
                targetChat.messages.push({ type: 'ai', text: fullReply, time: getCurrentTime(), modelName: modelName });
                targetChat.date = new Date();
                renderHistoryList();
                await saveChatsToDB(chats);
            }
            isStreaming = false;

            if (currentChat.settings?.ttsEnabled) {
                const { replyContent } = parseThinkContent(fullReply);
                if (replyContent) {
                    const parts = parseParenthesesContent(replyContent);
                    const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
                    if (speechText.trim()) {
                        let ttsVoice = currentChat.settings.ttsVoice;
                        if (!ttsVoice || ttsVoice === '') ttsVoice = 'default';
                        speakWithQwenTTS(speechText, ttsVoice);
                    }
                }
            }
        } catch (error) {
            console.error('模型调用失败:', error);
            updateStatusIndicator('offline', '离线 · 模型调用失败');
            if (typingDiv && typingDiv.parentNode) typingDiv.remove();
            appendMessageToDOM('ai', `❌ 模型调用失败：${error.message}\n请检查模型地址和 API Key 是否正确。`, getCurrentTime(), true);
            isStreaming = false;
        }
    }

    // 辅助函数：创建消息气泡（复用）
    function createMessageBubble(type, text, time, avatarUrl, modelName = null) {
        const div = document.createElement('div');
        div.className = `message ${type}`;
        const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;">` : '<i class="fas fa-robot"></i>';
        let timeHtml = `<div class="msg-time">`;
        if (type === 'ai' && modelName) {
            timeHtml += `<span style="margin-right: 8px; font-size: 0.65rem; opacity: 0.7;">🤖 ${escapeHtml(modelName)}</span>`;
        }
        timeHtml += `${escapeHtml(time)}</div>`;

        div.innerHTML = `
            <div class="avatar-msg">${avatarHtml}</div>
            <div class="bubble">
                <p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>
                ${timeHtml}
            </div>
        `;
        return div;
    }

    async function sendUserMessage() {
        let text = messageInput.value.trim();
        let fileAttachment = null;
        
        if (currentFileContent) {
            fileAttachment = {
                name: currentFile.name,
                content: currentFileContent
            };
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
        let modelUserMsg = text;
        if (targetChat) {
            targetChat.messages.push({
                type: 'user',
                text: text,
                time: userTime,
                file: fileAttachment,  // 附加文件信息
                modelInputText: modelUserMsg,
            });
            targetChat.date = new Date();
            renderHistoryList();
            await saveChatsToDB(chats);
        }
        forceScrollToBottom();
        // 渲染消息
        await appendMessageToDOM('user', text, userTime, false, null, null, fileAttachment);
        messageInput.value = '';
        if (messageInput) messageInput.style.height = 'auto';
        
        // 构建发送给模型的内容（包含文件内容）
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
        if (currentTTSController) {
            currentTTSController.abort();
            currentTTSController = null;
        }
        
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            currentAudio = null;
        }
        isTTSSpeaking = false;
        updateStatusIndicator('online');
        // 检查是否有正在进行的流式回复
        if (isStreaming) {
            if (confirm('当前对话正在生成回复，切换对话会中断当前回复。是否继续？')) {
                // 可选：取消当前请求（但 fetch 无法主动中断，只能忽略后续更新）
                isStreaming = false;
                if (currentAudio) {
                    currentAudio.pause();
                    currentAudio.currentTime = 0;
                    currentAudio = null;
                }
            } else {
                return;
            }
        }
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
            // 定义加载音色列表的函数（仅当开关打开时）
            const loadVoiceListIfNeeded = async () => {
                if (ttsSwitch.checked && ttsVoiceSelect) {
                    await loadVoiceList(ttsVoiceSelect);
                }
            };
            // 根据开关状态显示/隐藏音色选择
            if (ttsVoiceGroup) {
                ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
            }
            loadVoiceListIfNeeded();
            // 绑定开关变化事件
            ttsSwitch.onchange = async () => {
                if (ttsVoiceGroup) {
                    ttsVoiceGroup.style.display = ttsSwitch.checked ? 'block' : 'none';
                }
                if (ttsSwitch.checked) {
                await loadVoiceListIfNeeded();
            }
            };
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
        if (isStreaming) {
            const confirmMsg = '当前对话正在生成回复，保存设置会中断该回复。是否继续？';
            if (!confirm(confirmMsg)) {
                closeModal();
                return;
            }
            // 中断流式生成
            isStreaming = false;
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.currentTime = 0;
                currentAudio = null;
            }
            // 等待一小段时间让流式输出循环退出
            await new Promise(resolve => setTimeout(resolve, 100));
        }
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
        // 应用已保存的字体大小
        const saved = JSON.parse(localStorage.getItem('global_settings')) || {};
        applyFontSize(saved.fontSize || 'medium');
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
        // 文件上传、语音输入按钮
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
        const addModelBtn = document.getElementById('add-model-btn');
        if (addModelBtn) {
            addModelBtn.addEventListener('click', () => {
                const newModel = document.getElementById('new-model-name').value;
                if (addModel(newModel)) {
                    document.getElementById('new-model-name').value = '';
                }
            });
        }
        // 获取拖拽目标区域（聊天消息区域）
        const dropZone = document.querySelector('.chat-messages');

        if (dropZone) {
            // 阻止默认拖拽行为
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
            });

            // 拖拽进入高亮
            dropZone.addEventListener('dragenter', (e) => {
                dropZone.classList.add('drag-over');
            });

            dropZone.addEventListener('dragleave', (e) => {
                dropZone.classList.remove('drag-over');
            });

            // 放下文件
            dropZone.addEventListener('drop', async (e) => {
                dropZone.classList.remove('drag-over');
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    const file = files[0];
                    // 复用原有文件上传逻辑（与 upload-file-btn 相同）
                    if (file.size > 5 * 1024 * 1024) {
                        alert('文件过大，请选择小于 5MB 的文件');
                        return;
                    }
                    // 检查文件类型
                    const allowedExtensions = ['.txt', '.md', '.csv', '.json', '.log', '.js', '.py', '.html', '.css', '.xml'];
                    const ext = '.' + file.name.split('.').pop().toLowerCase();
                    if (!allowedExtensions.includes(ext)) {
                        alert('不支持的文件类型，请上传文本类文件');
                        return;
                    }
                    // 读取文件
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        currentFileContent = ev.target.result;
                        currentFile = file;
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
                }
            });
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(() => {
                    performSearch(e.target.value);
                }, 300);
            });
        }

        const importBtn = document.querySelector('.import-chat-btn');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = 'application/json';
                fileInput.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const importedData = JSON.parse(ev.target.result);
                            await importChatFromJson(importedData);
                        } catch (err) {
                            alert('JSON 解析失败：' + err.message);
                        }
                    };
                    reader.readAsText(file, 'UTF-8');
                };
                fileInput.click();
            });
        }
        if (chatMessages) {
            chatMessages.addEventListener('scroll', updateAutoScrollFlag);
        }
        loadModelList();
        updateModelSelector();
        bindQuickModelSwitch();
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
            const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
            speakWithQwenTTS(greeting, voice);
        }
    }

    // 为每个历史项绑定菜单弹出逻辑
    function attachMenuEvents(historyItem, chat) {
        const trigger = historyItem.querySelector('.history-menu-trigger');
        if (!trigger) return;
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
            // 获取触发按钮的位置
            const rect = trigger.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
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
            // 设置菜单位置（默认在触发按钮下方右对齐）
            menu.style.position = 'absolute';
            menu.style.top = `${rect.bottom + scrollTop + 4}px`;
            menu.style.left = `${rect.right + scrollLeft - 140}px`; // 菜单宽度约140px
            menu.style.zIndex = '10001';
            document.body.appendChild(menu);
            currentMenu = menu;
            // 边界检测：防止菜单超出视口右侧
            const menuRect = menu.getBoundingClientRect();
            if (menuRect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - menuRect.width - 10 + scrollLeft}px`;
            }
            // 边界检测：防止菜单超出视口底部
            if (menuRect.bottom > window.innerHeight) {
                menu.style.top = `${rect.top + scrollTop - menuRect.height - 4}px`;
            }
            
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

    function getTopicsFromMessages(messages, topicSummaries = {}) {
        const topics = [];
        let currentTopicMessages = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.type === 'divider') {
                if (currentTopicMessages.length > 0) {
                    const idx = topics.length;
                    topics.push({
                        startIndex: idx === 0 ? 0 : (topics[idx-1].endIndex + 1),
                        endIndex: i - 1,
                        messages: currentTopicMessages,
                        dividerText: msg.text,
                        dividerTime: msg.time,
                        summary: topicSummaries[idx] || null
                    });
                    currentTopicMessages = [];
                }
            } else {
                currentTopicMessages.push(msg);
            }
        }
        if (currentTopicMessages.length > 0) {
            const idx = topics.length;
            topics.push({
                startIndex: idx === 0 ? 0 : (topics[idx-1].endIndex + 1),
                endIndex: messages.length - 1,
                messages: currentTopicMessages,
                dividerText: null,
                dividerTime: null,
                summary: topicSummaries[idx] || null
            });
        }
        return topics;
    }

    async function generateTopicSummary(topicIndex, topicMessages) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return null;
        
        // 提取话题中所有用户和AI的消息文本
        const conversationText = topicMessages.map(msg => `${msg.type === 'user' ? '用户' : '助手'}：${msg.text}`).join('\n');
        if (!conversationText.trim()) return '（无内容）';
        
        const prompt = `请为以下对话生成一句简短的摘要（10-30字），简明扼要地概括主要内容：\n${conversationText}`;
        
        // 获取全局模型配置
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        let modelHost = globalSettings.modelHost || 'http://localhost:11434';
        let apiKey = globalSettings.apiKey || '';
        let modelName = globalSettings.modelName || 'gemma2';
        const isOllama = modelHost.includes(':11434') || modelHost.includes('/api/chat');
        
        try {
            let summary = '';
            if (isOllama) {
                const url = modelHost.replace(/\/$/, '') + '/api/generate';
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelName,
                        prompt: prompt,
                        stream: false,
                        options: { temperature: 0.3, num_predict: 100 }
                    })
                });
                const data = await response.json();
                summary = data.response?.trim() || '生成失败';
            } else {
                const url = modelHost.replace(/\/$/, '') + '/v1/chat/completions';
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.3,
                        max_tokens: 100
                    })
                });
                const data = await response.json();
                summary = data.choices?.[0]?.message?.content?.trim() || '生成失败';
            }
            return summary;
        } catch (err) {
            console.error('生成简介失败', err);
            return '生成失败，请检查模型配置';
        }
    }

    function openTopicsModal() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        const topics = getTopicsFromMessages(currentChat.messages, currentChat.settings?.topicSummaries);
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
                        <div class="topic-preview editable-preview" data-topic-index="${idx}" data-original="${escapeHtml(topic.summary || preview)}">${escapeHtml(topic.summary || preview)}</div>
                        <div class="topic-actions">
                            <button class="topic-gen-intro-btn" data-topic-index="${idx}"><i class="fas fa-magic"></i> 生成简介</button>
                            <button class="topic-export-btn" data-topic-index="${idx}"><i class="fas fa-download"></i> 导出</button>
                            <button class="topic-delete-btn" data-topic-index="${idx}"><i class="fas fa-trash-alt"></i> 删除</button>
                        </div>
                    </div>
                `;
            }).join('');
            // 绑定可编辑预览区双击事件
            container.querySelectorAll('.editable-preview').forEach(elem => {
                elem.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const topicIdx = parseInt(elem.getAttribute('data-topic-index'));
                    const oldText = elem.innerText;
                    // 创建输入框
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = oldText;
                    input.style.width = '100%';
                    input.style.background = 'rgba(30,34,55,0.9)';
                    input.style.border = '1px solid #5f7eff';
                    input.style.borderRadius = '8px';
                    input.style.padding = '4px 8px';
                    input.style.color = '#f0f3ff';
                    elem.innerHTML = '';
                    elem.appendChild(input);
                    input.focus();
                    
                    const saveEdit = () => {
                        const newText = input.value.trim();
                        if (newText && newText !== oldText) {
                            // 更新存储
                            if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                            currentChat.settings.topicSummaries[topicIdx] = newText;
                            saveToStorage();
                            // 更新显示
                            elem.innerText = newText;
                            elem.setAttribute('data-original', newText);
                        } else if (!newText) {
                            elem.innerText = oldText;
                        } else {
                            elem.innerText = oldText;
                        }
                    };
                    
                    input.addEventListener('blur', saveEdit);
                    input.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            input.blur();
                        }
                    });
                });
            });
            // 阻止单击简介时触发父级（.topic-item）的切换话题事件
            container.querySelectorAll('.topic-preview').forEach(preview => {
                preview.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
            });
            // 绑定生成简介按钮事件
            container.querySelectorAll('.topic-gen-intro-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-topic-index'));
                    const topic = topics[idx];
                    if (!topic) return;
                    
                    // 通过按钮找到所属的话题项，再找到预览区
                    const topicItem = btn.closest('.topic-item');
                    const summaryElem = topicItem ? topicItem.querySelector('.topic-preview') : null;
                    if (summaryElem) {
                        summaryElem.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';
                    }
                    
                    const summary = await generateTopicSummary(idx, topic.messages);
                    if (summary && summaryElem) {
                        // 保存到存储
                        if (!currentChat.settings.topicSummaries) currentChat.settings.topicSummaries = {};
                        currentChat.settings.topicSummaries[idx] = summary;
                        await saveToStorage();
                        // 更新显示
                        summaryElem.innerHTML = escapeHtml(summary);
                        summaryElem.setAttribute('data-original', summary);  // 同步自定义属性
                    } else if (summaryElem) {
                        summaryElem.innerHTML = '生成失败';
                    }
                });
            });
            // 绑定切换按钮的事件
            container.querySelectorAll('.topic-item').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // 如果点击的是按钮区域或其子元素，不触发切换
                    if (e.target.closest('.topic-actions')) return;
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
            if (!currentChat.messages.some(msg => msg.type !== 'divider')) {
                // 如果没有任何实际消息，自动开启一个新话题
                startNewTopic();
            }
            closeTopicsModal(); // 关闭弹窗
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

    let currentAudio = null; // 当前播放的音频对象

    async function speakWithQwenTTS(text, voice, playButtonElement = null) {
        if (!text || text.trim() === '') return;
        updateStatusIndicator('speaking', '语音合成中 ...');
        try {
            // 停止当前正在播放的音频
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.currentTime = 0;
                currentAudio = null;
            }
            // 取消正在进行的 TTS 请求
            if (currentTTSController) {
                currentTTSController.abort();
                currentTTSController = null;
            }
            // 如果之前有播放按钮被禁用，恢复它（防止按钮永远禁用）
            if (window._lastDisabledPlayBtn && window._lastDisabledPlayBtn !== playButtonElement) {
                window._lastDisabledPlayBtn.disabled = false;
                window._lastDisabledPlayBtn.style.opacity = '1';
                window._lastDisabledPlayBtn.style.cursor = 'pointer';
                window._lastDisabledPlayBtn = null;
            }
            // 启用新按钮的禁用逻辑
            if (playButtonElement) {
                playButtonElement.disabled = true;
                playButtonElement.style.opacity = '0.5';
                playButtonElement.style.cursor = 'not-allowed';
                window._lastDisabledPlayBtn = playButtonElement;
            }
            const controller = new AbortController();
            currentTTSController = controller;
            const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
            const ttsApiUrl = globalSettings.ttsApiUrl || 'http://localhost:5000';
            // 调用 TTS API
            const response = await fetch(`${ttsApiUrl}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text, voice: voice })
            });

            if (!response.ok) {
                const err = await response.json();
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
                currentAudio = null;
                if (currentTTSController === controller) currentTTSController = null;
            };
            audio.onerror = (err) => {
                URL.revokeObjectURL(audioUrl);
                console.error('音频播放失败', err);
                fallbackSpeak(text);
                currentAudio = null;
                if (currentTTSController === controller) currentTTSController = null;
            };
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('TTS 请求被取消');
            } else {
                console.error('TTS 调用失败:', err);
                fallbackSpeak(text);
            }
            if (currentTTSController === controller) currentTTSController = null;
        } finally{
            if (playButtonElement) {
                    playButtonElement.disabled = false;
                    playButtonElement.style.opacity = '1';
                    playButtonElement.style.cursor = 'pointer';
                    if (window._lastDisabledPlayBtn === playButtonElement) window._lastDisabledPlayBtn = null;
                }
                updateStatusIndicator('online');
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
        const ttsApiUrlInput = document.getElementById('tts-api-url');
        const fetchVoicesBtn = document.getElementById('fetch-voices-btn');
        // 音色克隆按钮事件
        let isCloning = false;
        const cloneBtn = document.getElementById('start-clone-btn');
        const cloneStatus = document.getElementById('clone-status');

        if (fetchVoicesBtn) {
            fetchVoicesBtn.addEventListener('click', async () => {
                const apiUrl = document.getElementById('tts-api-url').value;
                if (!apiUrl) {
                    alert('请先填写 TTS API 地址');
                    return;
                }
                try {
                    const response = await fetch(`${apiUrl}/voices`);
                    if (!response.ok) throw new Error('获取失败');
                    const data = await response.json();
                    const voiceList = data.voices || [];
                    const displaySpan = document.getElementById('voice-list-display');
                    if (voiceList.length === 0) {
                        displaySpan.innerText = '无可用音色';
                    } else {
                        displaySpan.innerHTML = voiceList.join(', ');
                    }
                } catch (err) {
                    console.error(err);
                    document.getElementById('voice-list-display').innerText = '获取失败，请检查服务地址';
                }
            });
        }
        if (cloneBtn) {
            const newCloneBtn = cloneBtn.cloneNode(true);
            cloneBtn.parentNode.replaceChild(newCloneBtn, cloneBtn);
            newCloneBtn.addEventListener('click', async () => {
                if (isCloning) {
                    alert('正在克隆中，请稍候...');
                    return;
                }
                const voiceName = document.getElementById('clone-voice-name').value.trim();
                if (!voiceName) {
                    alert('请输入音色名称');
                    return;
                }
                const audioFile = document.getElementById('clone-audio-file').files[0];
                if (!audioFile) {
                    alert('请选择参考音频文件');
                    return;
                }
                const audioText = document.getElementById('clone-audio-text').value.trim();
                if (!audioText) {
                    alert('请填写音频对应的文本内容');
                    return;
                }
                isCloning = true;
                const formData = new FormData();
                formData.append('voice_name', voiceName);
                formData.append('audio', audioFile);
                formData.append('ref_text', audioText);
                
                const ttsApiUrl = globalSettings.ttsApiUrl || 'http://localhost:5000';
                
                cloneStatus.innerText = '正在克隆音色，请稍候...';
                cloneBtn.disabled = true;
                
                try {
                    const response = await fetch(`${ttsApiUrl}/clone_voice`, {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.json();
                    if (response.ok) {
                        cloneStatus.innerText = '✅ 音色克隆成功！已保存到音色库。';
                        // 刷新音色列表显示
                        if (typeof fetchVoiceList === 'function') await fetchVoiceList();
                        // 清空表单
                        document.getElementById('clone-voice-name').value = '';
                        document.getElementById('clone-audio-file').value = '';
                        document.getElementById('clone-audio-text').value = '';
                    } else {
                        cloneStatus.innerText = `❌ 克隆失败：${result.error}`;
                    }
                } catch (err) {
                    cloneStatus.innerText = `❌ 网络错误：${err.message}`;
                } finally {
                    isCloning = false;
                    newCloneBtn.disabled = false;
                }
            });
        }
        
        if (ttsApiUrlInput) ttsApiUrlInput.value = globalSettings.ttsApiUrl || 'http://localhost:5000';
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
        const fontSize = document.getElementById('global-font-size').value;
        
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
        const quickSelect = document.getElementById('quick-model-select');
        const currentModel = quickSelect ? quickSelect.value : (modelList[0] || 'gemma2');
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
            fontSize: document.getElementById('global-font-size').value,
            modelName: currentModel,
            ttsApiUrl: document.getElementById('tts-api-url').value,
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
        applyFontSize(fontSize);
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

    function applyFontSize(size) {
        let fontSizeValue = '14px';
        if (size === 'small') fontSizeValue = '12px';
        else if (size === 'large') fontSizeValue = '16px';
        else fontSizeValue = '14px';
        
        // 移除旧的 style 标签，重新添加确保优先级
        const styleId = 'dynamic-font-size-style';
        const oldStyle = document.getElementById(styleId);
        if (oldStyle) oldStyle.remove();
        
        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = `
            .chat-messages .bubble p {
                font-size: ${fontSizeValue} !important;
                line-height: 1.5 !important;
            }
            .chat-messages .bubble {
                font-size: ${fontSizeValue} !important;
            }
            .message .bubble p {
                font-size: ${fontSizeValue} !important;
            }
        `;
        document.head.appendChild(styleEl);
        
        // 强制重绘当前聊天区域（可选，确保所有消息重新计算样式）
        if (chatMessages) {
            chatMessages.style.display = 'none';
            chatMessages.offsetHeight; // 强制重排
            chatMessages.style.display = '';
        }
    }

    // 解析原始文本，分离思考内容和回复内容
    function parseThinkContent(rawText) {
        const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/);
        const thinkContent = thinkMatch ? thinkMatch[1].trim() : '';
        const replyContent = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return { thinkContent, replyContent };
    }

    // 将原始文本渲染为带折叠区域的 HTML
    function renderMessageWithThink(rawText) {
        const { thinkContent, replyContent } = parseThinkContent(rawText);
        let html = '';
        if (thinkContent) {
            html += `<details class="think-details"><summary>🤔 思考过程</summary><div class="think-content">${escapeHtml(thinkContent).replace(/\n/g, '<br>')}</div></details>`;
        }
        // 处理括号斜体
        const parts = parseParenthesesContent(replyContent);
        let contentHtml = '';
        for (const part of parts) {
            if (part.type === 'action') {
                contentHtml += `<span class="action-text" style="font-style: italic; opacity: 0.8;">${escapeHtml(part.raw)}</span>`;
            } else {
                contentHtml += escapeHtml(part.text).replace(/\n/g, '<br>');
            }
        }
        html += `<p>${contentHtml}</p>`;
        return html;
    }

    let currentActionMsgElement = null;
    let currentActionMenu = null;

    function showMessageActions(msgElement, type, text, time, saveToStorageFlag, chatIdForSave, customAvatarUrl, fileAttachment) {
        // 移除已存在的操作栏
        if (currentActionMenu) {
            currentActionMenu.remove();
            currentActionMenu = null;
            currentActionMsgElement = null;
        }
        
        const bubble = msgElement.querySelector('.bubble');
        if (!bubble) return;
        
        // 获取气泡位置
        const rect = bubble.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        
        // 创建操作栏
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        
        // 判断是否为最新的 AI 消息
        const currentChat = chats.find(c => c.id == currentChatId);
        const isLatestAi = (type === 'ai' && currentChat && currentChat.messages.length > 0 && 
                            currentChat.messages[currentChat.messages.length - 1].text === text);
        
        let buttonsHtml = `<button class="delete-btn"><i class="fas fa-trash-alt"></i> 删除消息</button>`;
        if (type === 'ai') {
            buttonsHtml += `<button class="play-msg-btn"><i class="fas fa-play"></i> 播放</button>`;
        }
        if (isLatestAi) {
            buttonsHtml += `
                <button class="regenerate-btn"><i class="fas fa-undo-alt"></i> 重新生成</button>
                <button class="continue-btn"><i class="fas fa-forward"></i> 继续说</button>
            `;
        }

        const isLatestUser = (type === 'user' && currentChat && currentChat.messages.length > 0 && 
                            currentChat.messages[currentChat.messages.length - 1].type === 'user' &&
                            currentChat.messages[currentChat.messages.length - 1].text === text &&
                            currentChat.messages[currentChat.messages.length - 1].time === time);
        if (isLatestUser) {
            buttonsHtml += `<button class="generate-reply-btn"><i class="fas fa-comment-dots"></i> 生成回复</button>`;
        }
        actionsDiv.innerHTML = buttonsHtml;
        document.body.appendChild(actionsDiv);
        currentActionMenu = actionsDiv;
        currentActionMsgElement = msgElement;
        
        // 定位操作栏
        const top = rect.bottom + scrollTop + 8;
        const left = rect.left + scrollLeft;
        actionsDiv.style.top = `${top}px`;
        actionsDiv.style.left = `${left}px`;
        const actionsRect = actionsDiv.getBoundingClientRect();
        if (actionsRect.right > window.innerWidth) {
            actionsDiv.style.left = `${window.innerWidth - actionsRect.width - 10 + scrollLeft}px`;
        }
        
        // 删除按钮
        const deleteBtn = actionsDiv.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('确定要删除这条消息吗？')) {
                    await deleteMessageFromChat(type, text, time);
                    closeActionMenu();
                }
            });
        }

        // 播放按钮
        const playBtn = actionsDiv.querySelector('.play-msg-btn');
        if (playBtn) {
            playBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeActionMenu();
                // 检查是否正在语音合成/播放
                if (isTTSSpeaking) {
                    alert('正在合成和播放语音，请稍后再试');
                    return;
                }
                const currentChat = chats.find(c => c.id == currentChatId);
                const ttsEnabled = currentChat?.settings?.ttsEnabled;
                const ttsVoice = currentChat?.settings?.ttsVoice || 'default';
                if (ttsEnabled) {
                    const { replyContent } = parseThinkContent(text);
                    const contentToSpeak = replyContent || text;
                    const parts = parseParenthesesContent(contentToSpeak);
                    const speechText = parts.filter(p => p.type === 'speech').map(p => p.text).join('');
                    if (speechText.trim()) {
                        speakWithQwenTTS(speechText, ttsVoice, playBtn);
                    } else {
                        alert('当前消息没有可朗读的语言内容');
                    }
                } else {
                    alert('当前对话未开启语音合成，请在对话设置中开启 TTS 开关');
                }
            });
        }
        // 生成按钮
        const generateReplyBtn = actionsDiv.querySelector('.generate-reply-btn');
        if (generateReplyBtn) {
            generateReplyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeActionMenu();
                // 调用 AI 回复该用户消息
                await simulateAIResponse(text);
            });
        }
        // 重新生成按钮
        const regenBtn = actionsDiv.querySelector('.regenerate-btn');
        if (regenBtn) {
            regenBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeActionMenu();
                await regenerateAIMessage(text, time);
            });
        }
        
        // 继续说按钮
        const continueBtn = actionsDiv.querySelector('.continue-btn');
        if (continueBtn) {
            continueBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeActionMenu();
                await continueAIMessage();
            });
        }
        
        // 点击外部关闭
        const closeHandler = (e) => {
            if (!actionsDiv.contains(e.target) && e.target !== msgElement && !msgElement.contains(e.target)) {
                closeActionMenu();
                document.removeEventListener('click', closeHandler);
                document.removeEventListener('scroll', scrollCloseHandler);
            }
        };
        const scrollCloseHandler = () => closeActionMenu();
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            document.addEventListener('scroll', scrollCloseHandler, { once: true });
        }, 0);
        
        function closeActionMenu() {
            if (actionsDiv.parentNode) actionsDiv.remove();
            currentActionMenu = null;
            currentActionMsgElement = null;
        }
    }

    async function deleteMessageFromChat(type, text, time) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        
        // 查找匹配的消息（根据 type, text, time）
        const index = currentChat.messages.findIndex(msg => msg.type === type && msg.text === text && msg.time === time);
        if (index !== -1) {
            currentChat.messages.splice(index, 1);
            // 重新渲染当前对话
            renderMessages(currentChatId, currentTopicIndex);
            await saveChatsToDB(chats);
            // 更新历史列表时间（可选）
            if (currentChat.messages.length > 0) {
                currentChat.date = new Date();
                renderHistoryList();
            }
        } else {
            alert('无法找到该消息，删除失败');
        }
    }

    async function regenerateAIMessage(oldText, oldTime) {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        
        // 找到最后一条 AI 消息（应该是触发重新生成的那条）
        const lastIndex = currentChat.messages.length - 1;
        if (lastIndex < 0 || currentChat.messages[lastIndex].type !== 'ai') return;
        
        // 获取触发重新生成的用户消息（上一条用户消息）
        let userMsg = '';
        for (let i = lastIndex - 1; i >= 0; i--) {
            if (currentChat.messages[i].type === 'user') {
                userMsg = currentChat.messages[i].modelInputText || currentChat.messages[i].text;
                break;
            }
        }
        if (!userMsg) {
            appendMessageToDOM('ai', '无法找到对应的用户消息，无法重新生成。', getCurrentTime(), true);
            return;
        }
        
        // 删除原 AI 消息
        currentChat.messages.splice(lastIndex, 1);
        await saveChatsToDB(chats);
        // 重新渲染界面（移除原消息）
        renderMessages(currentChatId, currentTopicIndex);
        
        await simulateAIResponse(userMsg);
    }

    async function continueAIMessage() {
        const currentChat = chats.find(c => c.id == currentChatId);
        if (!currentChat) return;
        
        // 获取最后一条 AI 消息的内容（作为继续对话的上下文）
        const lastMsg = currentChat.messages[currentChat.messages.length - 1];
        if (!lastMsg || lastMsg.type !== 'ai') return;
        
        // 构造一个“继续说”的提示，例如：“请继续”
        const continuePrompt = '请继续刚才的话题，接着上面的内容继续说。';
        // 将该提示作为用户消息临时添加并发送
        // 为了用户体验，我们将在界面上显示一条用户消息“继续说”。
        const userTime = getCurrentTime();
        currentChat.messages.push({
            type: 'user',
            text: continuePrompt,
            time: userTime
        });
        await saveChatsToDB(chats);
        await appendMessageToDOM('user', continuePrompt, userTime, false);
        
        // 调用模型回复
        await simulateAIResponse(continuePrompt);
    }

    // 封装获取音色列表的函数（供克隆后刷新和按钮调用）
    async function fetchVoiceList() {
        const apiUrl = document.getElementById('tts-api-url').value;
        if (!apiUrl) return;
        try {
            const response = await fetch(`${apiUrl}/voices`);
            if (!response.ok) throw new Error();
            const data = await response.json();
            const displaySpan = document.getElementById('voice-list-display');
            if (data.voices && data.voices.length) {
                displaySpan.innerHTML = data.voices.join(', ');
            } else {
                displaySpan.innerText = '无可用音色';
            }
        } catch (err) {
            console.warn('获取音色列表失败', err);
        }
    }

    async function loadVoiceList(selectElement) {
        const globalSettings = JSON.parse(localStorage.getItem('global_settings')) || {};
        const ttsApiUrl = globalSettings.ttsApiUrl || 'http://localhost:5000';
        try {
            const response = await fetch(`${ttsApiUrl}/voices`);
            if (response.ok) {
                const data = await response.json();
                const voices = data.voices || [];
                selectElement.innerHTML = '';
                if (voices.length === 0) {
                    const option = document.createElement('option');
                    option.value = '';
                    option.textContent = '无可用音色，请先克隆';
                    selectElement.appendChild(option);
                } else {
                    voices.forEach(voice => {
                        const option = document.createElement('option');
                        option.value = voice;
                        option.textContent = voice;
                        selectElement.appendChild(option);
                    });
                }
                // 恢复之前保存的音色值
                const currentChat = chats.find(c => c.id == currentChatId);
                const savedVoice = currentChat?.settings?.ttsVoice;
                if (savedVoice && voices.includes(savedVoice)) {
                    selectElement.value = savedVoice;
                } else if (voices.length > 0) {
                    selectElement.value = voices[0];
                }
            } else {
                selectElement.innerHTML = '<option value="">获取音色列表失败</option>';
            }
        } catch (err) {
            console.error('加载音色列表失败', err);
            selectElement.innerHTML = '<option value="">加载失败，请检查服务地址</option>';
        }
    }

    // 解析文本，分离括号内（非语言）和括号外（语言）部分
    function parseParenthesesContent(text) {
        const parts = [];
        // 正则匹配括号及其内容（非贪婪）
        const regex = /（([^（）]*)）|\(([^()]*)\)/g;
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const parenContent = match[1] || match[2]; // 中文或英文括号内的内容
            const start = match.index;
            const end = start + match[0].length;
            // 括号前的普通文本
            if (start > lastIndex) {
                parts.push({ type: 'speech', text: text.substring(lastIndex, start) });
            }
            // 括号内的内容（非语言）
            parts.push({ type: 'action', text: parenContent, raw: match[0] });
            lastIndex = end;
        }
        if (lastIndex < text.length) {
            parts.push({ type: 'speech', text: text.substring(lastIndex) });
        }
        return parts;
    }

    let searchDebounceTimer = null;
    const searchInput = document.getElementById('global-search-input');
    const searchDropdown = document.getElementById('search-results-dropdown');

    function performSearch(keyword) {
        if (!keyword.trim()) {
            searchDropdown.style.display = 'none';
            return;
        }
        const results = [];
        const lowerKeyword = keyword.toLowerCase();
        for (const chat of chats) {
            const settings = chat.settings || defaultSettings;
            const roleName = settings.roleName || 'Nova';
            // 匹配会话标题（角色名）
            if (roleName.toLowerCase().includes(lowerKeyword)) {
                results.push({
                    type: 'chat',
                    chatId: chat.id,
                    title: roleName,
                    preview: '会话标题匹配'
                });
            }
            // 匹配消息内容
            for (let i = 0; i < chat.messages.length; i++) {
                const msg = chat.messages[i];
                if (msg.type === 'divider') continue;
                if (msg.text.toLowerCase().includes(lowerKeyword)) {
                    results.push({
                        type: 'message',
                        chatId: chat.id,
                        messageIndex: i,
                        title: roleName,
                        preview: msg.text.length > 60 ? msg.text.substring(0, 60) + '...' : msg.text,
                        time: msg.time
                    });
                }
            }
        }
        renderSearchResults(results.slice(0, 20)); // 最多显示20条
    }

    function renderSearchResults(results) {
        if (results.length === 0) {
            searchDropdown.innerHTML = '<div class="search-dropdown-item" style="color:#8e8eb3;">未找到相关结果</div>';
            searchDropdown.style.display = 'block';
            return;
        }
        searchDropdown.innerHTML = results.map(result => {
            if (result.type === 'chat') {
                return `
                    <div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="chat">
                        <div class="search-dropdown-title">
                            <i class="fas fa-comment"></i> ${escapeHtml(result.title)}
                            <span class="search-dropdown-badge">会话</span>
                        </div>
                        <div class="search-dropdown-preview">${escapeHtml(result.preview)}</div>
                    </div>
                `;
            } else {
                return `
                    <div class="search-dropdown-item" data-chat-id="${result.chatId}" data-type="message" data-message-index="${result.messageIndex}">
                        <div class="search-dropdown-title">
                            <i class="fas fa-comment-dots"></i> ${escapeHtml(result.title)}
                            <span class="search-dropdown-badge">消息</span>
                        </div>
                        <div class="search-dropdown-preview">${escapeHtml(result.preview)}</div>
                        <div style="font-size: 0.65rem; color:#8e8eb3; margin-top: 4px;">${escapeHtml(result.time)}</div>
                    </div>
                `;
            }
        }).join('');
        searchDropdown.style.display = 'block';
        
        // 绑定点击事件
        document.querySelectorAll('.search-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = parseInt(item.getAttribute('data-chat-id'));
                const type = item.getAttribute('data-type');
                const messageIndex = item.getAttribute('data-message-index');
                
                // 切换会话
                if (currentChatId !== chatId) {
                    switchChat(chatId);
                    // 等待渲染完成再滚动
                    setTimeout(() => {
                        if (type === 'message' && messageIndex !== null) {
                            scrollToMessage(parseInt(messageIndex));
                        }
                    }, 100);
                } else {
                    // 同一会话
                    if (type === 'message' && messageIndex !== null) {
                        scrollToMessage(parseInt(messageIndex));
                    }
                }
                searchDropdown.style.display = 'none';
                searchInput.value = ''; // 清空搜索框
            });
        });
    }

    function scrollToMessage(index) {
        const messages = document.querySelectorAll('.chat-messages .message');
        if (messages[index]) {
            messages[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 高亮效果
            messages[index].style.transition = 'background 0.3s';
            messages[index].style.backgroundColor = 'rgba(95, 126, 255, 0.3)';
            setTimeout(() => {
                messages[index].style.backgroundColor = '';
            }, 1500);
        } else {
            // 如果消息未渲染（可能因为话题视图），先重置话题视图再滚动
            if (currentTopicIndex !== null) {
                currentTopicIndex = null;
                renderMessages(currentChatId);
                setTimeout(() => scrollToMessage(index), 100);
            }
        }
    }

    // 关闭下拉框（点击外部）
    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
            searchDropdown.style.display = 'none';
        }
    });

    async function importChatFromJson(data) {
        // 校验结构：必须包含 id, messages, settings, date 等字段（与导出会话一致）
        if (!data || typeof data !== 'object') {
            alert('无效的 JSON 数据');
            return;
        }
        // 检查必要字段（导出会话时包含 id, messages, settings, date, title 等）
        if (!data.messages || !Array.isArray(data.messages) || !data.settings) {
            alert('无效的对话格式：缺少 messages 或 settings 字段');
            return;
        }

        // 生成新的唯一 ID（避免覆盖现有对话）
        const newId = Date.now();
        // 确保 date 是 Date 对象
        let chatDate = data.date ? new Date(data.date) : new Date();
        if (isNaN(chatDate.getTime())) chatDate = new Date();

        const newChat = {
            id: newId,
            title: data.title || `导入对话 ${chats.length + 1}`,
            date: chatDate,
            messages: data.messages.map(msg => ({
                ...msg,
                // 确保每条消息有时间字段
                time: msg.time || getCurrentTime()
            })),
            settings: { ...defaultSettings, ...data.settings },
            pinned: false
        };

        // 可选：检查是否已经存在相同内容的对话（基于消息内容 hash），这里简单直接添加
        chats.unshift(newChat);
        currentChatId = newId;
        currentTopicIndex = null;
        renderHistoryList();
        renderMessages(currentChatId);
        applyCurrentChatSettings();
        await saveToStorage();
    }

    // 状态指示器控制
    function updateStatusIndicator(state, customText = null) {
        const statusTextElem = document.querySelector('.user-details p');
        if (!statusTextElem) return;
        
        const dotIcon = statusTextElem.querySelector('i');
        let dotHtml = '';
        let text = '';
        
        switch (state) {
            case 'online':
                dotHtml = '<i class="fas fa-circle" style="color: #2effb0; font-size: 0.6rem; text-shadow: 0 0 3px #2effb0;"></i>';
                text = customText || '在线 · AI 智能体';
                break;
            case 'thinking':
                dotHtml = '<i class="fas fa-spinner fa-pulse" style="color: #ffd966; font-size: 0.6rem;"></i>';
                text = customText || '思考中 ...';
                break;
            case 'speaking':
                dotHtml = '<i class="fas fa-volume-up fa-fade" style="color: #5f7eff; font-size: 0.6rem;"></i>';
                text = customText || '语音生成中 ...';
                break;
            case 'offline':
                dotHtml = '<i class="fas fa-circle" style="color: #ff5c4a; font-size: 0.6rem;"></i>';
                text = customText || '离线 · 连接失败';
                break;
            default:
                return;
        }
        
        statusTextElem.innerHTML = `${dotHtml} ${text}`;
        // 同步全局语音状态
        isTTSSpeaking = (state === 'speaking');
    }

    async function init() {
        await initData();
        initResizer();
        bindEvents();
    }
    init();
})();