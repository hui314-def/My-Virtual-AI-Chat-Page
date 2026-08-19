// 消息建议模块：聚焦输入框时显示「消息建议」按钮，点击后基于当前对话的历史语境
// 调用模型生成 3 种不同种类的候选消息（站在用户视角，帮用户继续对话），供用户选择发送。
// 依赖通过构造函数注入，避免循环引用。
import Constants from './constants.js';
import { escapeHtml } from './utils.js';

const MAX_CONTEXT_MESSAGES = 6;   // 提供给模型的历史消息条数（控制 token）

export class MessageSuggest {
    /**
     * @param {Object} ctx — 由 script.js 注入的上下文依赖
     * @param {HTMLElement} ctx.messageInputEl — 聊天输入框 textarea
     * @param {HTMLElement} ctx.suggestBtnEl — 消息建议按钮（输入框内）
     * @param {HTMLElement} ctx.modalEl — #suggest-modal 弹窗
     * @param {Function} ctx.getModalManager — () => ModalManager（懒取，防循环）
     * @param {Function} ctx.getModelService — () => ModelService（懒取）
     * @param {Function} ctx.getChats — () => chats 数组
     * @param {Function} ctx.getCurrentChatId — () => currentChatId
     * @param {Function} ctx.getCurrentTopicIndex — () => 当前话题索引（null 表示显示全部）
     * @param {Function} ctx.getSettingsManager — () => SettingsManager
     * @param {Function} ctx.getIsProcessing — () => boolean 是否 AI 正在回复
     * @param {Function} ctx.sendUserMessage — () => void 发送当前输入框内容（复用现有发送流程）
     */
    constructor(ctx) {
        this.messageInputEl = ctx.messageInputEl;
        this.suggestBtnEl = ctx.suggestBtnEl;
        this.modalEl = ctx.modalEl;
        this.getModalManager = ctx.getModalManager;
        this.getModelService = ctx.getModelService;
        this.getChats = ctx.getChats;
        this.getCurrentChatId = ctx.getCurrentChatId;
        this.getCurrentTopicIndex = ctx.getCurrentTopicIndex;
        this.getSettingsManager = ctx.getSettingsManager;
        this.getIsProcessing = ctx.getIsProcessing;
        this.sendUserMessage = ctx.sendUserMessage;

        this._bodyEl = ctx.modalEl.querySelector('#suggest-body');
        this._cache = { key: '', suggestions: [] };  // 内存缓存：key = 对话|话题
        this._isGenerating = false;                  // 防止连点重复请求

        // 保存绑定引用（便于需要时移除）
        this._onFocus = () => this.showBtn();
        this._onBlur = () => setTimeout(() => this.hideBtn(), 150);  // 延迟：给点击留时间
        this._onBtnMouseDown = (e) => e.preventDefault();  // 不转移输入框焦点
        this._onBtnClick = () => this.openModal();
        this._onCloseBtnClick = () => this.closeModal();
        this._onRegenerateClick = () => this.openModal(true);
        this._onKeydown = (e) => {
            if (e.key === 'Escape' && this.modalEl.style.display !== 'none') this.closeModal();
        };
    }

    // ==================== 按钮显隐 ====================

    showBtn() {
        this.suggestBtnEl.classList.add('visible');
    }

    hideBtn() {
        this.suggestBtnEl.classList.remove('visible');
    }

    // ==================== 绑定 ====================

    bind() {
        this.messageInputEl.addEventListener('focus', this._onFocus);
        this.messageInputEl.addEventListener('blur', this._onBlur);
        this.suggestBtnEl.addEventListener('mousedown', this._onBtnMouseDown);
        this.suggestBtnEl.addEventListener('click', this._onBtnClick);
        this.modalEl.querySelector('#close-suggest-modal').addEventListener('click', this._onCloseBtnClick);
        this.modalEl.querySelector('#cancel-suggest-btn').addEventListener('click', this._onCloseBtnClick);
        this.modalEl.querySelector('#regenerate-suggest-btn').addEventListener('click', this._onRegenerateClick);
        document.addEventListener('keydown', this._onKeydown);
    }

    // ==================== 弹窗 ====================

    /**
     * 打开建议弹窗。
     * @param {boolean} forceRegenerate - true 时忽略缓存，强制重新生成
     */
    async openModal(forceRegenerate = false) {
        if (this._isGenerating) return;
        if (this.getIsProcessing()) {
            this.getModalManager().showBriefToast('请等待当前回复完成后再生成建议');
            return;
        }
        const key = this._buildCacheKey();
        const cached = (!forceRegenerate && this._cache.key === key)
            ? this._cache.suggestions
            : null;

        this.modalEl.style.display = 'flex';
        if (cached) {
            this.renderSuccess(cached);
            return;
        }
        await this.generateSuggestions();
    }

    closeModal() {
        const modalManager = this.getModalManager();
        if (modalManager && typeof modalManager.closeModalWithAnimation === 'function') {
            modalManager.closeModalWithAnimation(this.modalEl);
        } else {
            this.modalEl.style.display = 'none';
        }
    }

    /** 选择一条建议：填入输入框并复用现有发送流程（自动处理附件/引用/锁） */
    handleSelect(text) {
        this.closeModal();
        this.messageInputEl.value = text;
        this.messageInputEl.style.height = 'auto';
        this.sendUserMessage();
    }

    // ==================== 生成 ====================

    async generateSuggestions() {
        this._isGenerating = true;
        this.renderLoading();
        try {
            const raw = await this._fetchFromModel();
            const suggestions = this.parseSuggestions(raw);
            if (suggestions.length === 0) throw new Error('未能解析出有效建议，请重试');
            this._cache = { key: this._buildCacheKey(), suggestions };
            this.renderSuccess(suggestions);
        } catch (err) {
            console.warn('生成消息建议失败:', err);
            this.renderError(err.message || '生成失败，请重试');
        } finally {
            this._isGenerating = false;
        }
    }

    /** 调用模型获取原始回复文本（非流式 + jsonFormat 强制 JSON） */
    async _fetchFromModel() {
        const settingsManager = this.getSettingsManager();
        const modelService = this.getModelService();
        // 确保配置最新（与 simulateAIResponse 一致）
        modelService.updateConfig({
            modelHost: settingsManager.getModelHost(),
            apiKey: settingsManager.getApiKey(),
            modelName: settingsManager.getModelName(),
        });
        return await modelService.generateText(this._buildPrompt(), {
            temperature: 1,    // 稍高温度，3 条建议更有差异性
            maxTokens: 300,      // 3 条建议约 100~200 字，留足余量
            thinkLevel: 0,       // 丢弃 thinking，避免污染 JSON 解析
            jsonFormat: true,    // Ollama → format:'json' / OpenAI 兼容 → response_format
        });
    }

    /** 组装 prompt：角色语境说明 + 最近对话记录 + 任务指令（要求 JSON 输出） */
    _buildPrompt() {
        const chats = this.getChats();
        const chat = chats.find(c => c.id == this.getCurrentChatId());
        const settings = (chat && chat.settings) || Constants.DEFAULT_SETTINGS;
        const roleName = settings.roleName || Constants.DEFAULT_ROLE_NAME;
        const rolePersona = settings.persona || '';
        const settingsManager = this.getSettingsManager();
        // 用户画像：优先当前对话设置，留空则回退全局「对话设定」。
        // 与 simulateAIResponse 一致：默认用户名在系统提示中显示为「用户」
        const chatProfileName = (settings.userProfileName || '').trim();
        const userName = chatProfileName || (settingsManager.getUsername() === Constants.DEFAULT_USERNAME
            ? '用户' : settingsManager.getUsername());

        // 历史消息（当前话题；"显示全部"则拍平所有话题）
        let history = [];
        const topicIdx = this.getCurrentTopicIndex();
        if (topicIdx !== null && chat && chat.topics && chat.topics[topicIdx]) {
            history = chat.topics[topicIdx].messages;
        } else {
            for (const topic of (chat && chat.topics) || []) {
                history = history.concat(topic.messages);
            }
        }
        const contextLines = history
            .slice(-MAX_CONTEXT_MESSAGES)
            .map(m => `${m.type === 'user' ? userName : roleName}：${m.text || ''}`)
            .join('\n');

        return `【对话中的角色简介】
姓名：${roleName}
${rolePersona ? '简介：' + rolePersona : ''}

【最近的对话记录】
${contextLines || '（暂无对话记录）'}

【任务】
你现在的身份是「${userName}」（正在与角色对话的用户）的对话灵感助手。
请阅读上面的对话记录，基于当前对话语境（剧情走向、角色的性格与说话方式），
站在「${userName}」的视角，生成 3 条【用户接下来可以发送给角色】的候选消息，
帮助用户自然地把对话继续下去。

请只输出一个 JSON 对象，不要输出任何解释或多余文字，格式严格如下：
{"suggestions":[{"kind":"种类名","content":"消息内容"}]}

要求：
1. suggestions 数组包含 3 条候选消息，kind（种类名）各不相同（例如：关心对方 / 推进剧情 / 幽默调侃 / 提问互动 /  等，根据语境自选更合适的角度）；
2. content 以「${userName}」的第一人称口吻书写，贴合当前语境，不违背已有剧情。内容可以包含人物动作、环境描写、情绪描述等非语言表达内容，当你的回复中包含这样的的内容时，请使用括号（）将这些内容包裹起来；
3. content 中的换行请用 \\n 转义，双引号用 \\" 转义，确保是合法 JSON；
4. 不要输出任何 HTML 标签或 Markdown 语法，纯文本即可。`;
    }

    // ==================== 解析（JSON 优先，文本兜底） ====================

    /**
     * 把模型原始回复解析为 [{ kind, content }, ...]，最多 3 条。
     * 1) 剥离 ```json 代码块并截取 { } 区间 → JSON.parse；
     * 2) 兜底：【种类名】内容 正则；
     * 3) 兜底：按行拆分取前 3 行。
     */
    parseSuggestions(raw) {
        if (!raw || typeof raw !== 'string') return [];
        let jsonText = raw.trim();

        // 剥离代码块包裹
        const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) jsonText = fence[1].trim();
        // 截取第一个 { 到最后一个 }（容忍前后多余文字）
        const start = jsonText.indexOf('{');
        const end = jsonText.lastIndexOf('}');
        if (start !== -1 && end > start) jsonText = jsonText.slice(start, end + 1);

        // 1. JSON
        try {
            const data = JSON.parse(jsonText);
            const list = Array.isArray(data && data.suggestions) ? data.suggestions : [];
            const result = list
                .filter(item => item && typeof item.kind === 'string' && typeof item.content === 'string' && item.content.trim())
                .map(item => ({ kind: item.kind.trim(), content: item.content.trim() }));
            if (result.length > 0) return result.slice(0, 3);
        } catch { /* 落入文本兜底 */ }

        // 2. 【种类名】内容
        const matches = [...raw.matchAll(/【([^】]+)】([\s\S]*?)(?=【|$)/g)];
        if (matches.length > 0) {
            return matches
                .slice(0, 3)
                .map(m => ({ kind: m[1].trim(), content: m[2].trim() }))
                .filter(item => item.content);
        }

        // 3. 按行拆分
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
        return lines.slice(0, 3).map((l, i) => ({ kind: `建议 ${i + 1}`, content: l }));
    }

    // ==================== 三态渲染 ====================

    renderLoading() {
        this._bodyEl.innerHTML = '<div class="suggest-state"><i class="fas fa-spinner fa-spin"></i>正在思考 3 种回复方式…</div>';
    }

    renderSuccess(suggestions) {
        this._bodyEl.innerHTML = suggestions.map((s, i) => `
            <button class="suggest-card" data-index="${i}">
                <span class="suggest-kind">${escapeHtml(s.kind)}</span>
                <span class="suggest-content">${escapeHtml(s.content)}</span>
            </button>
        `).join('');
        this._bodyEl.querySelectorAll('.suggest-card').forEach((card, i) => {
            card.addEventListener('click', () => this.handleSelect(suggestions[i].content));
        });
    }

    renderError(msg) {
        this._bodyEl.innerHTML = `<div class="suggest-state"><i class="fas fa-exclamation-triangle"></i>${escapeHtml(msg || '生成失败，请重试')}</div>`;
    }

    // ==================== 内部 ====================

    /** 缓存 key：生成与输入内容无关，只与对话 + 话题有关 */
    _buildCacheKey() {
        const topicIdx = this.getCurrentTopicIndex();
        return `${this.getCurrentChatId()}|${topicIdx ?? 'all'}`;
    }
}
