// 云同步仓库：与 ChatRepository 同接口，内部「本地 IndexedDB 缓存 + 后端写穿」双写。
// 通过替换 script.js 中的 chatRepo 实例，所有既有 saveChat/saveAllChats/deleteChat 调用自动变为双写。
// saveChat 走「话题级增量」PATCH（首次全量 PUT），saveAllChats / 离线补传仍走全量替换。
import { diffChat, cloneChat } from './chat-diff.js';

export class SyncedChatRepository {
    /**
     * @param {Object} deps
     * @param {Object} deps.localRepo    本地 ChatRepository（离线缓存 + 快照）
     * @param {Object} deps.backendClient BackendClient
     * @param {() => boolean} deps.getIsLoggedIn
     * @param {() => string} [deps.getNamespace] 命名空间（'' = 访客）
     */
    constructor({ localRepo, backendClient, getIsLoggedIn, getNamespace }) {
        this.localRepo = localRepo;
        this.backendClient = backendClient;
        this.getIsLoggedIn = getIsLoggedIn;
        this.getNamespace = getNamespace || (() => '');
    }

    // ===== 脏标记：离线未同步的会话（按命名空间隔离） =====
    #dirtyKey() { return 'chat_sync_dirty' + (this.getNamespace() ? '_' + this.getNamespace() : ''); }
    #getDirty() { try { return JSON.parse(localStorage.getItem(this.#dirtyKey())) || {}; } catch { return {}; } }
    #setDirty(map) { try { localStorage.setItem(this.#dirtyKey(), JSON.stringify(map)); } catch { /* ignore */ } }
    #markDirty(id) { const m = this.#getDirty(); m[String(id)] = true; this.#setDirty(m); }
    #clearDirty(id) { const m = this.#getDirty(); delete m[String(id)]; this.#setDirty(m); }
    #clearAllDirty() { this.#setDirty({}); }

    async saveChat(chat) {
        await this.localRepo.saveChat(chat);
        if (!this.getIsLoggedIn()) return;
        try {
            const snapshot = await this.localRepo.getSnapshot(chat.id);
            const patch = diffChat(snapshot, chat);
            if (patch.isNew) {
                await this.backendClient.putChat(chat.id, chat);   // 首次同步：全量建立
            } else if (patch.hasChanges) {
                await this.backendClient.patchChat(chat.id, {
                    meta: patch.meta,
                    topics: patch.topics,
                    removeTopicIds: patch.removeTopicIds,
                });
            }
            await this.localRepo.saveSnapshot(chat.id, cloneChat(chat));
            this.#clearDirty(chat.id);
        } catch (e) {
            this.#markDirty(chat.id);
        }
    }

    async saveAllChats(chats) {
        await this.localRepo.saveAllChats(chats);
        if (!this.getIsLoggedIn()) return;
        try {
            await this.backendClient.putChats(chats);
            for (const c of chats) {
                await this.localRepo.saveSnapshot(c.id, cloneChat(c));
                this.#clearDirty(c.id);
            }
        } catch (e) {
            for (const c of chats) this.#markDirty(c.id);
        }
    }

    async deleteChat(chatId) {
        await this.localRepo.deleteChat(chatId);
        try { await this.localRepo.deleteSnapshot(chatId); } catch { /* ignore */ }
        if (!this.getIsLoggedIn()) return;
        try { await this.backendClient.deleteChat(chatId); this.#clearDirty(chatId); }
        catch (e) { /* 离线删除：v1 无墓碑，重连后可能从服务端恢复（已知边界） */ }
    }

    async loadAllChats() {
        const local = await this.localRepo.loadAllChats();
        if (!this.getIsLoggedIn()) return local;

        try {
            const { chats: serverChats } = await this.backendClient.getChats();
            const server = Array.isArray(serverChats) ? serverChats : [];
            const dirty = this.#getDirty();
            const dirtyIds = new Set(Object.keys(dirty));

            let result;
            if (server.length === 0) {
                // 服务端为空：仅本地「脏」（离线未同步）数据上云；其余以服务端为空为准（可能已被清空）
                result = local.filter(c => dirtyIds.has(String(c.id)));
                for (const c of result) await this.backendClient.putChat(c.id, c);
            } else {
                // 服务端为准，叠加「本地脏」覆盖（离线改动优先，最后写入胜）
                const merged = new Map();
                for (const sc of server) {
                    const { _serverUpdatedAt, ...clean } = sc;
                    merged.set(String(clean.id), clean);
                }
                for (const c of local) {
                    if (dirtyIds.has(String(c.id))) {
                        merged.set(String(c.id), c);
                        await this.backendClient.putChat(c.id, c);
                    }
                }
                result = [...merged.values()];
            }

            await this.localRepo.saveAllChats(result);
            // 重建快照：此刻 result 与服务端一致，作为后续增量 diff 的基线
            for (const c of result) {
                try { await this.localRepo.saveSnapshot(c.id, cloneChat(c)); } catch { /* ignore */ }
            }
            this.#clearAllDirty();
            return result;
        } catch (e) {
            return local;  // 后端不可达 → 离线兜底
        }
    }
}

export default SyncedChatRepository;
