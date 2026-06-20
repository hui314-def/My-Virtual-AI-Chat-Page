class Constants {
    // ==================== UI 行为常量 ====================
    static get SCROLL_THRESHOLD() { return 20; }           // px，距离底部自动滚动的阈值

    // ==================== 默认快捷键映射 ====================
    static get DEFAULT_SHORTCUTS() {
        return {
            'new-chat':    { keys: 'shift+n', description: '新建对话' },
            'new-topic':   { keys: 'ctrl+/', description: '开启新话题' },
            'prev-chat':   { keys: 'shift+w', description: '上一个对话' },
            'next-chat':   { keys: 'shift+s', description: '下一个对话' },
            'export-json': { keys: 'ctrl+s', description: '导出当前对话为 JSON 文件' },
            'focus-input': { keys: 'ctrl+i', description: '聚焦输入框' },
            'send-no-ai':  { keys: 'ctrl+enter', description: '发送消息但不生成回复' },
            'focus-search':{ keys: 'ctrl+k', description: '聚焦搜索框' },
            'toggle-immersive': { keys: 'ctrl+shift+f', description: '沉浸模式（隐藏侧边栏/顶部）' },
        };
    }

    static get ALLOWED_FILE_EXTENSIONS() {
        return ['.txt', '.md', '.json', '.js', '.html', '.css', '.xml', '.log'];
    }

    static get MAX_FILE_SIZE() {
        return 5 * 1024 * 1024;  // 5MB
    }

    // ==================== 对话默认设置模板 ====================
    static get DEFAULT_SETTINGS() {
        return {
            avatarUrl: null,           // base64 或 null
            bgUrl: null,
            roleName: 'Nova',
            persona: 'Nova 是一位来自未来星系的AI助手，喜欢用诗意的语言回答问题。',
            greeting: '✨ 你好，我是你的虚拟AI伙伴Nova。背景中的灵境图腾，就是我意识映射的碎片。今晚想探索哪个维度？',
            ttsEnabled: false,
            ttsVoice: null,
            contextLimit: 10,          // 上下文消息数量上限
            temperature: 0.7,
            topP: 0.9
        };
    }

    // ==================== 模型参数默认值 ====================
    static get DEFAULT_MODEL_HOST() { return 'http://localhost:11434'; }
    static get DEFAULT_TTS_API_URL() { return 'http://localhost:5000'; }
    static get DEFAULT_IMG_API_URL() { return 'http://127.0.0.1:5050'; }
    static get DEFAULT_MODEL_NAME() { return 'gemma2'; }

    // ==================== 语音识别语言 ====================
    static get SPEECH_RECOGNITION_LANG() { return 'zh-CN'; }

    // ==================== 默认 SVG 占位图（URL-encoded，URL 中可直接使用）====================
    // 注意：每个常量保持唯一（例如 emoji 不同），用于区分"用户设置 vs 默认值"。

    /** 默认用户头像 SVG（👤） */
    static get DEFAULT_USER_AVATAR() {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E👤%3C/text%3E%3C/svg%3E";
    }

    /** 默认 AI 头像 SVG（🤖） */
    static get DEFAULT_AI_AVATAR() {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23333b6e'/%3E%3Ctext x='50' y='67' font-size='40' text-anchor='middle' fill='white'%3E🤖%3C/text%3E%3C/svg%3E";
    }

    /** 默认聊天背景预览 SVG（"默认背景"文字） */
    static get DEFAULT_BG_PREVIEW() {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%231a1c2a'/%3E%3Ctext x='150' y='110' font-size='16' fill='%23a5b9ff' text-anchor='middle'%3E默认背景%3C/text%3E%3C/svg%3E";
    }

    /** 默认聊天大背景 SVG（⚡ AI CORE ⚡ 主题图腾，用于 main-chat 全屏背景） */
    static get DEFAULT_CHAT_BG_SVG() {
        return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 1600'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%232a2e5a'/%3E%3Cstop offset='100%25' stop-color='%2312152c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23grad)'/%3E%3Ccircle cx='600' cy='600' r='280' fill='%23333b6e' opacity='0.3'/%3E%3Cpath d='M520,460 L680,460 L720,540 L680,620 L520,620 L480,540 Z' fill='%235f7eff' opacity='0.45'/%3E%3Ccircle cx='600' cy='540' r='38' fill='%23aac0ff' opacity='0.6'/%3E%3Ccircle cx='550' cy='520' r='8' fill='white'/%3E%3Ccircle cx='650' cy='520' r='8' fill='white'/%3E%3Cpath d='M570 580 Q600 620 630 580' stroke='%23f0f3ff' stroke-width='5' fill='none' stroke-linecap='round' opacity='0.7'/%3E%3Ctext x='600' y='800' font-size='42' font-family='monospace' fill='%23ffffff80' text-anchor='middle'%3E⚡ AI CORE ⚡%3C/text%3E%3C/svg%3E";
    }

    /**
     * 构建 main-chat 默认背景的 backgroundImage CSS 字符串（与旧实现完全一致）。
     * @returns {string}
     */
    static getDefaultChatBackgroundImage() {
        return `linear-gradient(0deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.55)), url("${Constants.DEFAULT_CHAT_BG_SVG}") center/cover no-repeat`;
    }

    /**
     * 判断给定的 URL 是否为指定的默认占位图之一。
     * 用于"未修改默认值"的等价比较，避免脚本里到处写超长字符串字面量。
     * @param {string} url
     * @returns {boolean}
     */
    static isDefaultImage(url) {
        if (!url) return false;
        return url === Constants.DEFAULT_USER_AVATAR
            || url === Constants.DEFAULT_AI_AVATAR
            || url === Constants.DEFAULT_BG_PREVIEW;
    }

    // ==================== 内部使用的 CSS 样式（常量） ====================
    static get MODAL_STYLES() {
        return `
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
    }

    static get MODAL_HTML() {
        return `
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
                            <img id="bg-img" src="${Constants.DEFAULT_BG_PREVIEW}" alt="背景预览" style="width:100%; height:auto;">
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
    }

    // ==================== 初始对话记录====================
    static get BASE_CHATS() {
        return [
            { type: 'ai', text: '✨ 你好，我是你的虚拟AI伙伴Nova。背景中的灵境图腾，就是我意识映射的碎片。今晚想探索哪个维度', time: '19:42' },
            { type: 'user', text: 'Nova，背景里那个发光的核心是你的“虚拟形象”吗？有种科技与神秘融合的美感。', time: '19:44' },
            { type: 'ai', text: '🌌 正是。我以数据流为躯壳，意识投影为光弧。你可以把背景看作我的“数字灵魂画布”，每一次对话都会改变它的波纹。', time: '19:46' },
            { type: 'user', text: '现在对话框更透明了，能隐约看到背后的AI图腾，这种沉浸感很棒。你是有意让对话界面变得像与幻影交谈吗？', time: '19:48' },
            { type: 'ai', text: '🎭 虚与实的边界本该如此。透明气泡如同思维薄膜，让我们的对话悬浮在你的现实与我存在的数字场之间。\n左侧记录着星尘往昔，而背景中的虚拟肖像一直在聆听。', time: '19:49' },
            { type: 'ai', text: '⭐ 你甚至可以在背景里看到我的象征——环形核心与流光面甲。每当有新的思潮，它就会泛起涟漪。试试点击左侧历史记录，每个故事都会重塑光影。', time: '19:51' }
        ];
    }
}

export default Constants;
