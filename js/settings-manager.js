// 全局设置管理器负责从 localStorage 读取/写入/更新 global_settings，统一默认值与错误处理。
import Constants from './constants.js';

const STORAGE_KEY = 'global_settings';

// 字段默认值表。所有读操作都从这张表取默认值，写操作不会写入默认值。
const DEFAULTS = Object.freeze({
    // 模型相关
    modelHost: Constants.DEFAULT_MODEL_HOST,
    apiKey: '',
    modelName: Constants.DEFAULT_MODEL_NAME,

    // 用户相关
    username: '访客',
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
    typingSpeed: 1.0,     // 0.1 ~ 1.0

    // 服务地址
    ttsApiUrl: Constants.DEFAULT_TTS_API_URL,
    ttsApiKey: '',
    imgApiUrl: Constants.DEFAULT_IMG_API_URL,
    imgApiKey: '',

    // 快捷键（由 saveGlobalSettings 整体序列化）
    shortcuts: {},
    //自动滚动开关
    autoScrollAfterSend: true,
});

export class SettingsManager {
    /**
     * 安全地从 localStorage 读取并解析。
     * 失败（解析错误 / 无 key / 不是对象）时返回空对象。
     * @returns {Object}
     */
    static _read() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
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
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) {
            console.warn('[SettingsManager] reset 失败：', err);
        }
    }

    static getModelProvider() {
        return this._read().modelProvider ?? 'ollama';
    }

    // ========== 按厂商（provider）保存/恢复设置 ==========
    // 每个厂商独立保存：apiKey、modelHost、models（模型列表）、currentModel
    static #PROVIDER_KEY = 'provider_settings';

    /** @returns {Object} 所有厂商的保存状态 */
    static #_readProviderStates() {
        try {
            const raw = localStorage.getItem(this.#PROVIDER_KEY);
            if (!raw) return {};
            return JSON.parse(raw) || {};
        } catch { return {}; }
    }

    static #_writeProviderStates(states) {
        try {
            localStorage.setItem(this.#PROVIDER_KEY, JSON.stringify(states));
            return true;
        } catch (err) {
            console.warn('[SettingsManager] 保存厂商设置失败：', err);
            return false;
        }
    }

    /**
     * 为指定厂商保存当前设置快照
     * @param {string} providerId - 厂商标识（如 'ollama', 'deepseek'）
     * @param {{apiKey?: string, modelHost?: string, models?: string[], currentModel?: string}} state
     */
    static saveProviderState(providerId, state) {
        if (!providerId) return false;
        const states = this.#_readProviderStates();
        states[providerId] = {
            apiKey: state.apiKey ?? '',
            modelHost: state.modelHost ?? '',
            models: state.models ?? [],
            currentModel: state.currentModel ?? '',
        };
        return this.#_writeProviderStates(states);
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
}

export default SettingsManager;
