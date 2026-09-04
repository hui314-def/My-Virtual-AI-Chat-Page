// 全局设置管理器负责从 localStorage 读取/写入/更新 global_settings，统一默认值与错误处理。
import Constants from './constants.js';

// 命名空间：'' = 访客（沿用旧键，兼容已有数据）；登录后为账户用户名（键加后缀）。
let _namespace = '';

function _globalKey() {
    return _namespace ? `${Constants.STORAGE_KEYS.GLOBAL_SETTINGS}_${_namespace}` : Constants.STORAGE_KEYS.GLOBAL_SETTINGS;
}
function _providerKey() {
    return _namespace ? `${Constants.STORAGE_KEYS.PROVIDER_SETTINGS}_${_namespace}` : Constants.STORAGE_KEYS.PROVIDER_SETTINGS;
}

// 字段默认值表。所有读操作都从这张表取默认值，写操作不会写入默认值。
// 同步回调：设置在 localStorage 写入后触发，用于把「可同步子集」推送到后端。
let _syncHook = null;
let _suppressSync = false;

const DEFAULTS = Object.freeze({
    // 模型相关
    modelHost: Constants.DEFAULT_MODEL_HOST,
    apiKey: '',
    modelName: Constants.DEFAULT_MODEL_NAME,
    // 辅助任务模型（话题摘要/消息建议/记忆提取/开场白/人设/英文提示词），空字符串 = 跟随主模型
    auxModel: '',
    // 辅助任务模型所属厂商：空字符串 = 跟随主模型所在厂商；
    // 选择其他厂商的辅助模型时记录其厂商，辅助任务请求将使用该厂商的连接配置
    auxProvider: '',

    // 用户相关
    username: Constants.DEFAULT_USERNAME,
    bio: '',
    avatar: null,         // data:image/...;base64,... 或 null

    // 模型参数
    contextLimit: 10,     // 当 contextUnlimited=true 时实际值是 -1
    contextUnlimited: false,
    temperature: 0.7,
    topP: 0.9,
    thinkLevel: 0,         // 0=关闭, 1=低, 2=中, 3=高, 4=最高
    maxTokens: 500,        // 最大生成 token 数

    // 通用
    theme: 'dark',        // 'dark' | 'light' | 'auto'
    fontSize: 'medium',   // 'small' | 'medium' | 'large'
    typingSpeed: 1.0,     // 0.01 ~ 1.0（非线性：0.1≈54ms/字，0.01≈594ms/字）

    // 服务地址
    ttsApiUrl: Constants.DEFAULT_TTS_API_URL,
    ttsApiKey: '',
    imgApiUrl: Constants.DEFAULT_IMG_API_URL,
    imgApiKey: '',

    // 快捷键（由 saveGlobalSettings 整体序列化）
    shortcuts: {},
    //自动滚动开关
    autoScrollAfterSend: true,
    // 长期记忆开关（全局）
    memoryEnabled: true,
});

export class SettingsManager {
    /** 切换本地设置命名空间（'' = 访客；登录后传用户名）。 */
    static setNamespace(ns) { _namespace = ns || ''; }

    /**
     * 安全地从 localStorage 读取并解析。
     * 失败（解析错误 / 无 key / 不是对象）时返回空对象。
     * @returns {Object}
     */
    static _read() {
        try {
            const raw = localStorage.getItem(_globalKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (err) {
            console.warn('[SettingsManager] 读取失败，返回默认值：', err);
            return {};
        }
    }

    /**
     * 原子地写入 localStorage。捕获 QuotaExceededError 等异常并打印。
     * @param {Object} settings
     * @returns {boolean} 是否成功
     */
    static _write(settings) {
        try {
            localStorage.setItem(_globalKey(), JSON.stringify(settings));
            this._notifySync();
            return true;
        } catch (err) {
            console.error('[SettingsManager] 写入失败：', err);
            return false;
        }
    }

    /**
     * 写入并返回详细结果（成功 / 失败原因）。供调用方显示自定义错误提示。
     * @param {Object} settings
     * @returns {{success: boolean, error?: string, errorName?: string}}
     */
    static writeWithResult(settings) {
        try {
            localStorage.setItem(_globalKey(), JSON.stringify(settings));
            return { success: true };
        } catch (err) {
            console.error('[SettingsManager] 写入失败：', err);
            return { success: false, error: err.message, errorName: err.name };
        }
    }

    /**
     * 获取完整设置对象（已合并默认值，但不会写回存储）。
     * 用于需要读取多个字段的场景。
     * @returns {Object}
     */
    static get() {
        return { ...DEFAULTS, ...this._read() };
    }

    /**
     * 完整覆盖存储中的设置。
     * @param {Object} settings
     * @returns {boolean}
     */
    static set(settings) {
        return this._write(settings);
    }

    /**
     * 局部更新：浅合并。
     * @param {Object} patch
     * @returns {boolean}
     */
    static update(patch) {
        const current = this._read();
        return this._write({ ...current, ...patch });
    }

    /**
     * 清除所有全局设置（恢复默认）。
     */
    static reset() {
        try {
            localStorage.removeItem(_globalKey());
        } catch (err) {
            console.warn('[SettingsManager] reset 失败：', err);
        }
    }

    static getModelProvider() {
        return this._read().modelProvider ?? 'ollama';
    }

    // ========== 按厂商（provider）保存/恢复设置 ==========
    // 每个厂商独立保存：apiKey、modelHost、models（模型列表）、currentModel

    /** @returns {Object} 所有厂商的保存状态 (Public) */
    static getAllProviderStates() {
        return this.#_readProviderStates();
    }

    /** @returns {string} 当前生效的厂商标识 */
    static getActiveProvider() {
        return this._read().modelProvider ?? 'ollama';
    }

    /** @param {string} providerId 设置当前的有效厂商 */
    static setActiveProvider(providerId) {
        return this.update({ modelProvider: providerId });
    }

    /** @returns {Object} 所有厂商的保存状态 (Private) */
    static #_readProviderStates() {
        try {
            const raw = localStorage.getItem(_providerKey());
            if (!raw) return {};
            return JSON.parse(raw) || {};
        } catch { return {}; }
    }

    static #_writeProviderStates(states) {
        try {
            localStorage.setItem(_providerKey(), JSON.stringify(states));
            this._notifySync();
            return true;
        } catch (err) {
            console.warn('[SettingsManager] 保存厂商设置失败：', err);
            return false;
        }
    }

    /**
     * 为指定厂商保存当前设置快照（自动暂存路径：切换厂商时调用，不标记为手动预设）
     * @param {string} providerId - 厂商标识（如 'ollama', 'deepseek'）
     * @param {{apiKey?: string, modelHost?: string, models?: string[], currentModel?: string}} state
     */
    static saveProviderState(providerId, state) {
        if (!providerId) return false;
        const states = this.#_readProviderStates();
        const prev = states[providerId] || {};
        states[providerId] = {
            apiKey: state.apiKey ?? '',
            modelHost: state.modelHost ?? '',
            models: state.models ?? [],
            currentModel: state.currentModel ?? '',
            // 保留「手动保存预设」标记：自动暂存不得覆盖用户主动保存的状态
            preset: prev.preset === true,
        };
        return this.#_writeProviderStates(states);
    }

    /**
     * 手动保存厂商预设（点击「保存预设」按钮时调用）。
     * 与 saveProviderState 的区别：会写入 preset: true 标记，
     * 只有带该标记的厂商才会出现在「快速切换模型菜单」中。
     * @param {string} providerId - 厂商标识（如 'ollama', 'deepseek'）
     * @param {{apiKey?: string, modelHost?: string, models?: string[], currentModel?: string}} state
     */
    static saveProviderPreset(providerId, state) {
        if (!providerId) return false;
        const states = this.#_readProviderStates();
        const prev = states[providerId] || {};
        states[providerId] = {
            apiKey: state.apiKey ?? prev.apiKey ?? '',
            modelHost: state.modelHost ?? prev.modelHost ?? '',
            models: state.models ?? prev.models ?? [],
            currentModel: state.currentModel ?? prev.currentModel ?? '',
            preset: true,
        };
        return this.#_writeProviderStates(states);
    }

    /**
     * 清理「从未手动保存、且无任何连接参数」的空壳厂商记录
     * （由切换厂商时的自动暂存产生，会污染快速切换菜单）。
     * 保留：带 preset 标记、或已填写 modelHost/apiKey 的厂商（避免误删半成品配置）。
     * @returns {string[]} 被清理的厂商 id 列表
     */
    static pruneUnsavedProviders() {
        const states = this.#_readProviderStates();
        const removed = [];
        for (const [pid, st] of Object.entries(states)) {
            if (st && st.preset !== true && !st.modelHost && !st.apiKey) {
                delete states[pid];
                removed.push(pid);
            }
        }
        if (removed.length > 0) this.#_writeProviderStates(states);
        return removed;
    }

    /**
     * 读取指定厂商之前保存的设置快照
     * @param {string} providerId
     * @returns {{apiKey: string, modelHost: string, models: string[], currentModel: string}|null}
     */
    static loadProviderState(providerId) {
        if (!providerId) return null;
        const states = this.#_readProviderStates();
        return states[providerId] || null;
    }

    // ========== 便捷字段访问器 ==========
    // 命名规则：getXxx()，无 setXxx()（避免散落的写入导致数据不一致，统一通过 update() 修改）

    static getModelHost()   { return this._read().modelHost ?? DEFAULTS.modelHost; }
    static getApiKey()      { return this._read().apiKey ?? DEFAULTS.apiKey; }
    static getModelName()   { return this._read().modelName ?? DEFAULTS.modelName; }

    /** 辅助任务模型（话题摘要/消息建议/记忆提取/开场白/人设/英文提示词），空字符串表示跟随主模型 */
    static getAuxModel()    { return this._read().auxModel ?? DEFAULTS.auxModel; }

    /** 辅助任务模型所属厂商（空字符串 = 跟随主模型所在厂商） */
    static getAuxProvider() { return this._read().auxProvider ?? DEFAULTS.auxProvider; }

    /** 辅助任务实际生效的模型：配置了辅助模型则用之，否则跟随主模型 */
    static getAuxEffectiveModel() { return this.getAuxModel() || this.getModelName(); }

    /**
     * 辅助任务请求配置：若辅助模型来自其他已保存厂商（auxProvider 非空），
     * 则使用该厂商的连接参数（host/apiKey）；否则使用主模型所在厂商的全局配置。
     * @returns {{modelHost: string, apiKey: string, modelName: string}}
     */
    static getAuxRequestConfig() {
        const auxModel = this.getAuxModel();
        const modelName = auxModel || this.getModelName();
        // 仅当配置了独立辅助模型、且其厂商存在已保存的连接信息时，使用该厂商配置
        if (auxModel && this.getAuxProvider()) {
            const st = this.loadProviderState(this.getAuxProvider());
            if (st) {
                return {
                    modelHost: st.modelHost || this.getModelHost(),
                    apiKey: st.apiKey !== undefined && st.apiKey !== '' ? st.apiKey : this.getApiKey(),
                    modelName,
                };
            }
        }
        return {
            modelHost: this.getModelHost(),
            apiKey: this.getApiKey(),
            modelName,
        };
    }

    /**
     * 在已保存的厂商状态中查找包含指定模型的厂商 id。
     * @param {string} modelName
     * @returns {string|null}
     */
    static findProviderOfModel(modelName) {
        if (!modelName) return null;
        const states = this.#_readProviderStates();
        for (const [pid, st] of Object.entries(states)) {
            if (st && st.models && st.models.includes(modelName)) return pid;
        }
        return null;
    }

    static getUsername()    { return this._read().username ?? DEFAULTS.username; }
    static getBio()         { return this._read().bio ?? DEFAULTS.bio; }
    static getAvatar()      { return this._read().avatar ?? DEFAULTS.avatar; }

    static getContextLimit()        { return this._read().contextLimit ?? DEFAULTS.contextLimit; }
    static isContextUnlimited()     { return !!(this._read().contextUnlimited); }
    static getTemperature()         { return this._read().temperature ?? DEFAULTS.temperature; }
    static getTopP()                { return this._read().topP ?? DEFAULTS.topP; }
    static getThinkLevel()          { return this._read().thinkLevel ?? DEFAULTS.thinkLevel; }
    static getMaxTokens()           { return this._read().maxTokens ?? DEFAULTS.maxTokens; }

    static getTheme()       { return this._read().theme ?? DEFAULTS.theme; }
    static getFontSize()    { return this._read().fontSize ?? DEFAULTS.fontSize; }
    static getTypingSpeed() { return this._read().typingSpeed ?? DEFAULTS.typingSpeed; }

    static getTtsApiUrl()   { return this._read().ttsApiUrl ?? DEFAULTS.ttsApiUrl; }
    static getTtsApiKey()   { return this._read().ttsApiKey ?? DEFAULTS.ttsApiKey; }
    static getImgApiUrl()   { return this._read().imgApiUrl ?? DEFAULTS.imgApiUrl; }
    static getImgApiKey()   { return this._read().imgApiKey ?? DEFAULTS.imgApiKey; }

    static getShortcuts()   { return this._read().shortcuts ?? DEFAULTS.shortcuts; }
    static getAutoScrollAfterSend() {return this._read().autoScrollAfterSend ?? DEFAULTS.autoScrollAfterSend;}
    static getMemoryEnabled() { return this._read().memoryEnabled ?? DEFAULTS.memoryEnabled; }

    // ========== 云同步 ==========
    /** 注册设置变更回调（localStorage 写入后触发，参数为可同步子集）。 */
    static setSyncHook(fn) { _syncHook = fn; }

    static _notifySync() {
        if (_suppressSync || !_syncHook) return;
        try { _syncHook(this.getSyncableSettings()); } catch (e) { console.warn('[SettingsManager] 同步回调失败：', e); }
    }

    /** 返回「可同步设置子集」：global_settings 剔除 API Key；provider_settings 剔除各厂商 apiKey。 */
    static getSyncableSettings() {
        const all = this.get();
        const out = {};
        for (const [k, v] of Object.entries(all)) {
            if (k === 'apiKey' || k === 'ttsApiKey' || k === 'imgApiKey') continue;
            out[k] = v;
        }
        const providers = this.#_readProviderStates();
        const providersOut = {};
        for (const [pid, st] of Object.entries(providers || {})) {
            const { apiKey, ...rest } = st || {};
            providersOut[pid] = rest;
        }
        out.providers = providersOut;
        return out;
    }

    /** 应用服务端拉取的设置（可同步字段以服务端为准，本地 API Key 保留不覆盖）。 */
    static applySyncableSettings(syncable) {
        if (!syncable || typeof syncable !== 'object') return;
        const { providers, ...global } = syncable;
        const current = this._read();
        const merged = { ...global };
        for (const key of ['apiKey', 'ttsApiKey', 'imgApiKey']) {
            if (current[key]) merged[key] = current[key];
        }
        _suppressSync = true;
        try {
            this._write(merged);
            if (providers && typeof providers === 'object') {
                const curP = this.#_readProviderStates();
                for (const [pid, st] of Object.entries(providers)) {
                    const cur = curP[pid] || {};
                    curP[pid] = { ...st, apiKey: cur.apiKey || '' };
                }
                this.#_writeProviderStates(curP);
            }
        } finally {
            _suppressSync = false;
        }
    }
}

export default SettingsManager;
