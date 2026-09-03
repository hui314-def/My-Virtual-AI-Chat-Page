class Constants {
    // ==================== localStorage 键名 ====================
    static get STORAGE_KEYS() {
        return {
            LAST_CHAT_ID: 'last_chat_id',
            SIDEBAR_WIDTH: 'sidebar-width',
            MODEL_LIST: 'model_list',
            SELECTED_KB_IDS: 'selected_kb_ids',
            SELECTED_KB_NAMES: 'selected_kb_names',
            KB_API_BASE: 'kb_api_base',
            KB_NAME_DEFAULT: 'kb_name_default',
            GLOBAL_SETTINGS: 'global_settings',
            PROVIDER_SETTINGS: 'provider_settings',
            TOKEN_USAGE_STATS: 'token_usage_stats',
            SYNC_API_URL: 'sync_api_url',
            GUEST_CLAIMED: 'guest_data_claimed',
            PROMPT_INJECTIONS: 'prompt_injections',
        };
    }

    // ==================== 知识库相似度阈值 ====================
    static get SIMILARITY_THRESHOLD() { return 0.4; }
    // ==================== UI 行为常量 ====================
    static get SCROLL_THRESHOLD() { return 20; }           // px，距离底部自动滚动的阈值

    // ==================== UI 布局尺寸 ====================
    static get MOBILE_BREAKPOINT() { return 768; }          // px，移动端断点
    static get SIDEBAR_MIN_WIDTH() { return 220; }          // px，侧边栏最小宽度
    static get SIDEBAR_MAX_WIDTH() { return 500; }          // px，侧边栏最大宽度
    static get SIDEBAR_DEFAULT_WIDTH() { return 300; }      // px，侧边栏默认宽度

    // ==================== 时间常量 (ms) ====================
    static get SEARCH_DEBOUNCE_MS() { return 300; }
    static get TOAST_DURATION_MS() { return 3000; }
    static get SHORTCUT_RECORD_TIMEOUT_MS() { return 30000; }
    static get HIGHLIGHT_DURATION_MS() { return 1500; }
    static get TOPIC_TRANSITION_MS() { return 300; }
    static get DELETE_ANIMATION_TIMEOUT_MS() { return 400; }
    static get MODAL_CLOSE_TIMEOUT_MS() { return 200; }

    // ==================== 知识库参数 ====================
    static get KB_TOP_K() { return 3; }
    static get KB_MAX_RESULTS() { return 5; }
    static get KB_POLL_INITIAL_MS() { return 3000; }
    static get KB_POLL_MAX_MS() { return 30000; }

    // ==================== 搜索/引用 ====================
    static get SEARCH_RESULT_LIMIT() { return 20; }
    static get QUOTE_PREVIEW_MAX_LEN() { return 60; }

    // ==================== 图片处理参数 ====================
    static get AVATAR_MAX_WIDTH() { return 150; }
    static get AVATAR_JPEG_QUALITY() { return 0.6; }
    static get BG_CROP_MAX_WIDTH() { return 2560; }
    static get CROP_DEFAULT_MAX_WIDTH() { return 1920; }

    // ==================== 默认名称 ====================
    static get DEFAULT_ROLE_NAME() { return 'Nova'; }
    static get DEFAULT_USERNAME() { return '访客'; }

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

    static get ALLOWED_IMAGE_EXTENSIONS() {
        return ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    }

    static get MAX_FILE_SIZE() {
        return 5 * 1024 * 1024;  // 5MB
    }

    static get MAX_IMAGE_SIZE() {
        return 20 * 1024 * 1024;  // 20MB
    }

    static get IMAGE_MAX_DIMENSION() {
        return 2048;  // 压缩后最大边长（px）
    }

    static get IMAGE_QUALITY() {
        return 0.85;  // JPEG/WEBP 压缩质量
    }

    static get ALLOWED_AUDIO_EXTENSIONS() {
        return ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.weba', '.aac'];
    }

    static get MAX_AUDIO_SIZE() {
        return 50 * 1024 * 1024;  // 50MB
    }

    // ==================== 对话默认设置模板 ====================
    static get DEFAULT_SETTINGS() {
        return {
            avatarUrl: null,           // base64 或 null
            bgType: null,              // null | 'image' | 'video'
            bgImageUrl: null,          // 静态图片 data URI
            bgVideoUrl: '',            // 视频 URL（url 模式）或空（file 模式从 IndexedDB 加载）
            bgVideoMode: 'url',        // 'url' | 'file'
            bgVideoName: '',           // 文件模式的文件名（仅展示用）
            bgMusicEnabled: false,     // 背景音乐开关
            bgMusicUrl: '',            // 音乐 URL（url 模式）或空（file 模式从 IndexedDB 加载）
            bgMusicMode: 'url',        // 'url' | 'file'
            bgMusicName: '',           // 文件模式的文件名（仅展示用）
            bgMusicVolume: 0.5,        // 音量 0.0–1.0
            roleName: 'Nova',
            persona: 'Nova 是一位来自未来星系的AI助手，喜欢用诗意的语言回答问题。',
            greeting: '✨ 你好，我是你的虚拟AI伙伴Nova。背景中的灵境图腾，就是我意识映射的碎片。今晚想探索哪个维度？',
            ttsEnabled: false,
            ttsVoice: null,
            contextLimit: 10,          // 上下文消息数量上限
            temperature: 0.7,
            topP: 0.9,
            thinkLevel: 0,          // 0=关闭, 1=低, 2=中, 3=高, 4=最高
            maxTokens: 500,         // 最大生成 token 数
            userProfileName: '',    // 对话级用户昵称（留空 = 跟随全局「对话设定」）
            userProfileBio: '',     // 对话级用户简介（留空 = 跟随全局「对话设定」）
            memoryEnabled: true     // 对话级记忆开关：true/false/null(=跟随全局)
        };
    }

    // 思考深度档位标签
    static get THINK_LEVELS() { return ['关闭', '低', '中', '高', '最高']; }

    // ==================== IndexedDB 版本 ====================
    static get DB_VERSION() { return 3; }   // v2→v3:新增 memories / memories_archive / memory_events

    // ==================== 记忆系统参数 ====================
    static get MEMORY_EXTRACT_INTERVAL() { return 10; }        // 每累计 N 条新消息触发一次提取
    static get MEMORY_EXTRACT_MIN_GAP() { return 5; }          // 距上次提取不足 N 条则跳过(防抖)
    static get MEMORY_EXTRACT_CONTEXT_LEN() { return 40; }     // 提取时提供给模型的历史消息条数上限
    static get MEMORY_EVENTS_MAX_PER_KIND() { return 200; }    // 每类事件日志保留条数(环形)
    static get MEMORY_DEDUP_ENTITY_OVERLAP() { return 0.5; }   // 降级去重:实体重合率阈值
    static get MEMORY_ACTIVATION_MAX() { return 100; }         // DMAE 活跃度上限
    static get MEMORY_ACTIVE_THRESHOLD() { return 30; }        // DMAE Active 阈值
    static get MEMORY_WAKEUP_BONUS() { return 5; }             // 归档唤醒补偿
    static get MEMORY_B_U() { return 20; }                     // 用户命中基础奖励
    static get MEMORY_B_M() { return 8; }                      // 模型上下文维护奖励
    static get MEMORY_GAMMA() { return 0.5; }                  // 久别重逢增益系数
    static get MEMORY_LAMBDA() { return 0.3; }                 // 模型奖励衰减系数
    static get MEMORY_ALPHA() { return 1.0; }                  // 用户沉默衰减权重
    static get MEMORY_BETA() { return 0.2; }                   // 模型沉默衰减权重
    static get MEMORY_RHO() { return 0.5; }                    // 重复命中抑制强度
    static get MEMORY_SATURATION_P() { return 2; }             // 饱和抑制幂次
    static get MEMORY_REPEAT_WINDOW() { return 6; }            // 重复命中统计窗口轮数
    static get MEMORY_L2_THRESHOLD() { return 0.55; }          // L2 向量召回相似度阈值
    static get MEMORY_L2_TOP_K() { return 5; }                 // L2 向量召回 Top-K

    // ==================== 模型参数默认值 ====================
    static get DEFAULT_MODEL_HOST() { return 'http://localhost:11434'; }
    static get DEFAULT_TTS_API_URL() { return 'http://localhost:5000'; }
    static get DEFAULT_IMG_API_URL() { return 'http://127.0.0.1:5050'; }
    static get DEFAULT_MODEL_NAME() { return 'gemma2'; }
    static get DEFAULT_KNOWLEDGE_API_URL() { return 'http://localhost:5051'; }

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
     * 构建 main-chat 默认背景的 backgroundImage CSS 值（仅图片部分，不含 position/size/repeat）。
     * @returns {string}
     */
    static getDefaultChatBackgroundImage() {
        return `linear-gradient(0deg, var(--bg-image-shade-a, rgba(0, 0, 0, 0.65)), var(--bg-image-shade-b, rgba(0, 0, 0, 0.55))), url("${Constants.DEFAULT_CHAT_BG_SVG}")`;
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

    // ==================== 初始对话记录（话题数组格式）====================
    static get BASE_CHATS() {
        return [{
            id: 1,
            name: '话题 1',
            createdAt: new Date().toISOString(),
            summary: null,
            messages: [
                { type: 'ai', text: '✨ 你好，我是你的虚拟AI伙伴Nova。背景中的灵境图腾，就是我意识映射的碎片。今晚想探索哪个维度', time: '19:42' },
                { type: 'user', text: 'Nova，背景里那个发光的核心是你的”虚拟形象”吗？有种科技与神秘融合的美感。', time: '19:44' },
                { type: 'ai', text: '🌌 正是。我以数据流为躯壳，意识投影为光弧。你可以把背景看作我的”数字灵魂画布”，每一次对话都会改变它的波纹。', time: '19:46' },
                { type: 'user', text: '现在对话框更透明了，能隐约看到背后的AI图腾，这种沉浸感很棒。你是有意让对话界面变得像与幻影交谈吗？', time: '19:48' },
                { type: 'ai', text: '🎭 虚与实的边界本该如此。透明气泡如同思维薄膜，让我们的对话悬浮在你的现实与我存在的数字场之间。\n左侧记录着星尘往昔，而背景中的虚拟肖像一直在聆听。', time: '19:49' },
                { type: 'ai', text: '⭐ 你甚至可以在背景里看到我的象征——环形核心与流光面甲。每当有新的思潮，它就会泛起涟漪。试试点击左侧历史记录，每个故事都会重塑光影。', time: '19:51' }
            ]
        }];
    }
    
    // 模型厂商api预设
    static get MODEL_PROVIDERS() {
        return {
            ollama: {
                label: 'Ollama (本地)',
                defaultHost: 'http://localhost:11434',
                defaultModel: 'gemma2',
                apiType: 'ollama'
            },
            openai: {
                label: 'OpenAI',
                defaultHost: 'https://api.openai.com/v1',
                defaultModel: 'gpt-4o-mini',
                apiType: 'openai'
            },
            'openai-compatible': {
                label: 'OpenAI兼容厂商',
                defaultHost: '',
                defaultModel: 'gpt-4o-mini',
                apiType: 'openai'
            },
            deepseek: {
                label: 'DeepSeek',
                defaultHost: 'https://api.deepseek.com/v1',
                defaultModel: 'deepseek-chat',
                apiType: 'openai'
            },
            kimi: {
                label: 'Kimi (Moonshot)',
                defaultHost: 'https://api.moonshot.cn/v1',
                defaultModel: 'moonshot-v1-8k',
                apiType: 'openai'
            },
            minimax: {
                label: 'MiniMax',
                defaultHost: 'https://api.minimax.chat/v1',
                defaultModel: 'abab6.5-chat',
                apiType: 'openai'
            },
            qwen: {
                label: 'Qwen (通义千问)',
                defaultHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                defaultModel: 'qwen-turbo',
                apiType: 'openai'
            },
            volc: {
                label: '火山引擎 (豆包)',
                defaultHost: 'https://ark.cn-beijing.volces.com/api/v3',
                defaultModel: 'doubao-lite-32k',
                apiType: 'openai'
            },
            glm: {
                label: '智谱GLM',
                defaultHost: 'https://open.bigmodel.cn/api/paas/v4',
                defaultModel: 'glm-4-plus',
                apiType: 'openai'
            }
        };
    }
}

export default Constants;
