// 云同步仓库：与 ChatRepository 同接口，内部「本地 IndexedDB 缓存 + 后端写穿」双写。
//
// 存储模型（本地 = base64，后端 = asset://）：
//   - 本地 IndexedDB 始终保存 base64（图片数据），离线/后端异常时也能正常显示；
//   - 发送到后端前，把 data: 图片上传成 asset:// 引用（后端 MySQL 只存短引用）；
//   - 从后端拉取时，本地已有 base64 的优先保留；缺失的 asset:// 拉取一次转回 base64。
// saveChat 走「话题级增量」PATCH（首次全量 PUT），saveAllChats / 离线补传走全量替换。
import { diffChat, cloneChat } from './chat-diff.js';
import { uploadDataUrl, resolveToDataUrl } from './asset-sync.js';

const isDataUri = (v) => typeof v === 'string' && v.startsWith('data:');
const isAssetRef = (v) => typeof v === 'string' && v.startsWith('asset://');

/** 递归：data: → asset://（上传到后端文件系统）。返回新结构（无变更时尽量复用原引用）。 */
async function toAssetRefs(value) {
    if (Array.isArray(value)) {
        let changed = false;
        const out = [];
        for (const v of value) {
            const nv = await toAssetRefs(v);
            if (nv !== v) changed = true;
            out.push(nv);
        }
        return changed ? out : value;
    }
    if (value && typeof value === 'object') {
        let changed = false;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const nv = await toAssetRefs(v);
            if (nv !== v) changed = true;
            out[k] = nv;
        }
        return changed ? out : value;
    }
    if (isDataUri(value)) return uploadDataUrl(value);
    return value;
}

/** 递归：asset:// → data:（从后端拉取，用于恢复本地 base64）。 */
async function toDataUris(value) {
    if (Array.isArray(value)) {
        let changed = false;
        const out = [];
        for (const v of value) {
            const nv = await toDataUris(v);
            if (nv !== v) changed = true;
            out.push(nv);
        }
        return changed ? out : value;
    }
    if (value && typeof value === 'object') {
        let changed = false;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const nv = await toDataUris(v);
            if (nv !== v) changed = true;
            out[k] = nv;
        }
        return changed ? out : value;
    }
    if (isAssetRef(value)) return resolveToDataUrl(value);
    return value;
}

/** 合并：以服务端为准，但图片字段优先保留本地 base64（离线可用）。 */
function preferLocalImages(serverChat, localChat) {
    if (!localChat) return serverChat;
    const result = JSON.parse(JSON.stringify(serverChat));

    const ls = localChat.settings;
    if (ls) {
        const rs = result.settings || (result.settings = {});
        for (const k of ['avatarUrl', 'bgImageUrl', 'bgUrl']) {
            if (isDataUri(ls[k])) rs[k] = ls[k];
        }
    }

    const localMsgs = new Map();
    for (const t of (localChat.topics || [])) {
        for (const m of (t.messages || [])) {
            if (m && m.uid != null) localMsgs.set(String(m.uid), m);
        }
    }
    for (const t of (result.topics || [])) {
        for (const m of (t.messages || [])) {
            if (!m || m.uid == null) continue;
            const lm = localMsgs.get(String(m.uid));
            if (!lm) continue;
            if (lm.isImage && isDataUri(lm.text)) m.text = lm.text;
            if (Array.isArray(lm.images) && lm.images.some(im => im && (isDataUri(im.dataUrl) || isDataUri(im.fullDataUrl)))) {
                m.images = lm.images;
            }
            if (lm.quoteRef && Array.isArray(lm.quoteRef.imageUrls) && lm.quoteRef.imageUrls.some(isDataUri)) {
                if (!m.quoteRef) m.quoteRef = {};
                m.quoteRef.imageUrls = lm.quoteRef.imageUrls;
            }
            if (lm.file && isDataUri(lm.file.content)) m.file = lm.file;
        }
    }
    return result;
}

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
        await this.localRepo.saveChat(chat);   // 本地存 base64
        if (!this.getIsLoggedIn()) return;
        try {
            const snapshot = await this.localRepo.getSnapshot(chat.id);
            const patch = diffChat(snapshot, chat);
            if (patch.isNew) {
                await this.backendClient.putChat(chat.id, await toAssetRefs(chat));   // 首次：全量（base64→asset://）
            } else if (patch.hasChanges) {
                await this.backendClient.patchChat(chat.id, {
                    meta: await toAssetRefs(patch.meta),
                    topics: await toAssetRefs(patch.topics),
                    removeTopicIds: patch.removeTopicIds,
                });
            }
            await this.localRepo.saveSnapshot(chat.id, cloneChat(chat));   // 快照保持 base64
            this.#clearDirty(chat.id);
        } catch (e) {
            this.#markDirty(chat.id);
        }
    }

    async saveAllChats(chats) {
        await this.localRepo.saveAllChats(chats);   // 本地存 base64
        if (!this.getIsLoggedIn()) return;
        try {
            await this.backendClient.putChats(await toAssetRefs(chats));
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
                // 服务端为空：仅本地「脏」数据上云
                result = local.filter(c => dirtyIds.has(String(c.id)));
                for (const c of result) await this.backendClient.putChat(c.id, await toAssetRefs(c));
            } else {
                const localById = new Map(local.map(c => [String(c.id), c]));
                const merged = new Map();
                for (const sc of server) {
                    const { _serverUpdatedAt, ...clean } = sc;
                    const lc = localById.get(String(clean.id));
                    merged.set(String(clean.id), preferLocalImages(clean, lc));   // 本地 base64 优先
                }
                for (const c of local) {
                    if (dirtyIds.has(String(c.id))) {
                        merged.set(String(c.id), c);   // 脏本地整包覆盖（base64）
                        await this.backendClient.putChat(c.id, await toAssetRefs(c));
                    }
                }
                result = [...merged.values()];
            }

            // 缺失的 asset:// 拉取一次转回 base64（恢复迁移数据 / 其它设备图片）；本地已有 base64 的不动
            result = await Promise.all(result.map(c => toDataUris(c)));
            await this.localRepo.saveAllChats(result);
            this.#clearAllDirty();
            return result;
        } catch (e) {
            return local;   // 后端不可达 → 直接用本地 base64（离线兜底）
        }
    }
}

export default SyncedChatRepository;
