// 记忆命中检测：L1 关键词/实体匹配（每轮必跑、零后端依赖）。
// L2 向量召回（chromadb）为可选增强，后端不可用时抛错，由调用方降级为纯 L1。
import Constants from './constants.js';

export class MemoryRetriever {
    /**
     * 用户命中检测：实体的任一词出现在用户消息中（整词包含，忽略大小写）。
     * @param {Array} memories 热层记忆（active/dormant）
     * @param {string} userText 用户本轮消息
     * @returns {Set<string>} 命中的记忆 id 集合
     */
    static userHits(memories, userText) {
        const text = String(userText || '').toLowerCase();
        const hits = new Set();
        for (const m of memories || []) {
            if (!m || m.state === 'archived') continue;   // 归档走冷召回(阶段三)
            if (this.#entityMatched(m, text)) hits.add(m.id);
        }
        return hits;
    }

    /**
     * 模型命中检测：仅对 active 记忆生效（用于维护，不能激活休眠记忆）。
     * @param {Array} memories 热层记忆
     * @param {string} modelText 模型本轮输出
     * @returns {Set<string>}
     */
    static modelHits(memories, modelText) {
        const text = String(modelText || '').toLowerCase();
        const hits = new Set();
        for (const m of memories || []) {
            if (!m || m.state !== 'active') continue;
            if (this.#entityMatched(m, text)) hits.add(m.id);
        }
        return hits;
    }

    /**
     * 归档冷召回(关键词):用户输入命中 archived 记忆的实体 → 返回待唤醒的记忆 id。
     * 不依赖向量库,使用冷索引的 entities/triggerTerms(白皮书 7.2 的关键词层)。
     * @param {Array} archivedMemories
     * @param {string} userText
     * @returns {Set<string>}
     */
    static archivedHits(archivedMemories, userText) {
        const text = String(userText || '').toLowerCase();
        const hits = new Set();
        for (const m of archivedMemories || []) {
            if (!m) continue;
            if (this.#entityMatched(m, text)) hits.add(m.id);
        }
        return hits;
    }

    // ==================== L2 向量召回(可选,依赖 chromadb 后端) ====================

    /**
     * 语义召回：调后端 /memories/search，返回 score ≥ 阈值的记忆 id 集合。
     * 后端不可用时抛出异常（由调用方降级为纯 L1）。
     * @param {string} query
     * @param {string|number|null} chatId
     * @param {number} topK
     * @returns {Promise<Set<string>>}
     */
    static async semanticHits(query, chatId, topK = Constants.MEMORY_L2_TOP_K) {
        const base = this.#apiBase();
        const res = await fetch(`${base}/memories/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, chatId, top_k: topK }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const hits = new Set();
        for (const r of (data.results || [])) {
            if ((r.score || 0) >= Constants.MEMORY_L2_THRESHOLD) hits.add(r.id);
        }
        return hits;
    }

    /** 写入/更新一条记忆的 embedding（提取新记忆后调用，失败静默忽略）。 */
    static async upsertMemoryVector(record) {
        try {
            const base = this.#apiBase();
            await fetch(`${base}/memories/upsert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: record.id, content: record.content, chatId: record.chatId }),
            });
        } catch { /* 后端不可用，静默降级 */ }
    }

    /** 删除单条记忆的 embedding（失败静默忽略）。 */
    static async deleteMemoryVector(memoryId) {
        try {
            const base = this.#apiBase();
            await fetch(`${base}/memories/${memoryId}`, { method: 'DELETE' });
        } catch { /* ignore */ }
    }

    /** 按对话删除该角色的全部记忆 embedding（删除对话时级联，失败静默忽略）。 */
    static async deleteByChat(chatId) {
        try {
            const base = this.#apiBase();
            await fetch(`${base}/memories/by-chat/${chatId}`, { method: 'DELETE' });
        } catch { /* ignore */ }
    }

    static #apiBase() {
        try {
            return localStorage.getItem(Constants.STORAGE_KEYS.KB_API_BASE) || 'http://localhost:5051';
        } catch { return 'http://localhost:5051'; }
    }

    static #entityMatched(memory, lowerText) {
        for (const e of (memory.entities || [])) {
            const s = String(e).toLowerCase();
            if (s && lowerText.includes(s)) return true;
        }
        return false;
    }
}

export default MemoryRetriever;
