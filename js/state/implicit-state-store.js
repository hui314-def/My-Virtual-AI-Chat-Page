// 内隐状态仓库（AI 人格深度）
// ------------------------------------------------------------
// 数据位置：**话题级** topic.implicitState（值）+ 角色级 chat.implicitStateDefs（字段定义）
// 职责：
//   - 读写当前话题的状态、按内置默认值惰性初始化（新话题从默认值开始）
//   - 应用模型返回的补丁（只改返回的字段；未返回的保持不变）
//   - 快照环形历史、重置、锁定、自定义字段硬删除（含级联清理）
//   - 落库：本地立即写（IndexedDB），云端走防抖（话题级 diff 是整话题上传）
// 本文件不依赖 DOM。
import Constants from '../core/constants.js';
import {
    getEffectiveDefs, createInitialState, applyPatch, clampNumber,
    snapshotFields, renderInjectionBlock,
} from './state-schema.js';

export class ImplicitStateStore {
    /**
     * @param {Object} deps
     * @param {() => Array} deps.getChats
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => number|null} deps.getCurrentTopicIndex
     * @param {Object} [deps.localRepo]  本地 ChatRepository（立即落库，保证不丢数据）
     * @param {Object} [deps.syncedRepo] 云端 SyncedChatRepository（防抖落库，避免重复整包上传）
     * @param {() => number} [deps.getMaxChars] 注入块字数上限（默认取常量/设置）
     * @param {(kind:string, detail:Object) => void} [deps.onEvent] 状态事件回调（用于写 memory_events 日志）
     */
    constructor({ getChats, getCurrentChatId, getCurrentTopicIndex, localRepo = null, syncedRepo = null, getMaxChars = null, onEvent = null }) {
        this.getChats = getChats;
        this.getCurrentChatId = getCurrentChatId;
        this.getCurrentTopicIndex = getCurrentTopicIndex;
        this.localRepo = localRepo;
        this.syncedRepo = syncedRepo || localRepo;
        this.getMaxChars = getMaxChars;
        this.onEvent = onEvent;
        this._saveTimers = new Map();   // chatId -> timeoutId（云端防抖）
    }

    /** 发一条状态事件（失败静默：日志不该影响主流程） */
    #emit(kind, detail) {
        if (typeof this.onEvent !== 'function') return;
        try { this.onEvent(kind, detail || {}); } catch (err) { console.warn('[ImplicitState] 事件回调失败：', err); }
    }

    get chats() { return this.getChats(); }

    /** 当前角色 */
    get chat() {
        const id = this.getCurrentChatId();
        return (this.chats || []).find(c => c.id == id) || null;
    }

    /** 当前话题（chat.currentTopicIndex 指向的话题；为 null 时视为"显示全部话题"） */
    getTopic(chat = this.chat) {
        if (!chat || !Array.isArray(chat.topics)) return null;
        const idx = (typeof this.getCurrentTopicIndex === 'function')
            ? this.getCurrentTopicIndex()
            : chat.currentTopicIndex;
        if (idx === null || idx === undefined || idx < 0 || idx >= chat.topics.length) return null;
        return chat.topics[idx];
    }

    /** 本对话是否启用内隐状态（对话设置里的总开关，默认关闭） */
    isEnabled(chat = this.chat) {
        return !!(chat && chat.settings && chat.settings.implicitStateEnabled === true);
    }

    /** 角色生效的字段定义（内置 + 自定义） */
    getDefs(chat = this.chat) {
        return getEffectiveDefs(chat);
    }

    /** 按内置默认值生成一份初始状态（新话题用；未启用时返回 null，不污染话题对象） */
    buildInitialStateFor(chat) {
        if (!this.isEnabled(chat)) return null;
        return createInitialState(getEffectiveDefs(chat));
    }

    /** 确保话题有状态对象（惰性初始化：旧对话/旧导入文件无需迁移） */
    ensureState(topic = this.getTopic(), chat = this.chat) {
        if (!topic) return null;
        if (!topic.implicitState || !topic.implicitState.fields) {
            topic.implicitState = createInitialState(getEffectiveDefs(chat));
        }
        return topic.implicitState;
    }

    /**
     * 取当前话题状态（不初始化）。
     * @param {{create?:boolean}} [opts] create=true 时惰性初始化
     */
    getState(opts = {}) {
        const topic = this.getTopic();
        if (!topic) return null;
        return opts.create ? this.ensureState(topic) : (topic.implicitState || null);
    }

    /**
     * 应用模型返回的补丁（只改返回的字段），并落库。
     * @param {Object} patch 模型返回的 JSON（可能是包装过的，调用方先解包）
     * @param {{source?:'ai'|'manual', chat?:Object, topic?:Object}} [opts]
     *        chat/topic 可显式指定：结算可能在聊天中途完成（例如用户已切到别的角色），
     *        必须写回**发起时**的那个话题，否则会把状态写到错误的角色上。
     * @returns {{changed:boolean, changes:Array, reasonSummary:string}}
     */
    applyPatch(patch, opts = {}) {
        const chat = opts.chat || this.chat;
        const topic = opts.topic || this.getTopic(chat);
        const empty = { changed: false, changes: [], reasonSummary: '' };
        if (!chat || !topic) return empty;
        const state = this.ensureState(topic, chat);
        const defs = getEffectiveDefs(chat);
        const result = applyPatch(state, patch, defs);
        const prevTurn = Number(state.turn) || 0;
        state.turn = prevTurn + 1;
        state.updatedAt = Date.now();
        if (result.changed) {
            const snap = snapshotFields(state, defs);
            state.history = Array.isArray(state.history) ? state.history : [];
            state.history.push({
                t: state.updatedAt,
                turn: state.turn,
                snapshot: snap,
                reason: result.reasonSummary || (result.changes[0] && result.changes[0].reason) || '',
                source: opts.source || 'ai',
            });
            const max = Constants.IMPLICIT_STATE_HISTORY_MAX;
            if (state.history.length > max) state.history = state.history.slice(-max);
        }
        this.writeState(chat);
        if (result.changed) {
            this.#emit('change', {
                chatId: chat.id, topicId: topic.id, turn: state.turn, source: opts.source || 'ai',
                changes: result.changes, reason: result.reasonSummary,
            });
        }
        return result;
    }

    /**
     * 回滚到某条历史快照（只恢复快照里出现过的字段；数值不受 ±10 限制）。
     * @param {number} index state.history 的下标
     * @returns {boolean} 是否成功
     */
    rollbackToHistory(index) {
        const chat = this.chat;
        const topic = this.getTopic(chat);
        if (!chat || !topic) return false;
        const state = this.ensureState(topic, chat);
        const history = Array.isArray(state.history) ? state.history : [];
        const entry = history[index];
        if (!entry || !entry.snapshot) return false;
        const defs = getEffectiveDefs(chat);
        let restored = 0;
        for (const [key, val] of Object.entries(entry.snapshot)) {
            const def = defs.find(d => d.key === key);
            if (!def) continue;
            const f = state.fields[key] || (state.fields[key] = { value: def.default, updatedAt: Date.now() });
            if (def.type === 'tags') {
                f.value = String(val == null ? '' : val).split(/[、,，]/).map(s => s.trim()).filter(Boolean);
            } else if (def.type === 'number') {
                f.value = clampNumber(val, def.min, def.max, Number(f.value) || def.min);
            } else {
                f.value = val;
            }
            f.updatedAt = Date.now();
            restored++;
        }
        if (restored === 0) return false;
        state.turn = (Number(state.turn) || 0) + 1;
        state.updatedAt = Date.now();
        state.history.push({
            t: state.updatedAt, turn: state.turn, snapshot: snapshotFields(state, defs),
            reason: `回滚到第 ${entry.turn ?? index + 1} 轮`, source: 'manual',
        });
        if (state.history.length > Constants.IMPLICIT_STATE_HISTORY_MAX) {
            state.history = state.history.slice(-Constants.IMPLICIT_STATE_HISTORY_MAX);
        }
        this.writeState(chat);
        this.#emit('rollback', { chatId: chat.id, topicId: topic.id, toTurn: entry.turn ?? index + 1 });
        return true;
    }

    /** 手动设置某个字段的值（用户在悬浮卡片 / 对话设置里直接改） */
    setFieldValue(key, value, opts = {}) {
        const chat = opts.chat || this.chat;
        const topic = opts.topic || this.getTopic(chat);
        if (!chat || !topic) return false;
        const state = this.ensureState(topic, chat);
        const defs = getEffectiveDefs(chat);
        const def = defs.find(d => d.key === key);
        if (!def) return false;
        // 手动修改不受「单次 ±10 限幅」约束：走一次不受限的直接写入，再记录快照
        const changes = this.#applyManual(state, def, value);
        if (!changes) return false;
        state.turn = (Number(state.turn) || 0) + 1;
        state.updatedAt = Date.now();
        state.history = Array.isArray(state.history) ? state.history : [];
        state.history.push({
            t: state.updatedAt, turn: state.turn, snapshot: snapshotFields(state, defs),
            reason: '手动调整', source: 'manual',
        });
        if (state.history.length > Constants.IMPLICIT_STATE_HISTORY_MAX) {
            state.history = state.history.slice(-Constants.IMPLICIT_STATE_HISTORY_MAX);
        }
        this.writeState(chat);
        if (typeof opts.onChanged === 'function') opts.onChanged(changes);
        this.#emit('manual', { chatId: chat.id, topicId: topic.id, key, value, source: 'manual' });
        return true;
    }

    /** 手动写入（不受限幅约束；类型校验仍然执行） */
    #applyManual(state, def, value) {
        const cur = state.fields[def.key] || (state.fields[def.key] = { value: def.default, updatedAt: Date.now() });
        // 快照旧值：枚举要连 emoji / intensity 一起比较，只改 emoji 也算变化
        const before = { value: cur.value, emoji: cur.emoji, intensity: cur.intensity };
        if (def.type === 'number') {
            const n = Number(value);
            if (!Number.isFinite(n)) return null;
            cur.value = Math.min(def.max, Math.max(def.min, n));
        } else if (def.type === 'enum') {
            // 两种入参：字符串（只改值）或 { value, emoji, intensity }（情绪这类带 emoji/强度的字段）
            const patch = (value && typeof value === 'object') ? value : { value };
            const v = String(patch.value == null ? cur.value : patch.value).trim();
            if (!v) return null;
            // 固定选项的枚举必须命中；freeform（情绪）允许用户自填任意词
            if (def.options && def.options.length && !def.freeform && !def.options.includes(v)) return null;
            cur.value = v;
            if (patch.emoji !== undefined) cur.emoji = String(patch.emoji).slice(0, 4);
            if (patch.intensity !== undefined && Number.isFinite(Number(patch.intensity))) {
                cur.intensity = Math.min(10, Math.max(1, Math.round(Number(patch.intensity))));
            }
        } else if (def.type === 'text') {
            cur.value = String(value == null ? '' : value).slice(0, def.maxLen || Constants.IMPLICIT_STATE_TEXT_MAXLEN);
        } else {
            cur.value = Array.isArray(value) ? value.map(String).slice(0, def.maxItems || 12) : [String(value)];
        }
        const after = { value: cur.value, emoji: cur.emoji, intensity: cur.intensity };
        if (JSON.stringify(before) === JSON.stringify(after)) return null;
        cur.updatedAt = Date.now();
        cur.lastReason = '手动调整';
        cur.turn = (Number(state.turn) || 0) + 1;
        return { key: def.key, label: def.label, type: def.type, from: before.value, to: cur.value, manual: true };
    }

    /** 锁定 / 解锁某字段（锁定后 AI 不得修改） */
    setLocked(key, locked, opts = {}) {
        const chat = opts.chat || this.chat;
        const topic = opts.topic || this.getTopic(chat);
        if (!chat || !topic) return false;
        const state = this.ensureState(topic, chat);
        const f = state.fields[key];
        if (!f) return false;
        f.locked = !!locked;
        this.writeState(chat);
        return true;
    }

    /** 重置当前话题状态为内置默认值（用户手动触发） */
    resetCurrent() {
        const chat = this.chat;
        const topic = this.getTopic(chat);
        if (!chat || !topic) return false;
        topic.implicitState = createInitialState(getDefsOrEmpty(chat));
        this.writeState(chat);
        this.#emit('reset', { chatId: chat.id, topicId: topic.id });
        return true;
    }

    /**
     * 硬删除一个自定义字段：定义 + 所有话题的值 + 所有话题历史快照里的该键，全部清除。
     * @param {string} key
     * @returns {{removed:boolean, topics:number}}
     */
    deleteCustomField(key, chat = this.chat) {
        if (!chat || !key) return { removed: false, topics: 0 };
        const meta = chat.implicitStateDefs || (chat.implicitStateDefs = { version: 1, disabledBuiltins: [], overrides: {}, customDefs: [] });
        const before = Array.isArray(meta.customDefs) ? meta.customDefs.length : 0;
        meta.customDefs = (Array.isArray(meta.customDefs) ? meta.customDefs : []).filter(d => d && d.key !== key);
        let touchedTopics = 0;
        for (const topic of (chat.topics || [])) {
            const st = topic.implicitState;
            if (!st) continue;
            let touched = false;
            if (st.fields && Object.prototype.hasOwnProperty.call(st.fields, key)) {
                delete st.fields[key];
                touched = true;
            }
            if (Array.isArray(st.history)) {
                for (const snap of st.history) {
                    if (snap && snap.snapshot && Object.prototype.hasOwnProperty.call(snap.snapshot, key)) {
                        delete snap.snapshot[key];
                        touched = true;
                    }
                }
            }
            if (touched) touchedTopics++;
        }
        meta.updatedAt = Date.now();
        const removed = meta.customDefs.length !== before;
        if (removed || touchedTopics > 0) this.writeState(chat, { immediateCloud: true });
        this.#emit('delete-field', { chatId: chat.id, key, removed, topics: touchedTopics });
        return { removed, topics: touchedTopics };
    }

    /** 渲染当前话题的【内隐状态】注入块（无内容时返回 ''） */
    renderBlock() {
        const chat = this.chat;
        // create=true：首次启用、状态还没结算过时，先按默认值补齐（让第一轮回复就知道她的基线状态）
        const state = this.getState({ create: true });
        if (!chat || !state) return '';
        const maxChars = (typeof this.getMaxChars === 'function' && this.getMaxChars()) || Constants.IMPLICIT_STATE_BLOCK_MAX_CHARS;
        return renderInjectionBlock(state, getEffectiveDefs(chat), { maxChars });
    }

    // ==================== 落库 ====================

    /**
     * 写回状态：本地立即落库（保证刷新/关页不丢），云端防抖（合并同一话题的连续 patch）。
     * @param {Object} chat
     * @param {{immediateCloud?:boolean}} [opts]
     */
    writeState(chat) {
        if (!chat) return;
        // 1) 本地立即写（纯 IndexedDB，不发网络请求）
        if (this.localRepo && typeof this.localRepo.saveChat === 'function') {
            Promise.resolve(this.localRepo.saveChat(chat)).catch(err => {
                console.warn('[ImplicitState] 本地保存失败：', err);
            });
        }
        // 2) 云端防抖写（SyncedChatRepository：话题级 diff，避免与消息落库重复整包上传）
        this.saveDebounced(chat);
    }

    /** 云端防抖保存（默认 2s 内的多次调用合并为一次） */
    saveDebounced(chat) {
        if (!chat || !this.syncedRepo || typeof this.syncedRepo.saveChat !== 'function') return;
        const id = String(chat.id);
        const prev = this._saveTimers.get(id);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
            this._saveTimers.delete(id);
            Promise.resolve(this.syncedRepo.saveChat(chat)).catch(err => {
                console.warn('[ImplicitState] 云端保存失败（已本地留存，重连后随脏标记补传）：', err);
            });
        }, Constants.IMPLICIT_STATE_SAVE_DEBOUNCE_MS);
        this._saveTimers.set(id, timer);
    }

    /** 立即冲刷某对话的待保存（切换对话/关闭页面前调用更稳） */
    flush(chat = this.chat) {
        if (!chat) return;
        const id = String(chat.id);
        const timer = this._saveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this._saveTimers.delete(id);
            if (this.syncedRepo && typeof this.syncedRepo.saveChat === 'function') {
                Promise.resolve(this.syncedRepo.saveChat(chat)).catch(() => {});
            }
        }
    }
}

/** 安全取字段定义（resetCurrent 用；chat 不存在时给内置定义） */
function getDefsOrEmpty(chat) {
    return getEffectiveDefs(chat || {});
}

export default ImplicitStateStore;
