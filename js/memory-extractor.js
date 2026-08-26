// 记忆提取器：从对话中提取长期记忆事实（写入侧）
// 触发：每累计 N 条新消息 + 话题切换（带防抖）
// 提取：LLM 输出 JSON → 解析 → 去重（降级用实体重合）→ 写入热层 → 写提取日志
import Constants from './constants.js';
import { MemoryRetriever } from './memory-retriever.js';
import { SettingsManager } from './settings-manager.js';

const EXTRACT_PROMPT = `【任务目标】
从以上对话中提取值得长期记住的事实（用户偏好、关系、事件、目标）。

【要求】
1、只提取有长期价值的信息，忽略寒暄与临时话题。
2、输出一个 JSON 对象，result 为数组，格式如下：
{"result":[{"category":"user_pref|relationship|event|goal|fact",
 "content":"一句话事实", "entities":["关键词","实体名"], "importance":1-5}]}
3、如果没有任何值得记住的事实，result 输出空数组：{"result":[]}
4、必须只输出这个 JSON 对象本身，不要加入任何解释文本或代码块标记。`;

export class MemoryExtractor {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => Object} deps.getModelService
     * @param {Object} deps.memoryRepo MemoryRepository
     * @param {() => boolean} deps.getIsMemoryEnabled 记忆开关判断
     */
    constructor({ getChats, getCurrentChatId, getModelService, memoryRepo, getIsMemoryEnabled }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.getModelService = getModelService;
        this.memoryRepo = memoryRepo;
        this.getIsMemoryEnabled = getIsMemoryEnabled;
        this._lastExtractCount = new Map();  // chatId -> 上次提取时的消息总数
    }

    get chats() { return this.getChats(); }

    #countMessages(chat) {
        return (chat?.topics || []).reduce((n, t) => n + (t.messages?.length || 0), 0);
    }

    /** 收集某对话最近 N 条消息文本 */
    #collectRecentText(chat, limit = Constants.MEMORY_EXTRACT_CONTEXT_LEN) {
        const all = [];
        for (const t of (chat?.topics || [])) {
            for (const m of (t.messages || [])) {
                if (m && m.text) all.push(m);
            }
        }
        const recent = all.slice(-limit);
        return recent.map(m => `${m.type === 'user' ? '用户' : '助手'}：${m.text}`).join('\n');
    }

    /** 发送消息后调用：按消息数判断是否触发提取 */
    async checkIntervalExtract(chatId) {
        if (!this.getIsMemoryEnabled()) return;
        const chat = this.chats.find(c => c.id == chatId);
        if (!chat) return;
        const total = this.#countMessages(chat);
        const last = this._lastExtractCount.get(chatId) ?? 0;
        if (total - last >= Constants.MEMORY_EXTRACT_INTERVAL) {
            await this.extractFromChat(chatId);
        }
    }

    /** 话题切换后调用（带防抖：距上次提取不足 MIN_GAP 条则跳过） */
    async onTopicSwitch(chatId) {
        if (!this.getIsMemoryEnabled()) return;
        const chat = this.chats.find(c => c.id == chatId);
        if (!chat) return;
        const total = this.#countMessages(chat);
        const last = this._lastExtractCount.get(chatId) ?? 0;
        if (last > 0 && total - last < Constants.MEMORY_EXTRACT_MIN_GAP) return;
        await this.extractFromChat(chatId);
    }

    /** 立即对某对话执行一次提取 */
    async extractFromChat(chatId) {
        if (!this.getIsMemoryEnabled()) return;
        const chat = this.chats.find(c => c.id == chatId);
        if (!chat) return;
        const text = this.#collectRecentText(chat);
        if (!text.trim()) return;

        const modelService = this.getModelService();
        // 使用「辅助任务模型」(可在模型设置中选择；未设置则跟随主模型)
        // ModelService 是懒创建单例,切换模型只更新 SettingsManager,这里需手动同步 config
        if (modelService && typeof modelService.updateConfig === 'function') {
            modelService.updateConfig({
                modelHost: SettingsManager.getModelHost(),
                apiKey: SettingsManager.getApiKey(),
                modelName: SettingsManager.getAuxEffectiveModel(),
            });
        }
        let facts = [];
        try {
            const raw = await modelService.generateText(
                `【对话内容】\n${text}\n\n${EXTRACT_PROMPT}`,
                { temperature: 0.2, maxTokens: 600, jsonFormat: true }
            );
            facts = this.#parseFacts(raw);
        } catch (err) {
            console.warn('[MemoryExtractor] 提取失败：', err);
            await this.#log(chatId, 'extract', { action: 'fail', error: err.message || 'unknown' });
            return;
        }

        if (facts.length === 0) {
            await this.#log(chatId, 'extract', { action: 'none', message: '未提取到事实' });
        }

        const existing = await this.memoryRepo.loadAllMemories();
        for (const fact of facts) {
            if (this.#isDuplicate(fact, existing)) {
                await this.#log(chatId, 'extract', { action: 'dup', content: fact.content });
                continue;
            }
            const record = this.#buildRecord(chatId, fact);
            await this.memoryRepo.saveMemory(record);
            existing.push(record);  // 本轮内去重
            MemoryRetriever.upsertMemoryVector(record);  // 异步同步向量到后端(失败静默)
            await this.#log(chatId, 'extract', { action: 'new', content: fact.content, category: fact.category });
        }

        this._lastExtractCount.set(chatId, this.#countMessages(chat));
    }

    #buildRecord(chatId, fact) {
        const importance = Math.max(1, Math.min(5, Number(fact.importance) || 3));
        return {
            id: (crypto.randomUUID && crypto.randomUUID()) || `mem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            chatId,
            category: fact.category || 'fact',
            content: String(fact.content || '').trim(),
            entities: Array.isArray(fact.entities) ? fact.entities.map(String) : [],
            importance,
            intrinsicValue: importance * 0.4,   // 1~5 → 0.4~2.0
            activation: 50,                      // 阶段一初始活跃度，阶段二由 DMAE 接管
            state: 'active',
            userSilence: 0,
            modelSilence: 0,
            recentUserHits: [],
            resident: false,
            pinned: false,
            sourceMsgIds: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null,
            supersededBy: null,
        };
    }

    #isDuplicate(fact, existing) {
        const fe = new Set((fact.entities || []).map(e => String(e).toLowerCase()));
        for (const rec of existing) {
            if (rec.content === String(fact.content).trim()) return true;
            if (fe.size === 0) continue;
            const ee = new Set((rec.entities || []).map(e => String(e).toLowerCase()));
            let overlap = 0;
            for (const e of fe) if (ee.has(e)) overlap++;
            if (overlap / fe.size >= Constants.MEMORY_DEDUP_ENTITY_OVERLAP) return true;
        }
        return false;
    }

    /** 解析模型输出为事实数组（容忍 markdown 代码块/包装对象/多余文本） */
    #parseFacts(raw) {
        let text = String(raw || '').trim();
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) text = fence[1].trim();
        // 归一化:仅接受数组;非数组返回 null(让后续容错继续尝试)
        const norm = (v) => Array.isArray(v) ? v.filter(f => f && typeof f === 'object' && f.content) : null;

        // 1. 直接解析
        try {
            const parsed = JSON.parse(text);
            // 1.1 首选:标准格式 {"result": [...]}(新提示词);result 存在(含空数组)直接返回
            if (parsed && typeof parsed === 'object') {
                const facts = norm(parsed.result);
                if (facts !== null) return facts;
            }
            // 1.2 兼容旧格式:纯数组(含空数组)
            const facts = norm(parsed);
            if (facts !== null) return facts;
            // 1.3 兼容:单对象(模型只输出一条) → 包装为数组
            if (parsed && typeof parsed === 'object' && parsed.content) return [parsed];
            // 1.4 兼容:其他包装对象 {"facts":[...]} 等 → 找第一个含有效元素的数组字段
            if (parsed && typeof parsed === 'object') {
                for (const v of Object.values(parsed)) {
                    const sub = norm(v);
                    if (sub !== null && sub.length > 0) return sub;
                }
            }
        } catch { /* 非法 JSON,继续尝试提取数组段 */ }

        // 4. 从文本中提取数组段(容忍多余前后缀/嵌套包装)
        const m = text.match(/\[[\s\S]*\]/);
        if (m) {
            try {
                const facts = norm(JSON.parse(m[0]));
                if (facts !== null) return facts;
            } catch { /* 放弃 */ }
        }
        return [];
    }

    async #log(chatId, kind, detail) {
        try {
            await this.memoryRepo.addEvent({
                id: (crypto.randomUUID && crypto.randomUUID()) || `ev_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                kind,
                time: Date.now(),
                chatId,
                detail,
            });
        } catch (err) {
            console.warn('[MemoryExtractor] 写日志失败：', err);
        }
    }
}

export default MemoryExtractor;
