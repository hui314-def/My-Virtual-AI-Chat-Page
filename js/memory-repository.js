// 记忆系统数据仓库：操作 IndexedDB 中的 memories / memories_archive / memory_events
// 复用 ChatRepository 已打开的 db 连接（通过注入 getDb），避免多连接版本冲突。
import Constants from './constants.js';

export class MemoryRepository {
    /**
     * @param {Object} deps
     * @param {() => Promise<IDBDatabase>} deps.getDb 返回已打开的 IndexedDB 连接
     */
    constructor({ getDb }) {
        this.getDb = getDb;
    }

    async #db() {
        return this.getDb();
    }

    // ==================== 热层 memories ====================

    async saveMemory(record) {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories', 'readwrite');
            tx.objectStore('memories').put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async loadAllMemories() {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories', 'readonly');
            const req = tx.objectStore('memories').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * 按记忆域加载热层记忆：当前角色的记忆 ∪ 全局记忆(chatId='global' 或 null)。
     * 其他角色的记忆不返回，实现角色隔离。
     * @param {number|string} chatId 当前对话 id
     */
    async loadMemoriesForChat(chatId) {
        const all = await this.loadAllMemories();
        return this.#filterDomain(all, chatId);
    }

    /** 按记忆域加载归档记忆（角色隔离版）。 */
    async loadArchivedForChat(chatId) {
        const all = await this.loadArchived();
        return this.#filterDomain(all, chatId);
    }

    /** 域过滤：chatId 匹配当前对话，或为全局记忆(chatId='global'/null)。 */
    #filterDomain(records, chatId) {
        const cid = String(chatId);
        return (records || []).filter(m =>
            m && (m.chatId === 'global' || m.chatId == null || String(m.chatId) === cid)
        );
    }

    async deleteMemory(id) {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories', 'readwrite');
            tx.objectStore('memories').delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ==================== 归档 memories_archive ====================

    async saveArchived(record) {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories_archive', 'readwrite');
            tx.objectStore('memories_archive').put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async loadArchived() {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories_archive', 'readonly');
            const req = tx.objectStore('memories_archive').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async deleteArchived(id) {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memories_archive', 'readwrite');
            tx.objectStore('memories_archive').delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ==================== 事件日志 memory_events ====================

    /** 写入一条事件日志，并做环形裁剪（每类保留最近 N 条）。 */
    async addEvent(record) {
        const db = await this.#db();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('memory_events', 'readwrite');
            tx.objectStore('memory_events').put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        await this.#trimEvents(record.kind);
    }

    /**
     * 读取事件日志（按 kind 过滤，时间倒序，最多 limit 条）。
     * @param {string|null} kind 'extract'|'hit'|'inject'|'switch'|'error'|null(全部)
     * @param {number} limit
     */
    async loadEvents(kind = null, limit = Constants.MEMORY_EVENTS_MAX_PER_KIND) {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memory_events', 'readonly');
            const store = tx.objectStore('memory_events');
            const out = [];
            const req = store.index('time').openCursor(null, 'prev');
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    const rec = cursor.value;
                    if (!kind || rec.kind === kind) {
                        out.push(rec);
                        if (out.length >= limit) { resolve(out); return; }
                    }
                    cursor.continue();
                } else {
                    resolve(out);
                }
            };
            req.onerror = () => reject(req.error);
        });
    }

    async clearEvents() {
        const db = await this.#db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('memory_events', 'readwrite');
            tx.objectStore('memory_events').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // 环形裁剪：某类日志超过上限，删除最旧的
    async #trimEvents(kind) {
        const db = await this.#db();
        return new Promise((resolve) => {
            const tx = db.transaction('memory_events', 'readwrite');
            const store = tx.objectStore('memory_events');
            const records = [];
            const req = store.index('time').openCursor(null, 'next');
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    if (cursor.value.kind === kind) records.push(cursor.value);
                    cursor.continue();
                } else {
                    const excess = records.length - Constants.MEMORY_EVENTS_MAX_PER_KIND;
                    for (let i = 0; i < excess; i++) {
                        store.delete(records[i].id);
                    }
                    resolve();
                }
            };
            req.onerror = () => resolve();
        });
    }

    // ==================== 按对话清理（删除对话时级联） ====================

    /** 删除某对话相关的全部记忆（热层 + 归档 + 日志）。全局记忆 chatId=null 不受影响。 */
    async deleteMemoriesByChatId(chatId) {
        const db = await this.#db();
        const delByChat = (storeName) => new Promise((resolve) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    if (cursor.value && String(cursor.value.chatId) === String(chatId)) {
                        store.delete(cursor.value.id);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        });
        await delByChat('memories');
        await delByChat('memories_archive');
        await delByChat('memory_events');
    }
}

export default MemoryRepository;
