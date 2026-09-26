// ============================================================
// QQ 接入 · 桥接客户端
// ------------------------------------------------------------
// 职责：
//   1. 把网页侧「已解析好的配置」推送给常驻的 QQ 桥接服务（默认 :5052）
//   2. 读取运行状态（协议端是否在线、是否就绪、最近日志）
//
// 为什么必须推送：QQ 桥接服务是后端常驻进程，**读不到浏览器的 localStorage**。
// 所以配置以 localStorage 为主、由本模块推一份到后端做常驻镜像；
// 后端重启后即使浏览器没打开，也能用上一次推过去的那份继续工作。
// ============================================================

import Constants from '../core/constants.js';
import { ROLE_LEVEL_KEYS, pick } from '../group/group-core.js';

/** 默认桥接服务地址（可用 localStorage 覆盖，便于换机/换端口） */
const STORAGE_KEY = 'qq_bridge_config';
const DEFAULT_API_BASE = 'http://127.0.0.1:5052';

/**
 * 本模块写入的配置结构（存 localStorage，键 qq_bridge_config）：
 * {
 *   enabled, sourceChatId, knowledgeEnabled, knowledgeIds[], ttsEnabled,
 *   trigger: {...}, lastPushAt
 * }
 */

export class QQBridgeClient {
    /**
     * @param {Object} deps
     * @param {Object} deps.settingsManager      读全局模型 / 服务地址设置
     * @param {() => Array} deps.getChats        取内存里的会话列表
     * @param {Object} deps.chatRepo             按需从 IndexedDB 读完整会话
     * @param {Object} deps.modalManager         读知识库列表（kbManager）
     * @param {() => string} deps.getDbName       当前 IndexedDB 库名（仅用于排错展示）
     */
    constructor({ settingsManager, getChats, chatRepo, modalManager, getDbName }) {
        this.settingsManager = settingsManager;
        this.getChats = getChats;
        this.chatRepo = chatRepo;
        this.modalManager = modalManager;
        this.getDbName = getDbName || (() => '');
        this._lastPushOk = null;
        this._lastPushError = '';
    }

    // ---------- 本地配置读写 ----------

    get apiBase() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object' && parsed.apiBase) return String(parsed.apiBase).replace(/\/+$/, '');
        } catch (err) { /* 落到默认地址 */ }
        return DEFAULT_API_BASE;
    }

    /** 读本模块自己的配置（与 global_settings 分开存，避免污染全局设置） */
    readConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (err) {
            console.warn('[QQ] 本地配置解析失败，使用默认值：', err);
        }
        return {};
    }

    /** 写本模块配置（保留 apiBase 等既有字段） */
    writeConfig(patch) {
        const next = { ...this.readConfig(), ...(patch || {}) };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            return true;
        } catch (err) {
            console.error('[QQ] 配置写入失败：', err);
            return false;
        }
    }

    // ---------- 角色解析（对齐 ROLE_LEVEL_KEYS 的继承语义）----------

    /**
     * 把选中会话的角色级参数解析成一份**可直接使用**的快照。
     *
     * 这里刻意复用 group-core 的 ROLE_LEVEL_KEYS / pick，而不是自己列字段：
     * 网页群聊（多智能体）用的就是这套"角色级参数"边界，
     * QQ 接入继承同一套边界，将来新增角色字段时两边不会走偏。
     *
     * @returns {Promise<Object|null>} 找不到会话时返回 null
     */
    async resolveRole(sourceChatId) {
        if (sourceChatId === null || sourceChatId === undefined || sourceChatId === '') return null;

        // 先看内存里的列表（拿到标题、是否群聊），再按需从 IndexedDB 取完整会话
        const chats = this.getChats() || [];
        let chat = chats.find(c => String(c.id) === String(sourceChatId));
        if (!chat && this.chatRepo) {
            // 注意：仓库只提供了 loadAllChats()，没有单个查询接口，
            // 这里按 id 过滤出目标会话即可（会话数量在本地场景下很小，代价可忽略）。
            try {
                const all = await this.chatRepo.loadAllChats();
                chat = (all || []).find(c => String(c.id) === String(sourceChatId));
            } catch (err) {
                console.warn('[QQ] 从 IndexedDB 读取会话失败：', err);
            }
        }
        if (!chat) return null;

        const settings = { ...Constants.DEFAULT_SETTINGS, ...(chat.settings || {}) };
        const role = pick(settings, ROLE_LEVEL_KEYS);

        // 角色名兜底：只读会话也要能被识别
        if (!String(role.roleName || '').trim()) {
            role.roleName = (settings.roleName || chat.title || '').trim();
        }

        // 头像只在是 http(s) 且非 data: 时才推给后端（用于日志展示；图片生成不在第一版范围）
        const avatar = role.avatarUrl || '';
        if (!/^https?:\/\//i.test(avatar)) delete role.avatarUrl;

        return {
            chatId: chat.id,
            chatTitle: chat.title || '',
            isGroupChat: chat.kind === 'group',
            role,
        };
    }

    // ---------- 构建推送载荷 ----------

    /**
     * 组装完整配置快照。网页每次推送都推**整包**，后端不做增量合并的猜测。
     * @returns {Promise<Object>} 载荷；角色找不到时 role 为空对象
     */
    async buildPayload() {
        const cfg = this.readConfig();
        const sm = this.settingsManager;

        const modelHost = (sm.getModelHost() || '').replace(/\/+$/, '');
        const lowered = modelHost.toLowerCase();
        const kind = (lowered.includes(':11434') || lowered.includes('/api/chat')) ? 'ollama' : 'openai';

        const resolved = await this.resolveRole(cfg.sourceChatId);

        // 知识库地址与网页保持一致（同一个 Chroma 服务，无需重灌）
        let kbApiBase = Constants.DEFAULT_KNOWLEDGE_API_URL || 'http://localhost:5051';
        try {
            kbApiBase = localStorage.getItem(Constants.STORAGE_KEYS.KB_API_BASE) || kbApiBase;
        } catch (err) { /* 用默认 */ }

        return {
            version: 1,
            enabled: !!cfg.enabled,
            sourceChatId: cfg.sourceChatId ?? null,
            sourceChatTitle: (resolved && resolved.chatTitle) || '',
            sourceDbName: this.getDbName() || '',
            role: (resolved && resolved.role) || {},
            model: {
                modelHost,
                apiKey: sm.getApiKey() || '',
                modelName: sm.getModelName() || '',
                kind,
            },
            user: {
                name: sm.getUsername() || '',
                bio: sm.getBio() || '',
            },
            knowledge: {
                enabled: !!cfg.knowledgeEnabled,
                ids: Array.isArray(cfg.knowledgeIds) ? cfg.knowledgeIds : [],
                apiBase: kbApiBase,
                topK: Constants.KB_TOP_K || 3,
                minScore: Constants.SIMILARITY_THRESHOLD || 0.4,
            },
            tts: {
                enabled: !!cfg.ttsEnabled,
                apiUrl: (sm.getTtsApiUrl() || '').replace(/\/+$/, ''),
                apiKey: sm.getTtsApiKey() || '',
                // 角色自己的音色优先；没配就用 default
                voiceId: ((resolved && resolved.role && resolved.role.ttsVoice) || 'default'),
            },
            trigger: {
                cooldownSec: this._num(cfg.cooldownSec, 10),
                globalCooldownSec: this._num(cfg.globalCooldownSec, 3),
                hourlyQuota: this._num(cfg.hourlyQuota, 60),
                mentionBypass: cfg.mentionBypass !== false,
                probability: this._num(cfg.probability, 0.25),
                // 分条发送：模型用 `|||` 主动分条，这几项控制尺度
                replyPartMaxChars: this._num(cfg.replyPartMaxChars, 80),
                replyPartsMax: this._num(cfg.replyPartsMax, 3),
                partSendDelayMs: this._num(cfg.partSendDelayMs, 400),
            },
            context: {
                historyLimit: this._num(cfg.historyLimit, 12),
                groupScope: 'per_group',
            },
            _source: 'web',
        };
    }

    _num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    // ---------- 与后端通信 ----------

    /** 推送配置。返回 {ok, ready, detail}；失败不抛异常（服务没开是常态）。 */
    async push() {
        const payload = await this.buildPayload();
        try {
            const resp = await fetch(`${this.apiBase}/qq/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._lastPushOk = true;
            this._lastPushError = '';
            this.writeConfig({ lastPushAt: Date.now() });
            return {
                ok: true,
                ready: !!data.ready,
                detail: data.readyDetail || '',
                payload,
            };
        } catch (err) {
            this._lastPushOk = false;
            this._lastPushError = err && err.message ? err.message : String(err);
            return { ok: false, ready: false, detail: this._lastPushError, payload };
        }
    }

    /** 读取运行状态。服务没开时返回 {ok:false}，不抛异常。 */
    async runtime() {
        try {
            const resp = await fetch(`${this.apiBase}/qq/runtime`, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            return { ok: true, ...data };
        } catch (err) {
            return { ok: false, error: (err && err.message) ? err.message : String(err) };
        }
    }

    /** 上一次推送的结果（供 UI 展示） */
    get lastPush() {
        return { ok: this._lastPushOk, error: this._lastPushError };
    }

    // ---------- 自动推送时机 ----------

    /**
     * 启动「自动同步」：在几个关键时机把配置推到后端。
     *  - 页面加载完成后 3 秒（等服务起、也让首屏先渲染完）
     *  - 从设置面板改完配置（由面板显式调用 push）
     *  - 浏览器标签页重新可见（换设备/唤醒后补一次）
     *  - 每 5 分钟兜底一次（指数退避：失败后拉长到 30 分钟）
     */
    startAutoSync() {
        const tick = async () => {
            const cfg = this.readConfig();
            const res = await this.push();
            if (res.ok) {
                this._backoffMs = 5 * 60 * 1000;
            } else {
                this._backoffMs = Math.min((this._backoffMs || 5 * 60 * 1000) * 2, 30 * 60 * 1000);
            }
            clearTimeout(this._timer);
            this._timer = setTimeout(tick, this._backoffMs);
            return res;
        };
        this._backoffMs = 5 * 60 * 1000;

        setTimeout(tick, 3000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') tick();
        });
    }
}
