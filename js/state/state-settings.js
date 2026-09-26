// 内隐状态 · 对话设置区块（AI 人格深度 · 阶段三）
// ------------------------------------------------------------
// 入口位置：对话设置弹窗（#settings-modal → #implicit-state-settings），开启后才展开字段列表。
// 区块内容：
//   1. 总开关（本对话是否启用内隐状态）+ 是否显示悬浮卡片 + 复位卡片位置
//   2. 所有可编辑的角色状态字段（数值滑条 / 枚举下拉 / 文本输入 / 标签），含「注入 AI」「锁定」开关
//   3. 字段管理：内置字段启用/禁用、自定义字段新增/编辑/启用/硬删除（hint 必填）
//   4. 重置本话题状态 / 立即结算
// 保存语义（与既有对话设置一致）：开关与字段值在点击「保存设置」时写入；
// 字段定义（新增/编辑/删除/启用禁用）即时保存（与「提示词注入」系统的风格一致）。
import Constants from '../core/constants.js';
import { getEffectiveDefs, normalizeDef, createFieldValue } from './state-schema.js';

export class StateSettings {
    /**
     * @param {Object} deps
     * @param {Object} deps.store ImplicitStateStore
     * @param {Object} deps.extractor StateExtractor
     * @param {() => Object} [deps.getModalManager]
     * @param {() => void} [deps.onChanged] 数据变化后刷新悬浮卡片
     */
    constructor({ store, extractor, getModalManager = null, onChanged = null }) {
        this.store = store;
        this.extractor = extractor;
        this.getModalManager = getModalManager;
        this.onChanged = onChanged;
        this._editingKey = null;   // 正在编辑的自定义字段 key（null = 新增）
        this._chat = null;
        this._newChat = false;
    }

    #container() { return document.getElementById('implicit-state-settings'); }
    #switchEl() { return document.getElementById('implicit-state-switch'); }

    /** 打开对话设置弹窗时渲染区块 */
    render({ chat, newChat = false }) {
        const container = this.#container();
        const sw = this.#switchEl();
        if (!container || !sw) return;
        this._chat = chat || null;
        this._newChat = !!newChat;
        this._editingKey = null;

        const enabled = this._newChat
            ? false
            : (this._chat?.settings?.implicitStateEnabled === true);
        sw.checked = enabled;
        sw.onchange = () => this.#renderExpanded();

        // 新建对话模式：只有开关（字段区在对话创建后再编辑）
        if (this._newChat) {
            container.style.display = 'block';
            container.innerHTML = `<div class="iss-note">勾选后，本对话的角色会启用内隐状态（好感度 / 情绪 / 着装 …）。
                详细字段与自定义字段可在<b>对话创建后</b>用「对话设置」继续编辑。</div>`;
            return;
        }
        this.#renderExpanded();
    }

    #renderExpanded() {
        const container = this.#container();
        const sw = this.#switchEl();
        if (!container || !sw || this._newChat) return;
        const chat = this._chat;
        if (!chat) { container.style.display = 'none'; return; }

        if (!sw.checked) {
            container.style.display = 'block';
            container.innerHTML = `<div class="iss-note">开启后，这里会列出所有可编辑的角色状态字段，并可新增自定义字段。
                状态按话题独立维护：新话题从默认值开始。</div>`;
            return;
        }

        // 开启状态下：惰性初始化当前话题状态，保证下面立刻有值可编辑
        this.store.ensureState();
        // 记录用户已经输入但尚未保存的内容，重渲染后原样恢复（避免"改完 A 又点了 B，A 被吞掉"）
        const pending = this.#snapshotInputs();
        container.style.display = 'block';
        const panelVisible = chat.settings?.implicitStatePanelVisible !== false;
        container.innerHTML = `
            <div class="iss-toggle-row">
                <label class="iss-flag"><input type="checkbox" id="implicit-state-panel-visible" ${panelVisible ? 'checked' : ''}> 显示悬浮卡片</label>
                <button class="iss-btn" id="iss-reset-card-pos" type="button">复位卡片位置</button>
            </div>
            <div class="iss-note">状态按话题独立维护 —— 当前编辑的是「${this.#esc(this.#topicLabel())}」的状态；
                字段定义（增删改）作用于该角色的所有话题。<br>
                「情绪」可以直接输入任意词（下拉只是常用建议），旁边的 emoji 与强度 1~10 会一起生效；改完点「保存设置」写入。</div>
            <div class="iss-subhead"><span>状态字段（可编辑）</span><span id="iss-turn-hint"></span></div>
            <div class="iss-table" id="iss-fields">${this.#renderFields()}</div>
            <div class="iss-btns">
                <button class="iss-btn" id="iss-reset-state" type="button">重置本话题状态</button>
                <button class="iss-btn" id="iss-extract-now" type="button">立即结算一次</button>
            </div>
            <div class="iss-subhead"><span>状态时间线（可回滚）</span><span id="iss-tl-count" style="color:var(--text-dim);font-size:0.72rem;"></span></div>
            <div class="iss-table" id="iss-timeline">${this.#renderTimelineRows()}</div>
            ${this.#renderDefsManager()}
            ${this.#renderFieldForm()}
        `;
        // 回填「第 N 轮」（此刻 DOM 已存在）
        const turnHint = document.getElementById('iss-turn-hint');
        const st = this.store.getState({ create: true });
        if (turnHint && st) turnHint.innerHTML = `<span class="iss-note" style="margin:0;">第 ${st.turn || 0} 轮</span>`;
        this.#restoreInputs(pending);
        this.#bindExpanded();
    }

    // ==================== 字段列表 ====================

    #renderFields() {
        const chat = this._chat;
        const state = this.store.getState({ create: true });
        const defs = getEffectiveDefs(chat);
        if (!state) return '<div class="iss-note">当前话题还没有状态（切到具体话题后再试）。</div>';
        // 侧注：当前回合数（DOM 已在下方渲染后回填）
        return defs.map(def => {
            const f = state.fields[def.key] || createFieldValue(def);
            let control = '';
            if (def.type === 'number') {
                control = `<input type="range" data-input="number" min="${def.min}" max="${def.max}" step="${def.step || 1}" value="${f.value}"
                                style="flex:1;" ${f.locked ? 'disabled' : ''}>
                           <span class="iss-num-badge" data-num-out>${f.value}/${def.max}</span>`;
            } else if (def.type === 'enum') {
                // 情绪这类「自由枚举」：允许自填 + 给下拉建议（datalist），并附 emoji / 强度
                // 固定选项的枚举（如关系）才渲染成下拉；两者都不会出现"空下拉框"
                const fixed = Array.isArray(def.options) && def.options.length > 0 && !def.freeform;
                if (fixed) {
                    const opts = def.options.map(o => `<option value="${this.#esc(o)}" ${o === f.value ? 'selected' : ''}>${this.#esc(o)}</option>`).join('');
                    control = `<select data-input="enum" ${f.locked ? 'disabled' : ''}>${opts}</select>`;
                } else {
                    // 自由枚举（情绪）：可直接输入任意词 + 右侧「常用…」下拉一键填入。
                    // 不用 <datalist>：各浏览器对它的键盘事件派发行为不一致（Firefox/Edge 会把
                    // 列表内的按键派发到 input 上），改用显式 select 更稳、行为可控。
                    const opts = (def.options || []).map(o => `<option value="${this.#esc(o)}">${this.#esc(o)}</option>`).join('');
                    const parts = [`<input type="text" data-input="enum-text" value="${this.#esc(f.value)}"
                                        placeholder="可直接输入任意情绪词" ${f.locked ? 'disabled' : ''}>`];
                    if (opts) {
                        parts.push(`<select data-input="mood-pick" title="从常用情绪里挑一个，填入左侧输入框" style="flex:0 0 92px;" ${f.locked ? 'disabled' : ''}>
                                        <option value="">常用…</option>${opts}
                                    </select>`);
                    }
                    if (def.withIntensity) {
                        parts.push(`<input type="text" data-input="emoji" value="${this.#esc(f.emoji || '')}" maxlength="4"
                                        placeholder="emoji" title="情绪对应的 emoji（改动情绪时会自动补一个合适的）" style="flex:0 0 52px;text-align:center;" ${f.locked ? 'disabled' : ''}>`);
                        parts.push(`<input type="number" data-input="intensity" value="${Number.isFinite(f.intensity) ? f.intensity : 3}" min="1" max="10" step="1"
                                        title="情绪强度 1~10" style="flex:0 0 58px;" ${f.locked ? 'disabled' : ''}>`);
                    }
                    control = parts.join('');
                }
            } else if (def.type === 'tags') {
                const v = Array.isArray(f.value) ? f.value.join('、') : '';
                control = `<input type="text" data-input="tags" value="${this.#esc(v)}" placeholder="用「、」分隔" ${f.locked ? 'disabled' : ''}>`;
            } else {
                const v = f.panelHidden ? '' : f.value;
                control = `<input type="text" data-input="text" value="${this.#esc(v)}" maxlength="${def.maxLen || 80}"
                                placeholder="${f.panelHidden ? '（对用户隐藏，AI 可见）' : '未设定'}" ${f.locked ? 'disabled' : ''}>`;
            }
            const delBtn = def.custom
                ? `<button class="iss-icon-btn iss-danger" data-act="del-field" type="button" title="删除该自定义字段（不可恢复）">🗑</button>`
                : '';
            return `<div class="iss-tr" data-key="${def.key}">
                <span class="iss-name" title="${this.#esc(def.label)}${def.panelHidden ? '（对用户隐藏）' : ''}">
                    ${def.icon || ''} ${this.#esc(def.label)}${def.panelHidden ? ' 🔒' : ''}
                </span>
                <span class="iss-value">${control}</span>
                <span class="iss-flags">
                    <label class="iss-flag" title="是否把该字段注入给 AI"><input type="checkbox" data-field-inject ${def.inject ? 'checked' : ''}> 注入</label>
                    <label class="iss-flag" title="锁定后 AI 不再修改该字段"><input type="checkbox" data-field-lock ${f.locked ? 'checked' : ''}> 锁</label>
                    <button class="iss-icon-btn" data-act="reset-field" type="button" title="恢复默认值">↺</button>
                    ${delBtn}
                </span>
            </div>`;
        }).join('');
    }

    // ==================== 字段定义管理 ====================

    #renderDefsManager() {
        const chat = this._chat;
        const meta = chat.implicitStateDefs || {};
        const disabled = new Set(meta.disabledBuiltins || []);
        const builtinNames = {
            affection: '好感度', trust: '信任度', mood: '情绪', energy: '精力', outfit: '着装',
            pose: '姿态', location: '所在', relation: '关系', secret: '未说出口', flags: '标记',
        };
        const builtinRows = Object.entries(builtinNames).map(([key, name]) => `
            <div class="iss-tr ${disabled.has(key) ? 'iss-disabled' : ''}">
                <span class="iss-name">${this.#esc(name)}</span>
                <span class="iss-value"><small style="color:var(--text-dim);">内置字段（不可删除，可禁用）</small></span>
                <span class="iss-flags">
                    <label class="iss-flag"><input type="checkbox" data-builtin-toggle="${key}" ${disabled.has(key) ? '' : 'checked'}> 启用</label>
                </span>
            </div>`).join('');

        const custom = Array.isArray(meta.customDefs) ? meta.customDefs : [];
        const customRows = custom.length === 0
            ? '<div class="iss-note" style="margin:4px 0 0;">还没有自定义字段。可以按剧情需要加「身上痕迹」「把柄」「执念」等等。</div>'
            : custom.map(d => `
            <div class="iss-tr ${d.enabled === false ? 'iss-disabled' : ''}" data-def-key="${d.key}">
                <span class="iss-name">${d.icon || '🔹'} ${this.#esc(d.label)}</span>
                <span class="iss-value"><small style="color:var(--text-dim);">${this.#typeLabel(d)}${d.hint ? ' · ' + this.#esc(d.hint) : ''}</small></span>
                <span class="iss-flags">
                    <label class="iss-flag"><input type="checkbox" data-def-toggle="${d.key}" ${d.enabled === false ? '' : 'checked'}> 启用</label>
                    <button class="iss-icon-btn" data-act="edit-def" type="button" data-def-key="${d.key}" title="编辑字段">✎</button>
                    <button class="iss-icon-btn iss-danger" data-act="del-def" type="button" data-def-key="${d.key}" title="删除字段（硬删除）">🗑</button>
                </span>
            </div>`).join('');

        return `
            <div class="iss-subhead"><span>内置字段</span></div>
            <div class="iss-table">${builtinRows}</div>
            <div class="iss-subhead">
                <span>自定义字段</span>
                <button class="iss-btn" id="iss-add-def" type="button">＋ 新增状态字段</button>
            </div>
            <div class="iss-table">${customRows}</div>`;
    }

    #renderFieldForm() {
        return `
            <div class="iss-form" id="iss-def-form" style="display:none;">
                <div class="iss-form-grid">
                    <label>名称 <span class="iss-req">*</span></label>
                    <input type="text" id="iss-def-label" placeholder="例如：身上痕迹" maxlength="12">
                    <label>图标</label>
                    <input type="text" id="iss-def-icon" placeholder="一个 emoji，例如 🩹" maxlength="4">
                    <label>类型</label>
                    <select id="iss-def-type">
                        <option value="text">文本（自由描述）</option>
                        <option value="number">数值（0~100 之类）</option>
                        <option value="enum">枚举（从固定选项里选）</option>
                        <option value="tags">标签（可增删的标签组）</option>
                    </select>
                    <label id="iss-def-range-label">数值范围</label>
                    <div id="iss-def-range" style="display:none;">
                        <div style="display:flex; gap:6px; align-items:center;">
                            最小 <input type="number" id="iss-def-min" value="0" style="width:64px;">
                            最大 <input type="number" id="iss-def-max" value="100" style="width:64px;">
                            默认 <input type="number" id="iss-def-default" value="0" style="width:64px;">
                            单次上限 <input type="number" id="iss-def-delta" value="10" style="width:64px;">
                        </div>
                    </div>
                    <label id="iss-def-options-label" style="display:none;">枚举选项</label>
                    <input type="text" id="iss-def-options" style="display:none;" placeholder="用「、」分隔，例如：轻微、明显、严重">
                    <label>给 AI 的说明 <span class="iss-req">*</span></label>
                    <textarea id="iss-def-hint" rows="2" placeholder="用一句话告诉 AI 这个字段是什么意思、什么时候该变，例如：角色身上新出现或正在消退的痕迹，如吻痕、绷带、擦伤"></textarea>
                    <div class="iss-form-hint">必填：模型不认识自定义字段，这句话会写进提取提示词，决定它能否正确演化。</div>
                    <label>可见性</label>
                    <div style="display:flex; gap:14px; flex-wrap:wrap;">
                        <label class="iss-flag"><input type="checkbox" id="iss-def-inject" checked> 注入给 AI</label>
                        <label class="iss-flag"><input type="checkbox" id="iss-def-hidden"> 对用户隐藏（面板显示 ？？？，AI 仍可见）</label>
                    </div>
                </div>
                <div class="iss-btns">
                    <button class="iss-btn" id="iss-def-save" type="button">保存字段</button>
                    <button class="iss-btn" id="iss-def-cancel" type="button">取消</button>
                </div>
            </div>`;
    }

    /** 读取一行里所有编辑控件的值 → { kind: value }（情绪这类一行可能有 值/emoji/强度 多个控件） */
    #readRow(row) {
        const out = {};
        row.querySelectorAll('[data-input]').forEach(el => {
            if (el.dataset.input === 'mood-pick') return;   // 「常用…」下拉只是快捷填入，不是字段值本身
            out[el.dataset.input] = el.value;
        });
        return out;
    }

    /** 收集当前字段行里用户已输入的内容（重渲染前调用，避免重渲染吞掉未保存的输入） */
    #snapshotInputs() {
        const out = {};
        const container = this.#container();
        if (!container) return out;
        container.querySelectorAll('#iss-fields .iss-tr').forEach(row => {
            const values = this.#readRow(row);
            if (Object.keys(values).length > 0) out[row.dataset.key] = values;
        });
        return out;
    }

    /** 把用户已输入的内容写回重渲染后的控件 */
    #restoreInputs(snap) {
        if (!snap || Object.keys(snap).length === 0) return;
        const container = this.#container();
        if (!container) return;
        container.querySelectorAll('#iss-fields .iss-tr').forEach(row => {
            const saved = snap[row.dataset.key];
            if (!saved) return;
            row.querySelectorAll('[data-input]').forEach(input => {
                const kind = input.dataset.input;
                if (saved[kind] === undefined) return;
                input.value = saved[kind];
                const out = row.querySelector('[data-num-out]');
                if (out && kind === 'number') out.textContent = `${saved[kind]}/${input.max || 100}`;
            });
        });
    }

    // ==================== 时间线（回滚入口；悬浮卡片只读，改动统一放这里） ====================

    #renderTimelineRows() {
        const state = this.store.getState();
        const history = (state && Array.isArray(state.history)) ? state.history : [];
        const countEl = document.getElementById('iss-tl-count');
        if (countEl) countEl.textContent = history.length ? `共 ${history.length} 条（保留最近 ${Constants.IMPLICIT_STATE_HISTORY_MAX} 条）` : '';
        if (history.length === 0) {
            return '<div class="iss-note" style="margin:2px 0 0;">还没有状态变化记录。角色每次回复结束后会结算一次，这里就会出现轨迹。</div>';
        }
        return history.slice(-8).reverse().map((h) => {
            const idx = history.indexOf(h);
            const reason = h.reason ? this.#esc(h.reason) : '状态变化';
            const src = h.source === 'manual' ? '✍️ 手动' : '🤖 自动';
            return `<div class="isc-tl-item">
                <span class="isc-tl-turn">#${h.turn ?? '?'}</span>
                <span class="isc-tl-reason" title="${reason}">${src} · ${reason}</span>
                <button class="iss-icon-btn" data-rollback="${idx}" type="button" title="把状态回滚到这一轮">↩</button>
            </div>`;
        }).join('');
    }

    #rollbackTo(index) {
        const chat = this._chat;
        if (!chat) return;
        if (!confirm('把状态回滚到这一轮？\n\n当前值会被那条历史记录覆盖（其他话题不受影响），随后角色会按回滚后的状态继续。')) return;
        const ok = this.store.rollbackToHistory(index);
        if (!ok) { this.#toast('回滚失败（历史记录可能已被清理）'); return; }
        this.#renderExpanded();
        this.#notify();
        this.#toast('已回滚到该轮状态');
    }

    // ==================== 交互绑定 ====================

    #bindExpanded() {
        const container = this.#container();
        if (!container) return;
        const chat = this._chat;

        // 显示卡片
        const pv = document.getElementById('implicit-state-panel-visible');
        if (pv) {
            pv.onchange = () => {
                chat.settings = chat.settings || {};
                chat.settings.implicitStatePanelVisible = pv.checked;
                this.#notify();
            };
        }
        const resetPos = document.getElementById('iss-reset-card-pos');
        if (resetPos) {
            resetPos.onclick = () => {
                try {
                    localStorage.removeItem(Constants.STORAGE_KEYS.IMPLICIT_STATE_PANEL_POS);
                    localStorage.removeItem(Constants.STORAGE_KEYS.IMPLICIT_STATE_PANEL_POS_M);
                } catch { /* ignore */ }
                this.#toast('卡片位置已复位（下次打开或拖动时生效）');
            };
        }
        // 重置本话题状态 / 立即结算
        const resetState = document.getElementById('iss-reset-state');
        if (resetState) {
            resetState.onclick = () => {
                if (!confirm('确定把**当前话题**的状态重置为默认值吗？（其他话题不受影响）')) return;
                this.store.resetCurrent();
                this.#renderExpanded();
                this.#notify();
                this.#toast('已重置当前话题状态');
            };
        }
        const extractNow = document.getElementById('iss-extract-now');
        if (extractNow) {
            extractNow.onclick = async () => {
                extractNow.disabled = true;
                extractNow.textContent = '结算中…';
                try {
                    const r = await this.extractor.extractNow(chat.id);
                    this.#toast(r?.failed ? '结算失败（已保留原状态）' : '已用最近几条对话重新结算');
                } finally {
                    extractNow.disabled = false;
                    extractNow.textContent = '立即结算一次';
                    this.#renderExpanded();
                    this.#notify();
                }
            };
        }

        // 字段行：数值实时回显 / 注入 / 锁定 / 重置 / 删除
        container.querySelectorAll('#iss-fields .iss-tr').forEach(row => {
            const key = row.dataset.key;
            const num = row.querySelector('[data-input="number"]');
            const out = row.querySelector('[data-num-out]');
            if (num && out) num.oninput = () => { out.textContent = `${num.value}/${num.max}`; };

            const inject = row.querySelector('[data-field-inject]');
            if (inject) inject.onchange = () => { this.#setFieldInject(key, inject.checked); };

            const lock = row.querySelector('[data-field-lock]');
            if (lock) lock.onchange = () => {
                this.store.setLocked(key, lock.checked, { chat });
                // 锁定后禁用/启用该行的编辑控件
                row.querySelectorAll('[data-input]').forEach(el => { el.disabled = lock.checked; });
                this.#notify();
            };

            const resetField = row.querySelector('[data-act="reset-field"]');
            if (resetField) resetField.onclick = () => {
                const def = getEffectiveDefs(chat).find(d => d.key === key);
                if (!def) return;
                const dv = createFieldValue(def).value;
                this.store.setFieldValue(key, dv, { chat });
                this.#renderExpanded();
                this.#notify();
            };

            // 情绪这类自由枚举：改了情绪词就自动补一个合适的 emoji；「常用…」下拉一键填入
            const moodInput = row.querySelector('[data-input="enum-text"]');
            const emojiInput = row.querySelector('[data-input="emoji"]');
            if (moodInput && emojiInput) {
                const def = getEffectiveDefs(chat).find(d => d.key === key);
                const hints = def?.emojiHints || {};
                moodInput.onchange = () => {
                    const hit = hints[String(moodInput.value).trim()];
                    if (hit) emojiInput.value = hit;
                };
                const pick = row.querySelector('[data-input="mood-pick"]');
                if (pick) {
                    pick.onchange = () => {
                        const v = pick.value;
                        if (!v) return;
                        moodInput.value = v;
                        if (hints[v]) emojiInput.value = hints[v];
                        pick.value = '';   // 复位为「常用…」，避免看起来像已选中
                        pick.blur();
                    };
                }
            }

            const delField = row.querySelector('[data-act="del-field"]');
            if (delField) delField.onclick = () => this.#deleteCustomField(key);
        });

        // 时间线回滚
        container.querySelectorAll('[data-rollback]').forEach(btn => {
            btn.onclick = () => this.#rollbackTo(parseInt(btn.dataset.rollback, 10));
        });

        // 内置字段启用/禁用
        container.querySelectorAll('[data-builtin-toggle]').forEach(cb => {
            cb.onchange = () => {
                const key = cb.dataset.builtinToggle;
                const meta = chat.implicitStateDefs || (chat.implicitStateDefs = { version: 1, disabledBuiltins: [], overrides: {}, customDefs: [] });
                const set = new Set(meta.disabledBuiltins || []);
                if (cb.checked) set.delete(key); else set.add(key);
                meta.disabledBuiltins = [...set];
                meta.updatedAt = Date.now();
                this.store.writeState(chat);
                this.#renderExpanded();
                this.#notify();
            };
        });

        // 自定义字段：启用/编辑/删除
        container.querySelectorAll('[data-def-toggle]').forEach(cb => {
            cb.onchange = () => {
                const key = cb.dataset.defToggle;
                const def = (chat.implicitStateDefs?.customDefs || []).find(d => d.key === key);
                if (!def) return;
                def.enabled = cb.checked;
                chat.implicitStateDefs.updatedAt = Date.now();
                this.store.writeState(chat);
                this.#renderExpanded();
                this.#notify();
            };
        });
        container.querySelectorAll('[data-act="edit-def"]').forEach(btn => {
            btn.onclick = () => this.#openDefForm(btn.dataset.defKey);
        });
        container.querySelectorAll('[data-act="del-def"]').forEach(btn => {
            btn.onclick = () => this.#deleteCustomField(btn.dataset.defKey);
        });
        const addBtn = document.getElementById('iss-add-def');
        if (addBtn) addBtn.onclick = () => this.#openDefForm(null);

        // 字段表单
        const typeSel = document.getElementById('iss-def-type');
        if (typeSel) typeSel.onchange = () => this.#syncDefFormByType();
        const saveBtn = document.getElementById('iss-def-save');
        if (saveBtn) saveBtn.onclick = () => this.#saveDefForm();
        const cancelBtn = document.getElementById('iss-def-cancel');
        if (cancelBtn) cancelBtn.onclick = () => this.#closeDefForm();

        // 回车不触发表单提交（默认提交会整页刷新）：定义表单里回车 = 保存字段，其他输入框回车 = 收起
        // 只在容器上绑一次（容器元素在多次重渲染间是同一个，避免监听器叠加）
        if (!container._issKeyGuarded) {
            container._issKeyGuarded = true;
            container.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.target.matches('textarea')) return;
                if (!e.target.matches('input, select')) return;
                e.preventDefault();
                const form = document.getElementById('iss-def-form');
                if (form && form.style.display === 'block') this.#saveDefForm();
                else e.target.blur();
            });
        }
    }

    #syncDefFormByType() {
        const type = document.getElementById('iss-def-type')?.value;
        const rangeWrap = document.getElementById('iss-def-range');
        const rangeLabel = document.getElementById('iss-def-range-label');
        const optWrap = document.getElementById('iss-def-options');
        const optLabel = document.getElementById('iss-def-options-label');
        const showRange = type === 'number';
        const showOpts = type === 'enum';
        if (rangeWrap) rangeWrap.style.display = showRange ? 'block' : 'none';
        if (rangeLabel) rangeLabel.style.display = showRange ? 'block' : 'none';
        if (optWrap) optWrap.style.display = showOpts ? 'block' : 'none';
        if (optLabel) optLabel.style.display = showOpts ? 'block' : 'none';
    }

    /** 打开字段表单（key=null 为新增，否则编辑既有自定义字段） */
    #openDefForm(key) {
        this._editingKey = key;
        const form = document.getElementById('iss-def-form');
        if (!form) return;
        const def = key ? (this._chat.implicitStateDefs?.customDefs || []).find(d => d.key === key) : null;
        document.getElementById('iss-def-label').value = def?.label || '';
        document.getElementById('iss-def-icon').value = def?.icon || '';
        document.getElementById('iss-def-type').value = def?.type || 'text';
        document.getElementById('iss-def-min').value = def?.min ?? 0;
        document.getElementById('iss-def-max').value = def?.max ?? 100;
        document.getElementById('iss-def-default').value = def?.default ?? (def?.type === 'number' ? 0 : '');
        document.getElementById('iss-def-delta').value = def?.maxDeltaPerTurn ?? 10;
        document.getElementById('iss-def-options').value = Array.isArray(def?.options) ? def.options.join('、') : '';
        document.getElementById('iss-def-hint').value = def?.hint || '';
        document.getElementById('iss-def-inject').checked = def ? def.inject !== false : true;
        document.getElementById('iss-def-hidden').checked = !!def?.panelHidden;
        form.style.display = 'block';
        this.#syncDefFormByType();
        document.getElementById('iss-def-label')?.focus();
    }

    #closeDefForm() {
        this._editingKey = null;
        const form = document.getElementById('iss-def-form');
        if (form) form.style.display = 'none';
    }

    /** 保存字段表单 → 写入 chat.implicitStateDefs（即时保存） */
    #saveDefForm() {
        const chat = this._chat;
        if (!chat) return;
        const label = document.getElementById('iss-def-label').value.trim();
        const type = document.getElementById('iss-def-type').value;
        const hint = document.getElementById('iss-def-hint').value.trim();
        if (!label) { this.#alert('请填写字段名称'); return; }
        if (!hint) { this.#alert('请填写「给 AI 的说明」—— 模型不认识自定义字段，没有这句话它不会演化这个字段'); return; }

        const raw = {
            key: this._editingKey || `custom_${Date.now()}`,
            label,
            icon: document.getElementById('iss-def-icon').value.trim() || '🔹',
            type,
            hint,
            inject: document.getElementById('iss-def-inject').checked,
            panelHidden: document.getElementById('iss-def-hidden').checked,
            enabled: true,
            order: 200 + (chat.implicitStateDefs?.customDefs?.length || 0),
        };
        if (type === 'number') {
            raw.min = Number(document.getElementById('iss-def-min').value);
            raw.max = Number(document.getElementById('iss-def-max').value);
            raw.default = Number(document.getElementById('iss-def-default').value);
            raw.maxDeltaPerTurn = Number(document.getElementById('iss-def-delta').value);
        } else if (type === 'enum') {
            raw.options = document.getElementById('iss-def-options').value
                .split(/[、,，]/).map(s => s.trim()).filter(Boolean);
        } else if (type === 'tags') {
            raw.default = [];
        } else {
            raw.maxLen = 80;
            raw.default = '';
        }
        const def = normalizeDef(raw);
        if (!def) {
            this.#alert('字段配置不完整：枚举类型至少需要一个选项；数值范围需 max > min');
            return;
        }
        const meta = chat.implicitStateDefs || (chat.implicitStateDefs = { version: 1, disabledBuiltins: [], overrides: {}, customDefs: [] });
        meta.customDefs = Array.isArray(meta.customDefs) ? meta.customDefs : [];
        const idx = meta.customDefs.findIndex(d => d.key === def.key);
        if (idx >= 0) {
            def.enabled = meta.customDefs[idx].enabled !== false;
            meta.customDefs[idx] = def;
        } else {
            meta.customDefs.push(def);
        }
        meta.updatedAt = Date.now();
        this.store.writeState(chat);
        this.#closeDefForm();
        this.#renderExpanded();
        this.#notify();
        this.#toast(`已保存字段「${def.label}」`);
    }

    /** 硬删除自定义字段（定义 + 所有话题的值 + 历史快照里的键） */
    #deleteCustomField(key) {
        const chat = this._chat;
        if (!chat || !key) return;
        const def = (chat.implicitStateDefs?.customDefs || []).find(d => d.key === key);
        if (!def) return;
        const touched = (chat.topics || []).filter(t => t.implicitState?.fields && Object.prototype.hasOwnProperty.call(t.implicitState.fields, key)).length;
        const msg = `删除自定义字段「${def.label}」？\n\n` +
            `该字段在 ${touched} 个话题中的当前值、以及状态时间线里的历史记录，都会被**永久删除且不可恢复**。\n\n` +
            `（如果只是暂时不想用它，请改用「启用」开关取消勾选。）`;
        if (!confirm(msg)) return;
        const r = this.store.deleteCustomField(key, chat);
        this.#renderExpanded();
        this.#notify();
        this.#toast(`已删除字段「${def.label}」（清理了 ${r.topics} 个话题）`);
    }

    /** 切换某字段是否注入给 AI（内置写 overrides，自定义写自身） */
    #setFieldInject(key, inject) {
        const chat = this._chat;
        if (!chat) return;
        const meta = chat.implicitStateDefs || (chat.implicitStateDefs = { version: 1, disabledBuiltins: [], overrides: {}, customDefs: [] });
        const custom = (meta.customDefs || []).find(d => d.key === key);
        if (custom) {
            custom.inject = !!inject;
        } else {
            meta.overrides = meta.overrides || {};
            meta.overrides[key] = { ...(meta.overrides[key] || {}), inject: !!inject };
        }
        meta.updatedAt = Date.now();
        this.store.writeState(chat);
        this.#notify();
    }

    // ==================== 保存（由 ModalManager 调用） ====================

    /**
     * 点击「保存设置」时收集本区块的内容。
     * 开关与字段值在这里写入；字段定义已在操作时即时保存。
     */
    collect(chat) {
        const sw = this.#switchEl();
        if (!chat || !sw) return;
        chat.settings = chat.settings || {};
        chat.settings.implicitStateEnabled = sw.checked;
        if (this._newChat) return;                       // 新对话：只有开关
        if (String(this.store.chat?.id) !== String(chat.id)) return;   // 弹窗与当前对话不一致时不动状态
        if (!sw.checked) { this.store.writeState(chat); return; }

        const container = this.#container();
        if (container) {
            const state = this.store.getState({ create: true });
            const defs = getEffectiveDefs(chat);
            container.querySelectorAll('#iss-fields .iss-tr').forEach(row => {
                const key = row.dataset.key;
                const def = defs.find(d => d.key === key);
                const f = state?.fields?.[key];
                if (!def || !f) return;
                const v = this.#readRow(row);
                let value;
                if (def.type === 'number') {
                    value = Number(v.number);
                    if (!Number.isFinite(value)) return;
                } else if (def.type === 'enum') {
                    // 固定选项：v.enum；自由枚举（情绪）：v['enum-text'] + emoji + 强度
                    const raw = (v['enum-text'] !== undefined) ? v['enum-text'] : v.enum;
                    if (raw === undefined) return;
                    value = { value: raw, emoji: v.emoji, intensity: v.intensity };
                } else if (def.type === 'tags') {
                    value = (v.tags || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean);
                } else {
                    value = v.text === undefined ? '' : v.text;
                    // 文本字段若因「对用户隐藏」而渲染成空串，且原值非空 → 视为未修改
                    if (value === '' && f.value) return;
                }
                if (this.#isSameValue(def, f, value)) return;
                this.store.setFieldValue(key, value, { chat });
            });
        }
        this.store.writeState(chat);
        this.#notify();
    }

    /** 判断收集到的值是否与当前字段值等价（避免每轮保存都写一次库） */
    #isSameValue(def, field, value) {
        if (def.type === 'enum') {
            const cur = { value: field.value, emoji: field.emoji, intensity: field.intensity };
            const next = {
                value: value.value,
                emoji: value.emoji === undefined ? field.emoji : String(value.emoji).slice(0, 4),
                intensity: (value.intensity === undefined || value.intensity === '')
                    ? field.intensity
                    : Math.min(10, Math.max(1, Math.round(Number(value.intensity) || 3))),
            };
            return JSON.stringify(cur) === JSON.stringify(next);
        }
        return JSON.stringify(value) === JSON.stringify(field.value);
    }

    // ==================== 小工具 ====================

    #topicLabel() {
        const chat = this._chat;
        if (!chat || !Array.isArray(chat.topics)) return '当前话题';
        const idx = chat.currentTopicIndex;
        const topic = (idx === null || idx === undefined) ? null : chat.topics[idx];
        return topic?.name || '当前话题';
    }

    #typeLabel(def) {
        if (def.type === 'number') return `数值 ${def.min}~${def.max}`;
        if (def.type === 'enum') return `枚举：${(def.options || []).join(' / ')}`;
        if (def.type === 'tags') return '标签';
        return '文本';
    }

    #notify() {
        if (typeof this.onChanged === 'function') {
            try { this.onChanged(); } catch (err) { console.warn('[ImplicitState] 刷新卡片失败：', err); }
        }
    }

    #toast(msg) {
        const mm = this.getModalManager ? this.getModalManager() : null;
        if (mm && typeof mm.showBriefToast === 'function') mm.showBriefToast(msg);
    }

    #alert(msg) {
        const mm = this.getModalManager ? this.getModalManager() : null;
        if (mm && typeof mm.customAlert === 'function') mm.customAlert(msg, 'warning');
        else window.alert(msg);
    }

    #esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}

export default StateSettings;
