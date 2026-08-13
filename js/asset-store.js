// 基于 IndexedDB 的二进制资产存储（视频背景等大文件）
// 与 ChatRepository（存聊天记录）分开，避免版本冲突
const DB_NAME = 'app-assets';
const STORE_NAME = 'backgrounds';
const DB_VERSION = 1;

class AssetStore {
    /** @returns {Promise<IDBDatabase>} */
    static async #open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                    req.result.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** @param {string|number} id — 通常是 chatId */
    static #key(id) { return `bg-video-${id}`; }
    static #audioKey(id) { return `bg-music-${id}`; }

    /**
     * 保存视频 Blob
     * @param {string|number} id
     * @param {Blob} blob
     */
    static async saveVideo(id, blob) {
        const db = await this.#open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(blob, this.#key(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * 读取视频 Blob，不存在返回 null
     * @param {string|number} id
     * @returns {Promise<Blob|null>}
     */
    static async getVideo(id) {
        const db = await this.#open();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(this.#key(id));
            req.onsuccess = () => { db.close(); resolve(req.result || null); };
            tx.onerror = () => { db.close(); resolve(null); };
        });
    }

    /**
     * 删除存储的视频
     * @param {string|number} id
     */
    static async deleteVideo(id) {
        const db = await this.#open();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(this.#key(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); resolve(); };
        });
    }

    /**
     * 保存音频 Blob
     * @param {string|number} id
     * @param {Blob} blob
     */
    static async saveAudio(id, blob) {
        const db = await this.#open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(blob, this.#audioKey(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * 读取音频 Blob，不存在返回 null
     * @param {string|number} id
     * @returns {Promise<Blob|null>}
     */
    static async getAudio(id) {
        const db = await this.#open();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(this.#audioKey(id));
            req.onsuccess = () => { db.close(); resolve(req.result || null); };
            tx.onerror = () => { db.close(); resolve(null); };
        });
    }

    /**
     * 删除存储的音频
     * @param {string|number} id
     */
    static async deleteAudio(id) {
        const db = await this.#open();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(this.#audioKey(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); resolve(); };
        });
    }

    /** 清理旧版单 key 遗留数据（从全局 bg-video 迁移到 bg-video-{chatId} 之前的残留） */
    static async cleanupOrphaned() {
        const db = await this.#open();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete('bg-video');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); resolve(); };
        });
    }
}

export default AssetStore;
