// 记忆云同步仓库：与 MemoryRepository 同接口，内部「本地 IndexedDB 缓存 + 后端写穿」双写。
//
// 与聊天记录同步（SyncedChatRepository）同源设计，但有两点关键差异：
//   1) 记忆是**逐条可变**的（DMAE 每轮改 activation / 沉默计数），所以按条同步，
//      不做整包 diff；后端按 updatedAt(ms) 做「最新写入胜出」的冲突消解。
//   2) **删除必须走墓碑**：聊天同步没有墓碑，离线删除后重连会被服务端数据覆盖回来；
//      记忆是用户手动管理的数据，被删了又复活体验很差，所以本地删除入队墓碑并上传，
//      拉取时服务端的墓碑同样会删掉本地副本。
//
// 离线兜底：所有写操作先落本地 IndexedDB，未确认的变更记在 localStorage 队列里
// （按命名空间隔离），联网后 syncNow() 重放。
//
// 不参与同步的数据：三类事件日志（提取/命中/注入）仅存本地 —— 属诊断视图，
// 单类上限 200 条且每轮都会新增，同步收益低于开销。
import Constants from '../core/constants.js';

const STORES = ['memories', 'memories_archive'];
const PULL_ONCE_PER_MS = 30 * 1000;   // 同一命名空间内的自动拉取间隔（避免频繁请求）

/** 记录的时间戳（毫秒）；缺失视为 0（优先级最低）。 */
const ts = (rec) => {
    const v = rec && rec.updatedAt;
    return Number.isFinite(v) ? v : 0;
};

const idOf = (rec) => (rec && rec.id != null ? String(rec.id) : null);

export class SyncedMemoryRepository {
    /**
     * @param {Object} deps
     * @param {Object} deps.localRepo     本地 MemoryRepository
     * @param {Object} deps.backendClient  BackendClient
     * @param {() => boolean} deps.getIsLoggedIn
     * @param {() => string} [deps.getNamespace] 命名空间（'' = 访客）
     */
    constructor({ localRepo, backendClient, getIsLoggedIn, getNamespace }) {
        this.localRepo = localRepo;
        this.backendClient = backendClient;
        this.getIsLoggedIn = getIsLoggedIn;
        this.getNamespace = getNamespace || (() => '');
        this._pushInFlight = null;
        this._pullInFlight = null;
        this._lastPullAt = 0;
    }

    // ==================== 队列（localStorage，按命名空间隔离） ====================

    #key(name) {
        const ns = this.getNamespace();
        return Constants.STORAGE_KEYS[name] + (ns ? '_' + ns : '');
    }

    #readQueue() {
        try {
            const q = JSON.parse(localStorage.getItem(this.#key('MEMORY_SYNC_PENDING')));
            return Array.isArray(q) ? q : [];
        } catch { return []; }
    }

    #writeQueue(queue) {
        try {
            if (!queue || queue.length === 0) localStorage.removeItem(this.#key('MEMORY_SYNC_PENDING'));
            else localStorage.setItem(this.#key('MEMORY_SYNC_PENDING'), JSON.stringify(queue));
        } catch { /* 配额满：忽略，本地数据仍安全 */ }
    }

    /** 入队一条写操作（同一 id 只保留最新一条，后续写入覆盖前一条）。 */
    #enqueue(op) {
        const queue = this.#readQueue();
        const idx = queue.findIndex(x => x && x.id === op.id);
        if (idx >= 0) queue[idx] = op; else queue.push(op);
        this.#writeQueue(queue);
    }

    #dequeue(ids) {
        const set = new Set((ids || []).map(String));
        this.#writeQueue(this.#readQueue().filter(op => !set.has(String(op.id))));
    }

    /** 是否有未上传的本地变更（供 UI 提示）。 */
    hasPending() {
        return this.#readQueue().length > 0;
    }

    // ==================== 写操作（本地优先 + 入队） ====================

    async saveMemory(record) {
        await this.localRepo.saveMemory(record);
        this.#enqueue({ id: String(record.id), store: 'memories', op: 'put', record });
        this.#schedulePush();
        return undefined;
    }

    async saveArchived(record) {
        await this.localRepo.saveArchived(record);
        this.#enqueue({ id: String(record.id), store: 'memories_archive', op: 'put', record });
        this.#schedulePush();
        return undefined;
    }

    async deleteMemory(id) {
        await this.localRepo.deleteMemory(id);
        this.#enqueue({ id: String(id), store: 'memories', op: 'del' });
        this.#schedulePush();
        return undefined;
    }

    async deleteArchived(id) {
        await this.localRepo.deleteArchived(id);
        this.#enqueue({ id: String(id), store: 'memories_archive', op: 'del' });
        this.#schedulePush();
        return undefined;
    }

    /**
     * 删除一条记忆（兼容调用方不知道它在热层还是归档）：
     * 本地两个 store 都删一遍，并上传一次删除墓碑。
     */
    async deleteMemoryById(id) {
        const removed = [];
        for (const store of ['memories', 'memories_archive']) {
            const rec = await this.#getLocal(store, id);
            if (rec) removed.push(store);
        }
        await this.localRepo.deleteMemory(id);
        await this.localRepo.deleteArchived(id);
        this.#enqueue({ id: String(id), store: 'memories', op: 'del' });
        this.#schedulePush();
        return removed;
    }

    async #getLocal(store, id) {
        try {
            const records = store === 'memories'
                ? await this.localRepo.loadAllMemories()
                : await this.localRepo.loadArchived();
            return (records || []).find(r => idOf(r) === String(id)) || null;
        } catch { return null; }
    }

    /** 删除某对话（角色）的全部记忆（本地 + 云端级联）。 */
    async deleteMemoriesByChatId(chatId) {
        await this.localRepo.deleteMemoriesByChatId(chatId);
        const cid = String(chatId);
        // 队列里该角色尚未上传的写入一并作废（避免离线删除后又被补传复活）
        const queue = this.#readQueue().filter(op => {
            if (op.store === 'del-chat') return true;
            const rec = op.record;
            if (rec && rec.chatId != null && String(rec.chatId) === cid) return false;
            return true;
        });
        this.#writeQueue(queue);
        this.#enqueue({ id: `chat:${cid}`, store: 'del-chat', op: 'del', chatId: cid });
        this.#schedulePush();
    }

    // ==================== 读操作 ====================

    async loadAllMemories() {
        await this.#maybePull();
        return this.localRepo.loadAllMemories();
    }

    async loadArchived() {
        await this.#maybePull();
        return this.localRepo.loadArchived();
    }

    async loadMemoriesForChat(chatId) {
        await this.#maybePull();
        return this.localRepo.loadMemoriesForChat(chatId);
    }

    async loadArchivedForChat(chatId) {
        await this.#maybePull();
        return this.localRepo.loadArchivedForChat(chatId);
    }

    // —— 事件日志：仅本地，纯委托 ——
    addEvent(record) { return this.localRepo.addEvent(record); }
    loadEvents(kind, limit) { return this.localRepo.loadEvents(kind, limit); }
    clearEvents() { return this.localRepo.clearEvents(); }

    /** 访客库记忆认领（跨库复制，同步层透明转发）。 */
    copyStoresFrom(sourceDbName) { return this.localRepo.copyStoresFrom(sourceDbName); }

    /** 清空本地记忆数据（切换账号命名空间时调用；云端与未上传队列不受影响）。 */
    clearMemoryStores() { return this.localRepo.clearMemoryStores(); }

    /** 暴露底层仓库（调试用）。 */
    getLocalRepo() { return this.localRepo; }

    /** 队列长度（调试用）。 */
    pendingCount() { return this.#readQueue().length; }

    // ==================== 同步调度 ====================

    #schedulePush() {
        if (!this.getIsLoggedIn()) return;
        // 延迟合并：一轮对话会连续写多条记忆，攒 1.2s 后一次性批量上传
        clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => {
            this.push().catch(() => { /* 失败留在队列里，下次重试 */ });
        }, 1200);
    }

    #maybePull() {
        if (!this.getIsLoggedIn()) return Promise.resolve();
        if (Date.now() - this._lastPullAt < PULL_ONCE_PER_MS) return Promise.resolve();
        return this.pull().catch(() => { /* 后端不可达 → 用本地缓存 */ });
    }

    /** 登录/切库后调用：立刻双向同步一次（拉取 + 重放本地队列）。 */
    async syncNow() {
        if (!this.getIsLoggedIn()) return { skipped: true };
        const pulled = await this.pull().catch(() => null);
        const pushed = await this.push().catch(() => null);
        return { pulled, pushed };
    }

    /** 切换命名空间后重置节流状态（避免拿旧命名空间的计时）。 */
    resetThrottle() { this._lastPullAt = 0; }

    /** 上传本地未确认的变更（离线补传 / 删除墓碑）。 */
    async push() {
        if (!this.getIsLoggedIn()) return { accepted: 0, skippedNoBackend: true };
        if (this._pushInFlight) return this._pushInFlight;
        this._pushInFlight = (async () => {
            const queue = this.#readQueue();
            if (queue.length === 0) return { accepted: 0 };
            let accepted = 0;

            // 1) 按角色整域删除
            for (const op of queue.filter(o => o.store === 'del-chat')) {
                await this.backendClient.deleteMemoriesByChat(op.chatId);
                this.#dequeue([op.id]);
                accepted++;
            }
            // 2) 单条删除（批量合并成一次请求）
            const delIds = queue.filter(o => o.op === 'del' && o.store !== 'del-chat').map(o => o.id);
            if (delIds.length > 0) {
                await this.backendClient.deleteMemoriesBulk(delIds);
                this.#dequeue(delIds);
                accepted += delIds.length;
            }
            // 3) 批量 upsert（按 updatedAt 最新胜出，重复上传幂等）
            const puts = queue.filter(o => o.op === 'put' && o.record);
            if (puts.length > 0) {
                const records = [];
                const sentIds = [];
                for (const op of puts) {
                    if (sentIds.length >= 500) break;   // 后端单批上限
                    records.push(op.record);
                    sentIds.push(op.id);
                }
                if (records.length > 0) {
                    await this.backendClient.putMemories(records);
                    this.#dequeue(sentIds);
                    accepted += records.length;
                }
            }
            return { accepted };
        })();
        try {
            return await this._pushInFlight;
        } finally {
            this._pushInFlight = null;
        }
    }

    /**
     * 拉取服务端记忆并做三方合并（纯计算 → 再落盘，避免中途读取造成竞态）：
     *   服务端记录 vs 本地记录 → 取 updatedAt 新的一方
     *   本地待上传的写入 → 优先保留，随后由 push 上传
     *   服务端墓碑且比本地更新 → 本地删除（本地更晚的写入则胜出，由 push 重新上传）
     *   本地有而服务端没有 → 保留（尚未上传 / 服务端已被清）
     */
    async pull() {
        if (!this.getIsLoggedIn()) return { skipped: true };
        if (this._pullInFlight) return this._pullInFlight;
        this._pullInFlight = (async () => {
            const { memories: serverMemories, tombstones } = await this.backendClient.getMemories();
            const server = Array.isArray(serverMemories) ? serverMemories : [];
            const dead = Array.isArray(tombstones) ? tombstones : [];

            const [localMem, localArch] = await Promise.all([
                this.localRepo.loadAllMemories(),
                this.localRepo.loadArchived(),
            ]);
            const localById = new Map();
            for (const r of [...(localMem || []), ...(localArch || [])]) {
                const k = idOf(r);
                if (k) localById.set(k, r);
            }

            // 待上传的本地写入：合并时应当「压过」服务端旧值
            const pending = new Map();
            for (const op of this.#readQueue()) {
                if (op.op === 'put' && op.record) pending.set(String(op.id), op.record);
            }

            const tombById = new Map();
            for (const t of dead) {
                const k = String((t && t.id) || '');
                if (k) tombById.set(k, Number(t.updatedAt) || 0);
            }

            // —— 计算「删除集合」：墓碑更新，或本地根本没有这条记录 ——
            const toDelete = new Set();
            const writeById = new Map();
            for (const [k, win] of Object.entries(this.#resolveWinners(server, localById, pending))) {
                const tombTs = tombById.has(k) ? tombById.get(k) : null;
                if (tombTs !== null && ts(win.record) <= tombTs) { toDelete.add(k); continue; }
                writeById.set(k, win);
            }

            let updated = 0, added = 0, removed = 0;
            for (const [k, win] of writeById) {
                const store = win.record.state === 'archived' ? 'memories_archive' : 'memories';
                if (!win.local) added++;
                else if (ts(win.record) > ts(win.local)) updated++;
                if (store === 'memories_archive') await this.localRepo.saveArchived(win.record);
                else await this.localRepo.saveMemory(win.record);
            }
            for (const k of toDelete) {
                if (!localById.has(k)) continue;      // 本地本来就没有，不必写
                await this.localRepo.deleteMemory(k);
                await this.localRepo.deleteArchived(k);
                removed++;
            }

            this._lastPullAt = Date.now();
            return { total: server.length, added, updated, removed, tombstones: dead.length };
        })();
        try {
            return await this._pullInFlight;
        } finally {
            this._pullInFlight = null;
        }
    }

    /**
     * 逐 id 决定「谁赢」：待上传 > (服务端/本地中 updatedAt 更新的一方) > 本地独有。
     * @returns {Object<string, {record:Object, local:Object|null}>}
     */
    #resolveWinners(server, localById, pending) {
        const winners = {};
        const seen = new Set();

        // 先按 id 去重服务端记录（防御后端重复返回）
        const serverById = new Map();
        for (const rec of server) {
            const k = idOf(rec);
            if (!k) continue;
            const prev = serverById.get(k);
            if (!prev || ts(rec) > ts(prev)) serverById.set(k, rec);
        }

        for (const [k, raw] of serverById) {
            seen.add(k);
            const clean = { ...raw };
            delete clean._serverUpdatedAt;   // 服务端元信息不落本地
            const local = localById.get(k) || null;
            const pend = pending.get(k);
            if (pend) { winners[k] = { record: pend, local }; continue; }
            if (local && ts(local) >= ts(clean)) { winners[k] = { record: local, local }; continue; }
            winners[k] = { record: clean, local };
        }
        for (const [k, local] of localById) {
            if (seen.has(k)) continue;
            seen.add(k);
            const pend = pending.get(k);
            winners[k] = { record: pend || local, local };
        }
        return winners;
    }
}

export default SyncedMemoryRepository;
