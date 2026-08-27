// 聊天数据持久化仓库（IndexedDB）负责 chats 数据的保存、加载、删除
import Constants from '../core/constants.js';

export class ChatRepository {
    /**
     * @param {() => string} [getDbName] 动态返回 IndexedDB 库名（用于按账号命名空间分库）
     */
    constructor(getDbName = () => 'ChatAppDB') {
        this.db = null;
        this.getDbName = getDbName;
        this.dbVersion = Constants.DB_VERSION;
        this.storeName = 'chats';
        this.snapshotStoreName = 'snapshots';
    }

    // 切换命名空间：关闭旧连接，下次 #openDB 用新库名重新打开
    switchNamespace() {
        if (this.db) {
            try { this.db.close(); } catch (e) { /* ignore */ }
            this.db = null;
        }
    }

    // 打开数据库连接
    async #openDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.getDbName(), this.dbVersion);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(this.snapshotStoreName)) {
                    db.createObjectStore(this.snapshotStoreName, { keyPath: 'id' });
                }
                // v3：记忆系统 store（热层 / 归档 / 事件日志）
                if (!db.objectStoreNames.contains('memories')) {
                    db.createObjectStore('memories', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('memories_archive')) {
                    db.createObjectStore('memories_archive', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('memory_events')) {
                    const eventsStore = db.createObjectStore('memory_events', { keyPath: 'id' });
                    eventsStore.createIndex('kind', 'kind', { unique: false });
                    eventsStore.createIndex('time', 'time', { unique: false });
                }
            };
        });
    }

    /** 暴露已打开的 db 连接，供 MemoryRepository 等复用（避免多连接版本冲突）。 */
    async getDb() {
        return this.#openDB();
    }

    /**
     * 保存单个对话（添加或更新）
     * @param {Object} chat
     */
    async saveChat(chat) {
        const db = await this.#openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(chat);
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * 保存所有对话（全量替换）
     * @param {Array} chats
     */
    async saveAllChats(chats) {
        const db = await this.#openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        await store.clear();
        for (const chat of chats) {
            store.put(chat);
        }
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * 加载所有对话
     * @returns {Promise<Array>}
     */
    async loadAllChats() {
        const db = await this.#openDB();
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 删除单个对话
     * @param {number|string} chatId
     */
    async deleteChat(chatId) {
        const db = await this.#openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(chatId);
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    // ===== 同步快照（话题级增量 diff 的基线） =====

    async saveSnapshot(chatId, snapshot) {
        const db = await this.#openDB();
        const tx = db.transaction(this.snapshotStoreName, 'readwrite');
        const store = tx.objectStore(this.snapshotStoreName);
        store.put({ id: chatId, data: snapshot });
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async getSnapshot(chatId) {
        const db = await this.#openDB();
        const tx = db.transaction(this.snapshotStoreName, 'readonly');
        const store = tx.objectStore(this.snapshotStoreName);
        const request = store.get(chatId);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSnapshot(chatId) {
        const db = await this.#openDB();
        const tx = db.transaction(this.snapshotStoreName, 'readwrite');
        const store = tx.objectStore(this.snapshotStoreName);
        store.delete(chatId);
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }
}