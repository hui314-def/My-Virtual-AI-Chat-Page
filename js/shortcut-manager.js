// 快捷键管理模块，负责全局快捷键的加载/存储/监听/分发/录制/面板渲染。
// 依赖通过构造函数注入，与 script.js 中的具体动作解耦。
import { normalizeShortcut, eventToShortcutString, isBrowserReserved } from './utils.js';

export class ShortcutManager {
    /**
     * @param {Object} ctx — 由 script.js 注入的上下文依赖
     * @param {Object} ctx.defaultShortcuts    — 默认快捷键定义 { action: { keys, description }, ... }
     * @param {Function} ctx.getStoredShortcuts — () => Object  从存储读取用户自定义快捷键
     * @param {Function} ctx.saveShortcuts     — (shortcuts) => void  将快捷键持久化到存储
     * @param {Object} ctx.actionCallbacks     — { actionName: () => void }  各动作对应的回调
     * @param {Function} [ctx.customAlert]     — (msg, type?) => void  提示函数
     * @param {string} [ctx.panelContainerId]  — 快捷键面板容器 ID，默认 'shortcuts-list'
     */
    constructor(ctx) {
        this._defaultShortcuts = ctx.defaultShortcuts || {};
        this._getStoredShortcuts = ctx.getStoredShortcuts || (() => ({}));
        this._saveShortcuts = ctx.saveShortcuts || (() => {});
        this._actionCallbacks = ctx.actionCallbacks || {};
        this._customAlert = ctx.customAlert || ((msg) => console.warn(msg));
        this._panelContainerId = ctx.panelContainerId || 'shortcuts-list';

        /** @type {Object<string, string>} 当前生效的快捷键映射 { action: keys } */
        this.currentShortcuts = {};

        // 绑定方法，确保作为事件监听器时 this 指向正确
        this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    }

    // ==================== 生命周期 ====================

    /** 初始化：从存储加载快捷键并绑定全局监听 */
    init() {
        this._loadFromStorage();
        this._bindGlobalListener();
    }

    /** 销毁：移除全局监听 */
    destroy() {
        document.removeEventListener('keydown', this._boundHandleKeyDown, true);
    }

    // ==================== 公共查询方法 ====================

    /**
     * 获取当前快捷键映射的只读副本。
     * @returns {Object<string, string>}
     */
    getShortcuts() {
        return { ...this.currentShortcuts };
    }

    /**
     * 判断键盘事件是否匹配指定动作的快捷键。
     * 供 textarea 等局部 keydown 处理器使用。
     * @param {KeyboardEvent} e
     * @param {string} action - 动作名称，如 'send-no-ai'
     * @returns {boolean}
     */
    matchesAction(e, action) {
        const pressed = eventToShortcutString(e);
        if (!pressed) return false;
        const shortcut = this.currentShortcuts[action];
        return shortcut ? normalizeShortcut(shortcut) === pressed : false;
    }

    // ==================== 内部：加载与存储 ====================

    /** 从存储读取用户自定义快捷键，并用默认值补齐 */
    _loadFromStorage() {
        const stored = this._getStoredShortcuts();

        // 构建默认值映射（从 { action: { keys, description } } 提取 keys）
        const defaultsMap = {};
        for (const [action, obj] of Object.entries(this._defaultShortcuts)) {
            defaultsMap[action] = obj.keys;
        }

        this.currentShortcuts = { ...defaultsMap, ...stored };
    }

    /** 持久化当前快捷键（仅保存与默认值不同的项） */
    _persist() {
        this._saveShortcuts(this.currentShortcuts);
    }

    // ==================== 内部：全局监听与分发 ====================

    _bindGlobalListener() {
        // 先移除再添加，避免重复绑定
        document.removeEventListener('keydown', this._boundHandleKeyDown, true);
        document.addEventListener('keydown', this._boundHandleKeyDown, true);
    }

    /**
     * 全局 keydown 处理（捕获阶段）。
     * 匹配快捷键 → 执行对应动作。
     */
    _handleKeyDown(e) {
        const pressed = eventToShortcutString(e);
        if (!pressed) return;

        // 查找匹配的动作
        let targetAction = null;
        for (const [action, keys] of Object.entries(this.currentShortcuts)) {
            if (normalizeShortcut(keys) === pressed) {
                targetAction = action;
                break;
            }
        }
        if (!targetAction) return;

        // 聚焦类操作：不管焦点在哪里都执行
        if (targetAction === 'focus-input' || targetAction === 'focus-search') {
            e.preventDefault();
            e.stopPropagation();
            this.executeAction(targetAction);
            return;
        }

        // 其他快捷键：焦点在输入框或编辑区则忽略（避免干扰正常输入）
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        this.executeAction(targetAction);
    }

    // ==================== 动作执行 ====================

    /**
     * 执行指定动作。
     * @param {string} action - 动作名称
     */
    executeAction(action) {
        const callback = this._actionCallbacks[action];
        if (typeof callback === 'function') {
            callback();
        } else {
            console.warn(`[ShortcutManager] 未找到动作 "${action}" 的回调`);
        }
    }

    // ==================== 重置与修改 ====================

    /** 重置所有快捷键为默认值 */
    reset() {
        this.currentShortcuts = {};
        for (const [action, obj] of Object.entries(this._defaultShortcuts)) {
            this.currentShortcuts[action] = obj.keys;
        }
        this._persist();
        this.renderPanel();
    }

    /**
     * 更新单个快捷键。
     * @param {string} action - 动作名称
     * @param {string} keys   - 新的快捷键字符串，如 "ctrl+n"
     */
    updateShortcut(action, keys) {
        this.currentShortcuts[action] = keys;
        this._persist();
    }

    // ==================== 面板渲染 ====================

    /** 刷新快捷键设置面板 */
    renderPanel() {
        const container = document.getElementById(this._panelContainerId);
        if (!container) return;

        this._loadFromStorage(); // 确保数据最新

        let html = '';
        for (const [action, keys] of Object.entries(this.currentShortcuts)) {
            const desc = this._defaultShortcuts[action]?.description || action;
            html += `
                <div class="shortcut-row" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; background: rgba(30,34,55,0.5); border-radius:12px; padding:10px 16px;">
                    <span>${desc}</span>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <kbd style="background: #1a1c2a; padding: 4px 10px; border-radius:6px; border:1px solid #5f7eff; min-width:80px; text-align:center; cursor:pointer;"
                            class="shortcut-key" data-action="${action}">${keys.toUpperCase()}</kbd>
                    </div>
                </div>`;
        }
        container.innerHTML = html;

        // 绑定点击录制事件
        const self = this;
        container.querySelectorAll('.shortcut-key').forEach(el => {
            el.addEventListener('click', (e) => {
                const action = el.getAttribute('data-action');
                el.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> 按下组合键...';
                self.startRecord(action, el);
            });
        });
    }

    // ==================== 快捷键录制 ====================

    /**
     * 开始录制新的快捷键。
     * 用户按下组合键后自动更新并关闭录制。
     * @param {string} action        - 要修改的动作名称
     * @param {HTMLElement} displayElement - 显示快捷键的 DOM 元素
     */
    startRecord(action, displayElement) {
        const self = this;

        const handler = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const shortcut = eventToShortcutString(e);
            if (!shortcut) return;

            // 检查是否与浏览器保留快捷键冲突（仅警告，不阻止设置）
            if (isBrowserReserved(shortcut)) {
                self._customAlert(
                    `组合键 ${shortcut.toUpperCase()} 可能被浏览器保留，仍可设置但可能无法完全拦截默认行为。`,
                    'warning'
                );
            }

            self.updateShortcut(action, shortcut);
            if (displayElement) {
                displayElement.textContent = shortcut.toUpperCase();
            }

            document.removeEventListener('keydown', handler, true);
        };

        document.addEventListener('keydown', handler, true);

        // 超时保护：30 秒后自动取消录制
        setTimeout(() => {
            document.removeEventListener('keydown', handler, true);
            if (displayElement && displayElement.textContent.includes('按下组合键')) {
                const keys = self.currentShortcuts[action];
                displayElement.textContent = keys ? keys.toUpperCase() : '???';
            }
        }, 30000);
    }
}

export default ShortcutManager;
