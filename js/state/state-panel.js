// 内隐状态悬浮卡片（AI 人格深度 · 阶段二）
// ------------------------------------------------------------
// 一张可拖动、可折叠的悬浮卡片，**只读展示**「当前话题」的内隐状态：
//   - 拖动：仅标题栏触发，pointer 事件 + setPointerCapture，位置存 localStorage（桌面/移动分开存）
//   - 折叠：只留一行摘要，状态持久化（全局 UI 偏好）
//   - 变化反馈：更新后数字闪动 + Δ 浮标（涨绿跌红），刷新按钮可手动结算
//   - 时间线：最近变化的迷你折线 + 逐条记录（只读查看）
// 卡片**不提供任何修改入口**：改字段值、锁定字段、增删字段一律在「对话设置 → 内隐状态」里做
// （见 js/state/state-settings.js）。这样面板始终是"偷看内心的窗口"，不会误触改坏状态。
// 数据读取全部走 ImplicitStateStore。
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';
import { getEffectiveDefs, createFieldValue } from './state-schema.js';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class StatePanel {
    /**
     * @param {Object} deps
     * @param {Object} deps.store ImplicitStateStore
     * @param {Object} deps.extractor StateExtractor
     * @param {() => boolean} deps.getIsEnabled 当前对话是否启用内隐状态
     * @param {() => Object} [deps.getModalManager] 惰性获取 modalManager（提示用）
     */
    constructor({ store, extractor, getIsEnabled, getModalManager = null }) {
        this.store = store;
        this.extractor = extractor;
        this.getIsEnabled = getIsEnabled;
        this.getModalManager = getModalManager;
        this._dragging = false;
        this._timelineOpen = false;
        this._busy = false;
        this._error = '';
    }

    get cardEl() { return document.getElementById('implicit-state-card'); }
    get bodyEl() { return document.getElementById('isc-body'); }
    get footerEl() { return document.getElementById('isc-footer'); }
    get briefEl() { return document.getElementById('isc-brief'); }
    get timelineEl() { return document.getElementById('isc-timeline'); }

    // ==================== 生命周期 ====================

    /** 初始化：绑定交互 + 恢复位置/折叠状态（在模板注入后调用） */
    init() {
        const card = this.cardEl;
        if (!card) return;
        this.#bindDrag();
        this.#bindButtons();
        this.#restoreLayout();
        // 状态更新广播（由 script.js 的 StateExtractor 回调转发）
        window.addEventListener('implicit-state-updated', (e) => {
            const d = e.detail || {};
            this.onStateUpdated(d.chatId, d);
        });
        window.addEventListener('resize', () => this.#applySavedPosition(true));
    }

    /** 按当前对话/话题刷新卡片（开关、话题切换、角色切换时调用） */
    renderForCurrent() {
        const card = this.cardEl;
        if (!card) return;
        const chat = this.store.chat;
        const visible = this.getIsEnabled() && chat && chat.settings?.implicitStatePanelVisible !== false;
        if (!visible) { card.style.display = 'none'; return; }
        card.style.display = 'block';
        card.style.setProperty('--isc-opacity', String(SettingsManager.getImplicitStatePanelOpacity()));
        card.dataset.collapsed = SettingsManager.getImplicitStatePanelCollapsed() ? 'true' : 'false';
        this.#updateCollapseIcon();
        this.renderBody();
        this.renderFooter();
        if (this._timelineOpen) this.renderTimeline();
    }

    /** 收到一次状态更新（由 script.js 广播）：重绘 + 变化动画 */
    onStateUpdated(chatId, detail = {}) {
        const chat = this.store.chat;
        if (!chat || String(chat.id) !== String(chatId)) return;
        this._error = '';
        this.renderBody();
        this.renderFooter();
        if (this._timelineOpen) this.renderTimeline();
        for (const change of (detail.changes || [])) this.#flashChange(change);
    }

    /** 结算中 / 结算失败提示 */
    setBusy(busy) {
        this._busy = !!busy;
        this.renderFooter();
    }

    showError(msg) {
        this._error = String(msg || '更新失败');
        this.renderFooter();
    }

    // ==================== 渲染 ====================

    /** 渲染字段列表 */
    renderBody() {
        const body = this.bodyEl;
        if (!body) return;
        const chat = this.store.chat;
        const state = this.store.getState({ create: true });
        const defs = getEffectiveDefs(chat);
        if (!chat || !state) { body.innerHTML = '<div class="isc-empty">暂无状态</div>'; return; }

        const rows = defs.map(def => this.#renderRow(def, state)).join('');
        body.innerHTML = rows || '<div class="isc-empty">没有启用的字段（可在「对话设置 → 内隐状态」中添加）</div>';
        this.#renderBrief(defs, state);
    }

    /** 渲染一行（只读）：数值条 / 枚举徽章 / 文本 / 标签，均不可点击修改 */
    #renderRow(def, state) {
        const f = state.fields[def.key] || createFieldValue(def);
        const label = `<span class="isc-label"><span class="isc-label-emoji">${def.icon || ''}</span>${def.label}</span>`;

        let valueHtml = '';
        if (def.type === 'number') {
            const pct = ((f.value - def.min) / Math.max(1, def.max - def.min)) * 100;
            valueHtml = `<span class="isc-bar"><i style="width:${clamp(pct, 0, 100)}%; --isc-color:${def.color || '#5f7eff'}"></i></span>
                <span class="isc-num"><b>${f.value}</b><small>/${def.max}</small></span>`;
        } else if (def.type === 'enum') {
            const emoji = f.emoji ? `${f.emoji} ` : '';
            const intensity = Number.isFinite(f.intensity) ? ` · ${f.intensity}/10` : '';
            valueHtml = `<span class="isc-badge">${emoji}${this.#esc(f.value)}${intensity}</span>`;
        } else if (def.type === 'tags') {
            const list = Array.isArray(f.value) ? f.value : [];
            valueHtml = `<span class="isc-tags">${list.map(t => `<span class="isc-tag">${this.#esc(t)}</span>`).join('') || '<span class="isc-text isc-blank">（空）</span>'}</span>`;
        } else if (def.panelHidden) {
            // 对用户隐藏：面板显示 ？？？，但仍然注入给 AI
            valueHtml = `<span class="isc-text isc-hidden" title="该状态对角色内心可见，但对你隐藏">？？？</span>`;
        } else {
            const v = String(f.value || '');
            valueHtml = v
                ? `<span class="isc-text" title="${this.#esc(v)}">${this.#esc(v)}</span>`
                : '<span class="isc-text isc-blank">（未设定）</span>';
        }

        return `<div class="isc-row" data-key="${def.key}" title="内隐状态为只读展示；如需修改请到「对话设置 → 内隐状态」">${label}${valueHtml}</div>`;
    }

    #renderBrief(defs, state) {
        const brief = this.briefEl;
        if (!brief) return;
        const numDef = defs.find(d => d.type === 'number' && d.inject !== false);
        const enumDef = defs.find(d => d.type === 'enum');
        const parts = [];
        if (numDef && state.fields[numDef.key]) parts.push(`${numDef.icon || ''}${state.fields[numDef.key].value}`);
        if (enumDef && state.fields[enumDef.key]) {
            const f = state.fields[enumDef.key];
            parts.push(`${f.emoji ? f.emoji + ' ' : ''}${f.value}`);
        }
        brief.textContent = parts.join(' · ');
    }

    /** 底部状态栏：更新时间 / 结算中 / 失败提示 */
    renderFooter() {
        const footer = this.footerEl;
        if (!footer) return;
        const state = this.store.getState();
        const chat = this.store.chat;
        const topicName = this.#topicLabel(chat);
        let left = '';
        if (state && state.updatedAt) {
            left = `${topicName} · ${this.#timeAgo(state.updatedAt)}更新`;
        } else {
            left = `${topicName} · 尚未更新`;
        }
        let right = '';
        if (this._busy) right = '<span class="isc-updating">结算中</span>';
        else if (this._error) right = `<span class="isc-warn" title="${this.#esc(this._error)}">⚠ 本轮未更新</span>`;
        else right = `<span>第 ${state?.turn || 0} 轮</span>`;
        footer.innerHTML = `<span>${this.#esc(left)}</span>${right}`;
    }

    /** 时间线：迷你折线 + 最近变化（可回滚） */
    renderTimeline() {
        const el = this.timelineEl;
        if (!el) return;
        const state = this.store.getState();
        const chat = this.store.chat;
        const defs = getEffectiveDefs(chat);
        const history = (state && Array.isArray(state.history)) ? state.history : [];
        if (history.length === 0) {
            el.innerHTML = '<div class="isc-empty">还没有状态变化记录</div>';
            return;
        }
        // 折线取第一个数值字段（通常是好感度）
        const numDef = defs.find(d => d.type === 'number' && d.inject !== false);
        let spark = '';
        if (numDef) {
            const pts = history
                .map(h => h.snapshot ? Number(h.snapshot[numDef.key]) : NaN)
                .filter(v => Number.isFinite(v));
            if (pts.length >= 2) {
                const w = 240, h = 34, pad = 3;
                const min = Math.min(...pts), max = Math.max(...pts);
                const span = Math.max(1, max - min);
                const step = (w - pad * 2) / (pts.length - 1);
                const xy = pts.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)]);
                const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
                spark = `<svg class="isc-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
                    <polygon class="isc-spark-area" points="${area}"></polygon>
                    <polyline class="isc-spark-line" points="${line}"></polyline>
                </svg>`;
            }
        }
        const items = history.slice(-8).reverse().map((h) => {
            const reason = h.reason ? this.#esc(h.reason) : '状态变化';
            const src = h.source === 'manual' ? '✍️' : '🤖';
            return `<div class="isc-tl-item">
                <span class="isc-tl-turn">#${h.turn ?? '?'}</span>
                <span class="isc-tl-reason" title="${reason}">${src} ${reason}</span>
            </div>`;
        }).join('');
        el.innerHTML = spark + items;
    }

    // ==================== 交互绑定 ====================

    #bindButtons() {
        const rotate = (btn) => {
            if (!btn) return;
            btn.classList.add('isc-rotating');
            setTimeout(() => btn.classList.remove('isc-rotating'), 1200);
        };
        const refreshBtn = document.getElementById('isc-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                rotate(refreshBtn);
                this.setBusy(true);
                try {
                    const r = await this.extractor.extractNow(this.store.chat?.id);
                    if (r && r.failed) this.showError('提取失败（已保留原状态）');
                    else if (r && r.skipped) this.showError(`已跳过：${r.skipped}`);
                } catch (err) {
                    this.showError(err?.message || '提取失败');
                } finally {
                    this.setBusy(false);
                    this.renderBody();
                    this.renderFooter();
                }
            });
        }
        const collapseBtn = document.getElementById('isc-collapse');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = this.cardEl;
                const next = card.dataset.collapsed !== 'true';
                card.dataset.collapsed = next ? 'true' : 'false';
                SettingsManager.update({ implicitStatePanelCollapsed: next });
                this.#updateCollapseIcon();
            });
        }
        const hideBtn = document.getElementById('isc-hide');
        if (hideBtn) {
            hideBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chat = this.store.chat;
                if (!chat) return;
                chat.settings = chat.settings || {};
                chat.settings.implicitStatePanelVisible = false;
                this.store.writeState(chat);
                this.renderForCurrent();
                this.#toast('已隐藏卡片，可在「对话设置 → 内隐状态」重新开启');
            });
        }
        const timelineBtn = document.getElementById('isc-timeline-btn');
        if (timelineBtn) {
            timelineBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._timelineOpen = !this._timelineOpen;
                const el = this.timelineEl;
                if (el) el.style.display = this._timelineOpen ? 'block' : 'none';
                if (this._timelineOpen) this.renderTimeline();
            });
        }
    }

    // ==================== 拖动 ====================

    #posKey() {
        return window.innerWidth <= Constants.MOBILE_BREAKPOINT
            ? Constants.STORAGE_KEYS.IMPLICIT_STATE_PANEL_POS_M
            : Constants.STORAGE_KEYS.IMPLICIT_STATE_PANEL_POS;
    }

    #readSavedPos() {
        try {
            const raw = localStorage.getItem(this.#posKey());
            if (!raw) return null;
            const p = JSON.parse(raw);
            return (Number.isFinite(p?.left) && Number.isFinite(p?.top)) ? p : null;
        } catch { return null; }
    }

    #restoreLayout() {
        this.#applySavedPosition(false);
    }

    /** 应用保存的位置（clamp=true：尺寸变化后重新收进视口） */
    #applySavedPosition(clampOnly) {
        const card = this.cardEl;
        if (!card || card.style.display === 'none') return;
        const pos = this.#readSavedPos();
        if (!pos) return;
        const r = card.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - r.width - 8);
        const maxTop = Math.max(8, window.innerHeight - r.height - 8);
        const left = clamp(pos.left, 8, maxLeft);
        const top = clamp(pos.top, 8, maxTop);
        card.style.left = left + 'px';
        card.style.top = top + 'px';
        card.style.right = 'auto';
        if (clampOnly && (left !== pos.left || top !== pos.top)) this.#savePos(left, top);
    }

    #savePos(left, top) {
        try { localStorage.setItem(this.#posKey(), JSON.stringify({ left, top })); } catch { /* ignore */ }
    }

    #bindDrag() {
        const handle = document.getElementById('isc-drag-handle');
        const card = this.cardEl;
        if (!handle || !card) return;

        let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, moved = false;
        const onMove = (e) => {
            if (!this._dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
            const r = card.getBoundingClientRect();
            const left = clamp(baseLeft + dx, 8, Math.max(8, window.innerWidth - r.width - 8));
            const top = clamp(baseTop + dy, 8, Math.max(8, window.innerHeight - r.height - 8));
            card.style.setProperty('--isc-x', (left - baseLeft) + 'px');
            card.style.setProperty('--isc-y', (top - baseTop) + 'px');
            this._dragPos = { left, top };
        };
        const onUp = () => {
            if (!this._dragging) return;
            this._dragging = false;
            card.classList.remove('isc-dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            const pos = this._dragPos;
            card.style.setProperty('--isc-x', '0px');
            card.style.setProperty('--isc-y', '0px');
            if (pos && moved) {
                card.style.left = pos.left + 'px';
                card.style.top = pos.top + 'px';
                card.style.right = 'auto';
                this.#savePos(pos.left, pos.top);
            }
            this._dragPos = null;
        };

        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;   // 标题栏按钮不触发拖动
            const r = card.getBoundingClientRect();
            this._dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            baseLeft = r.left;
            baseTop = r.top;
            // 立即把当前位置固定为 left/top 基准（首次拖动时从默认的 right 定位切换到 left 定位）
            card.style.left = r.left + 'px';
            card.style.top = r.top + 'px';
            card.style.right = 'auto';
            card.classList.add('isc-dragging');
            try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });

        // 双击标题栏 → 复位到默认位置
        handle.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            card.style.left = '';
            card.style.top = '';
            card.style.right = '20px';
            card.style.top = '76px';
            try { localStorage.removeItem(this.#posKey()); } catch { /* ignore */ }
            this.#toast('已复位卡片位置');
        });
    }

    // ==================== 小工具 ====================

    #flashChange(change) {
        const row = this.bodyEl?.querySelector(`.isc-row[data-key="${change.key}"]`);
        if (!row) return;
        row.classList.remove('isc-flash');
        void row.offsetWidth;   // 重启动画
        row.classList.add('isc-flash');
        const delta = row.querySelector('.isc-delta');
        if (delta) delta.remove();
        const span = document.createElement('span');
        if (change.type === 'number' && Number.isFinite(change.delta) && change.delta !== 0) {
            span.className = `isc-delta ${change.delta > 0 ? 'up' : 'down'}`;
            span.textContent = `${change.delta > 0 ? '+' : ''}${change.delta}`;
        } else {
            span.className = 'isc-delta neutral';
            span.textContent = '更新';
        }
        row.appendChild(span);
        setTimeout(() => span.remove(), 1700);
    }

    #updateCollapseIcon() {
        const btn = document.getElementById('isc-collapse');
        if (!btn) return;
        const collapsed = this.cardEl?.dataset.collapsed === 'true';
        btn.innerHTML = `<i class="fas fa-chevron-${collapsed ? 'down' : 'up'}"></i>`;
    }

    #topicLabel(chat) {
        if (!chat || !Array.isArray(chat.topics)) return '当前话题';
        const idx = chat.currentTopicIndex;
        const topic = (idx === null || idx === undefined) ? null : chat.topics[idx];
        if (!topic) return '当前话题';
        return topic.name || `话题 ${(idx ?? 0) + 1}`;
    }

    #timeAgo(ts) {
        const diff = Date.now() - Number(ts || 0);
        if (!Number.isFinite(diff) || diff < 0) return '';
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
        return `${Math.floor(diff / 86400000)} 天前`;
    }

    #esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    #toast(msg) {
        const mm = this.getModalManager ? this.getModalManager() : null;
        if (mm && typeof mm.showBriefToast === 'function') mm.showBriefToast(msg);
    }
}

export default StatePanel;
