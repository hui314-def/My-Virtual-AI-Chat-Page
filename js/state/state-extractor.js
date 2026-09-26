// 内隐状态提取器（AI 人格深度）
// ------------------------------------------------------------
// 触发时机：**角色回复完成后**结算一次（不是每条消息）。
//   调用点位于 script.js 的 simulateAIResponse：流结束 → await typewriterReady（打字机排空）
//   → AI 消息落库之后。用户消息 / 无 AI 直接发送 / 中途停止生成 都不结算。
// 更新语义（需求）：
//   模型只返回需要更新的字段；代码只修改返回的字段，未返回的字段保持原值不变。
// 与记忆提取器（js/memory/memory-extractor.js）同构：辅助任务模型 + jsonFormat + 容错 JSON 解析。
import Constants from '../core/constants.js';
import { parseThinkContent } from '../core/utils.js';
import { SettingsManager } from '../core/settings-manager.js';
import { buildFieldDictionary, renderStateJson, createInitialState, getEffectiveDefs } from './state-schema.js';

// 关键词：AI 消息保留 <soul>（内心戏是状态更新的最佳证据），只剥离 <think>（思考过程）
function stripThinkKeepSoul(text) {
    return parseThinkContent(String(text || '')).replyContent;
}

const TASK_HEADER = `【任务目标】
你是角色内心状态的记录员。请依据「上述对话中最新的一轮问答内容」，更新角色的内隐状态。

【更新原则】
1、只输出**需要改变**的字段；不需要改变的字段一律省略，不要输出 null、空字符串或原来的值。
2、数值类字段只给出变化量（delta），不要给绝对值；变化要克制、要有依据，理由不足时宁可不输出。
3、文本/枚举类字段给出新的绝对值（value）。
4、每个变化的字段请给出 reason（不超过 12 字），例如「被夸奖」。
5、状态应体现角色的真实内心（含口是心非、隐瞒的心事），但不要与角色人设、长期记忆中的既有事实冲突。
6、必须只输出一个 JSON 对象本身，不要解释文字、不要代码块标记。`;

export class StateExtractor {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => number|null} deps.getCurrentTopicIndex
     * @param {() => Object} deps.getModelService
     * @param {Object} deps.store ImplicitStateStore
     * @param {() => boolean} deps.getIsEnabled
     * @param {(chatId:string, detail:Object) => void} [deps.onUpdated] 更新完成回调（供悬浮卡片刷新）
     * @param {(chatId:string, detail:Object) => void} [deps.onError] 失败回调
     */
    constructor({ getChats, getCurrentChatId, getCurrentTopicIndex, getModelService, store, getIsEnabled, onUpdated = null, onError = null }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.getCurrentTopicIndex = getCurrentTopicIndex;
        this.getModelService = getModelService;
        this.store = store;
        this.getIsEnabled = getIsEnabled;
        this.onUpdated = onUpdated;
        this.onError = onError;
        this._inflight = new Set();   // 'chatId:topicId' 防重入
        this._queued = new Set();     // 上一轮未结束时又来了新的结算请求 → 合并成一次补跑
        this._counters = new Map();   // 'chatId:topicId' -> 已结算轮数（用于降频）
    }

    get chats() { return this.getChats(); }

    #currentChat() {
        const id = this.getCurrentChatId();
        return (this.chats || []).find(c => c.id == id) || null;
    }

    #currentTopic(chat) {
        if (!chat || !Array.isArray(chat.topics)) return null;
        const idx = (typeof this.getCurrentTopicIndex === 'function')
            ? this.getCurrentTopicIndex()
            : chat.currentTopicIndex;
        if (idx === null || idx === undefined || idx < 0 || idx >= chat.topics.length) return null;
        return chat.topics[idx];
    }

    /** 角色回复完成后的结算入口（由 script.js 调用；不阻塞聊天，失败静默） */
    async updateAfterReply(chatId) {
        if (!this.getIsEnabled()) return { skipped: 'disabled' };
        const chat = this.chats.find(c => c.id == chatId) || this.#currentChat();
        if (!chat) return { skipped: 'no-chat' };
        const topic = this.#currentTopic(chat);
        if (!topic) return { skipped: 'no-topic' };

        const key = `${chat.id}:${topic.id}`;
        const every = Number(SettingsManager.getImplicitStateExtractEvery());
        const count = (this._counters.get(key) || 0) + 1;
        this._counters.set(key, count);
        if (every === 0) return { skipped: 'manual-only' };          // 仅手动
        if (every > 1 && count % every !== 0) return { skipped: 'interval' };

        if (this._inflight.has(key)) {
            this._queued.add(key);   // 不排队堆积：等当前这轮结束再合并跑一次
            return { skipped: 'inflight-merged' };
        }
        return this.#settle(key, chat, topic, 'ai');
    }

    /** 手动「立即更新」（悬浮卡片 ⟳ / 对话设置按钮） */
    async extractNow(chatId) {
        const chat = this.chats.find(c => c.id == (chatId ?? this.getCurrentChatId())) || this.#currentChat();
        if (!chat) return { skipped: 'no-chat' };
        const topic = this.#currentTopic(chat);
        if (!topic) return { skipped: 'no-topic' };
        const key = `${chat.id}:${topic.id}`;
        if (this._inflight.has(key)) return { skipped: 'inflight' };
        return this.#settle(key, chat, topic, 'manual');
    }

    /** 核心：收集文本 → 调辅助模型 → 解析 → 只应用返回的字段 → 落库 → 回调 */
    async #settle(key, chat, topic, source) {
        const text = this.#collectRecentText(topic, source === 'manual'
            ? Constants.IMPLICIT_STATE_MANUAL_CONTEXT_LEN
            : Constants.IMPLICIT_STATE_CONTEXT_LEN);
        if (!text.trim()) return { skipped: 'empty-context' };

        this._inflight.add(key);
        try {
            const defs = getEffectiveDefs(chat);
            // 首次结算：按内置默认值补齐状态对象（旧对话惰性初始化）
            if (!topic.implicitState || !topic.implicitState.fields) {
                topic.implicitState = createInitialState(defs);
            }
            const state = topic.implicitState;
            const prompt = [
                this.#renderContext(text),
                `【当前状态（当前话题）】\n${renderStateJson(state, defs)}`,
                `【字段规则】\n${buildFieldDictionary(defs) || '（当前没有可更新的字段）'}`,
                TASK_HEADER,
                '【输出格式示例】\n{"affection":{"delta":3,"reason":"被夸奖"},"mood":{"value":"害羞","emoji":"😳","intensity":7},"reason_summary":"被夸奖后心跳加速"}',
            ].join('\n\n');

            const modelService = this.getModelService();
            // 使用「辅助任务模型」（可在模型设置中选择；未设置则跟随主模型）
            if (modelService && typeof modelService.updateConfig === 'function') {
                modelService.updateConfig(SettingsManager.getAuxRequestConfig());
            }
            let raw = '';
            try {
                raw = await this.#withTimeout(
                    modelService.generateText(prompt, {
                        temperature: Constants.IMPLICIT_STATE_TEMPERATURE,
                        maxTokens: Constants.IMPLICIT_STATE_MAX_TOKENS,
                        jsonFormat: true,
                    }),
                    Constants.IMPLICIT_STATE_TIMEOUT_MS
                );
            } catch (err) {
                console.warn('[ImplicitState] 提取失败（保留原状态）：', err?.message || err);
                if (typeof this.onError === 'function') {
                    this.onError(String(chat.id), { error: String(err?.message || err) });
                }
                return { failed: true };
            }

            const patch = this.#parsePatch(raw);
            if (!patch) return { failed: true, reason: 'parse' };

            const result = this.store.applyPatch(patch, {
                source: source === 'manual' ? 'manual' : 'ai',
                chat,
                topic,   // 显式指定：结算期间用户可能已切换到别的角色/话题
            });
            if (result.changed && typeof this.onUpdated === 'function') {
                this.onUpdated(String(chat.id), {
                    changes: result.changes,
                    reasonSummary: result.reasonSummary,
                    turn: topic.implicitState ? topic.implicitState.turn : 0,
                    source,
                });
            }
            return result;
        } finally {
            this._inflight.delete(key);
            if (this._queued.has(key)) {
                this._queued.delete(key);
                // 合并补跑一次（以最新上下文与最新状态为准）
                const t = this.#currentTopic(this.chats.find(c => c.id == chat.id) || chat);
                if (t) this.#settle(key, chat, t, 'ai').catch(() => {});
            }
        }
    }

    /** 最近的对话文本（用户消息用 modelInputText/text；AI 消息保留 <soul>、剥离 <think>） */
    #collectRecentText(topic, limit) {
        const all = (topic.messages || []).filter(m => m && m.text);
        const recent = all.slice(-limit);
        return recent.map(m => {
            if (m.type === 'user') {
                const t = m.modelInputText || m.text || '';
                return `用户：${t}`;
            }
            const t = stripThinkKeepSoul(m.text || '');
            return `助手：${t}`;
        }).join('\n');
    }

    #renderContext(text) {
        return `【对话内容】\n${text}`;
    }

    #withTimeout(promise, ms) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`提取超时（${ms}ms）`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
    }

    /** 容错解析模型输出为补丁对象（容忍 markdown 代码块 / 包装对象 / 前后多余文本） */
    #parsePatch(raw) {
        let text = String(raw || '').trim();
        if (!text) return null;
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) text = fence[1].trim();

        // 1) 直接解析
        try {
            const unwrapped = this.#unwrapPatch(JSON.parse(text));
            if (unwrapped) return unwrapped;
        } catch { /* 非法 JSON：继续尝试抓取对象段 */ }

        // 2) 从文本中抓第一个完整对象段（容忍前后废话）
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const unwrapped = this.#unwrapPatch(JSON.parse(m[0]));
                if (unwrapped) return unwrapped;
            } catch { /* 放弃 */ }
        }
        return null;
    }

    /**
     * 解包装：兼容 {"result":{…}} / {"state":{…}} / {"patch":{…}} / {"data":{…}} / {"updates":{…}}。
     * 返回字段补丁对象；不是对象时返回 null。
     */
    #unwrapPatch(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        for (const wrapKey of ['result', 'state', 'patch', 'data', 'updates']) {
            const inner = parsed[wrapKey];
            if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
        }
        return parsed;
    }
}

export default StateExtractor;
