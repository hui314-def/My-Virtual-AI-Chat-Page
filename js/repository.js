// 聊天数据持久化仓库（IndexedDB）负责 chats 数据的保存、加载、删除
export class ChatRepository {
    constructor() {
        this.db = null;
        this.dbName = 'ChatAppDB';
        this.dbVersion = 1;
        this.storeName = 'chats';
    }

    // 打开数据库连接
    async #openDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
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
            };
        });
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
}