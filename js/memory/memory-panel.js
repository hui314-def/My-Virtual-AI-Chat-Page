// 记忆管理面板：记忆开关、统计、记忆列表(活跃/归档)、编辑/删除/固定/恢复、手动添加、三类日志。
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';
import { MemoryLifecycle } from './memory-lifecycle.js';
import { escapeHtml } from '../core/utils.js';

const CATEGORY_LABELS = {
    user_pref: '偏好',
    relationship: '关系',
    event: '事件',
    goal: '目标',
    fact: '事实',
};

export class MemoryPanel {
    /**
     * @param {Object} deps
     * @param {() => Object} deps.getMemoryRepo MemoryRepository
     * @param {() => number|string|null} deps.getCurrentChatId
     * @param {() => Array} deps.getChats 用于解析 chatId → 角色名
     * @param {Function} deps.getContainerEl 惰性获取渲染容器(#memory-panel-container,位于全局设置弹窗,模板运行时注入)
     */
    constructor({ getMemoryRepo, getCurrentChatId, getChats, getContainerEl }) {
        this.getMemoryRepo = getMemoryRepo;
        this.getCurrentChatId = getCurrentChatId;
        this.getChats = getChats || (() => []);
        this.getContainerEl = getContainerEl;
        this._logTab = 'extract';   // 'extract' | 'hit' | 'inject'
        this._listTab = 'active';   // 'active' | 'archived'
        this._filter = 'chat';      // 'chat'(当前角色) | 'global' | 'all'
        this._showAddForm = false;
    }

    /** 惰性获取渲染容器 #memory-panel-container(位于全局设置弹窗,模板在 init() 中注入) */
    get containerEl() {
        return this.getContainerEl ? this.getContainerEl() : null;
    }

    async refresh() {
        if (!this.containerEl) return;
        const repo = this.getMemoryRepo();
        let memories = [], archived = [], extractLogs = [], hitLogs = [], injectLogs = [];
        try {
            [memories, archived, extractLogs, hitLogs, injectLogs] = await Promise.all([
                repo.loadAllMemories(),
                repo.loadArchived(),
                repo.loadEvents('extract', 50),
                repo.loadEvents('hit', 50),
                repo.loadEvents('inject', 50),
            ]);
        } catch (err) {
            console.warn('[MemoryPanel] 读取失败：', err);
            this.containerEl.innerHTML = `<div style="padding:12px;color:var(--danger);">记忆数据读取失败：${escapeHtml(err.message || err)}</div>`;
            return;
        }
        this._memories = memories;
        this._archived = archived;
        this._extractLogs = extractLogs;
        this._hitLogs = hitLogs;
        this._injectLogs = injectLogs;

        // 按域筛选(当前角色 / 全局 / 全部)
        const visibleMemories = this.#filterByScope(memories);
        const visibleArchived = this.#filterByScope(archived);
        this._visibleMemories = visibleMemories;
        this._visibleArchived = visibleArchived;

        const activeCount = visibleMemories.filter(m => m.state === 'active').length;
        const dormantCount = visibleMemories.filter(m => m.state === 'dormant').length;
        const totalCount = visibleMemories.length + visibleArchived.length;
        const enabled = SettingsManager.getMemoryEnabled();

        this.containerEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:12px;">
                <!-- 开关 -->
                <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-card-soft);border-radius:12px;padding:10px 14px;">
                    <div>
                        <div style="color:var(--text-secondary);font-size:0.85rem;">启用长期记忆</div>
                        <div style="color:var(--text-dim);font-size:0.72rem;">关闭后停止提取与注入，已保存的记忆保留</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="memory-enabled-toggle" ${enabled ? 'checked' : ''}>
                        <span class="slider round"></span>
                    </label>
                </div>

                <!-- 统计 -->
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    ${this.#statCard('总数', totalCount)}
                    ${this.#statCard('活跃', activeCount, 'var(--accent)')}
                    ${this.#statCard('休眠', dormantCount, 'var(--text-dim)')}
                    ${this.#statCard('归档', archived.length, 'var(--text-dim)')}
                </div>

                <!-- 手动添加 -->
                <div style="text-align:right;">
                    <button id="memory-add-btn" style="background:rgba(79,124,255,0.2);color:#9fb6ff;border:1px solid rgba(79,124,255,0.4);border-radius:10px;padding:5px 14px;font-size:0.75rem;cursor:pointer;">➕ 手动添加记忆</button>
                </div>
                ${this._showAddForm ? this.#renderAddForm() : ''}

                <!-- 记忆域筛选(角色隔离) -->
                <div style="display:flex;gap:8px;align-items:center;">
                    <span style="font-size:0.7rem;color:var(--text-dim);">记忆范围：</span>
                    <button class="memory-scope-tab" data-scope="chat" style="${this.#scopeTabStyle('chat')}">当前角色</button>
                    <button class="memory-scope-tab" data-scope="global" style="${this.#scopeTabStyle('global')}">🌐 全局</button>
                    <button class="memory-scope-tab" data-scope="all" style="${this.#scopeTabStyle('all')}">全部</button>
                </div>

                <!-- 记忆列表 tab(活跃/归档) -->
                <div style="display:flex;gap:8px;margin-bottom:6px;">
                    <button class="memory-list-tab" data-tab="active" style="${this.#listTabStyle('active')}">活跃/休眠(${visibleMemories.length})</button>
                    <button class="memory-list-tab" data-tab="archived" style="${this.#listTabStyle('archived')}">归档(${visibleArchived.length})</button>
                </div>
                <div id="memory-list-body" style="max-height:240px;overflow-y:auto;">${this.#renderList()}</div>

                <!-- 日志 -->
                <div>
                    <div style="display:flex;gap:8px;margin-bottom:6px;">
                        <button class="memory-log-tab" data-tab="extract" style="${this.#logTabStyle('extract')}">提取(${extractLogs.length})</button>
                        <button class="memory-log-tab" data-tab="hit" style="${this.#logTabStyle('hit')}">命中(${hitLogs.length})</button>
                        <button class="memory-log-tab" data-tab="inject" style="${this.#logTabStyle('inject')}">注入(${injectLogs.length})</button>
                    </div>
                    <div id="memory-log-body" style="max-height:200px;overflow-y:auto;">${this.#renderLogs()}</div>
                </div>
            </div>
        `;

        this.#bind();
    }

    #bind() {
        const toggle = this.containerEl.querySelector('#memory-enabled-toggle');
        toggle?.addEventListener('change', (e) => {
            SettingsManager.update({ memoryEnabled: !!e.target.checked });
            this.refresh();
        });

        this.containerEl.querySelectorAll('.memory-list-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._listTab = btn.getAttribute('data-tab');
                this.refresh();
            });
        });

        this.containerEl.querySelectorAll('.memory-scope-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._filter = btn.getAttribute('data-scope');
                this.refresh();
            });
        });

        this.containerEl.querySelectorAll('.memory-log-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this._logTab = btn.getAttribute('data-tab');
                this.containerEl.querySelectorAll('.memory-log-tab').forEach(b => b.style.cssText = this.#logTabStyle(b.getAttribute('data-tab')));
                const body = this.containerEl.querySelector('#memory-log-body');
                if (body) body.innerHTML = this.#renderLogs();
            });
        });

        const addBtn = this.containerEl.querySelector('#memory-add-btn');
        addBtn?.addEventListener('click', () => {
            this._showAddForm = !this._showAddForm;
            this.refresh();
        });

        // 手动添加表单
        this.containerEl.querySelector('#memory-add-confirm')?.addEventListener('click', () => this.#addMemory());
        this.containerEl.querySelector('#memory-add-cancel')?.addEventListener('click', () => { this._showAddForm = false; this.refresh(); });

        // 列表操作按钮(事件委托)
        this.containerEl.querySelectorAll('[data-mem-action]').forEach(el => {
            el.addEventListener('click', () => this.#handleAction(el));
        });
    }

    async #handleAction(el) {
        const action = el.getAttribute('data-mem-action');
        const id = el.getAttribute('data-mem-id');
        const repo = this.getMemoryRepo();
        const memory = this._memories.find(m => m.id === id);
        const archived = this._archived.find(m => m.id === id);
        try {
            if (action === 'edit' && memory) {
                const newContent = prompt('编辑记忆内容：', memory.content);
                if (newContent === null) return;
                if (!newContent.trim()) return;
                memory.content = newContent.trim();
                memory.updatedAt = Date.now();
                await repo.saveMemory(memory);
            } else if (action === 'delete' && memory) {
                if (!confirm(`确定删除记忆「${memory.content}」吗？`)) return;
                await repo.deleteMemory(id);
            } else if (action === 'pin' && memory) {
                memory.pinned = !memory.pinned;
                memory.resident = memory.pinned;   // 固定 = 常驻(不衰减、必注入)
                memory.updatedAt = Date.now();
                await repo.saveMemory(memory);
            } else if (action === 'restore' && archived) {
                const revived = MemoryLifecycle.wakeUp(archived);
                await repo.saveMemory(revived);
                await repo.deleteArchived(id);
            } else if (action === 'delete-archived' && archived) {
                if (!confirm(`确定永久删除归档记忆「${archived.content}」吗？`)) return;
                await repo.deleteArchived(id);
            }
        } catch (err) {
            console.warn('[MemoryPanel] 操作失败：', err);
            alert('操作失败：' + (err.message || err));
        }
        this.refresh();
    }

    async #addMemory() {
        const content = this.containerEl.querySelector('#memory-add-content')?.value?.trim();
        if (!content) { alert('请输入记忆内容'); return; }
        const scope = this.containerEl.querySelector('#memory-add-scope')?.value || 'chat';
        const chatId = scope === 'global' ? 'global' : this.getCurrentChatId();
        const category = this.containerEl.querySelector('#memory-add-category')?.value || 'fact';
        const entitiesRaw = this.containerEl.querySelector('#memory-add-entities')?.value || '';
        const entities = entitiesRaw.split(/[,，\s]+/).filter(Boolean);
        const repo = this.getMemoryRepo();
        const record = {
            id: (crypto.randomUUID && crypto.randomUUID()) || `mem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            chatId,
            category,
            content,
            entities,
            importance: 3,
            intrinsicValue: 1.2,
            activation: 50,
            state: 'active',
            userSilence: 0,
            modelSilence: 0,
            recentUserHits: [],
            resident: false,
            pinned: false,
            sourceMsgIds: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null,
            supersededBy: null,
        };
        try {
            await repo.saveMemory(record);
            await repo.addEvent({
                id: `ev_${Date.now()}_manual`,
                kind: 'extract',
                time: Date.now(),
                chatId,
                detail: { action: 'new', content, category, manual: true, scope },
            });
        } catch (err) {
            console.warn('[MemoryPanel] 添加失败：', err);
            alert('添加失败：' + (err.message || err));
        }
        this._showAddForm = false;
        this.refresh();
    }

    // ==================== 渲染 ====================

    #renderAddForm() {
        return `<div style="background:var(--bg-card-soft);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;">
            <input id="memory-add-content" type="text" placeholder="记忆内容，例如：用户讨厌香菜" style="background:var(--bg-input);border:1px solid var(--border-default);border-radius:8px;padding:6px 10px;color:var(--text-secondary);font-size:0.8rem;">
            <div style="display:flex;gap:8px;">
                <select id="memory-add-scope" style="flex:1;background:var(--bg-input);border:1px solid var(--border-default);border-radius:8px;padding:6px;color:var(--text-secondary);font-size:0.78rem;">
                    <option value="chat">归属：当前角色</option>
                    <option value="global">归属：🌐 全局记忆</option>
                </select>
                <select id="memory-add-category" style="flex:1;background:var(--bg-input);border:1px solid var(--border-default);border-radius:8px;padding:6px;color:var(--text-secondary);font-size:0.78rem;">
                    <option value="fact">事实</option>
                    <option value="user_pref">偏好</option>
                    <option value="relationship">关系</option>
                    <option value="event">事件</option>
                    <option value="goal">目标</option>
                </select>
                <input id="memory-add-entities" type="text" placeholder="实体词(逗号分隔)" style="flex:2;background:var(--bg-input);border:1px solid var(--border-default);border-radius:8px;padding:6px 10px;color:var(--text-secondary);font-size:0.8rem;">
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="memory-add-cancel" style="background:rgba(60,64,90,0.6);color:var(--text-dim);border:none;border-radius:8px;padding:5px 14px;font-size:0.75rem;cursor:pointer;">取消</button>
                <button id="memory-add-confirm" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:0.75rem;cursor:pointer;">添加</button>
            </div>
        </div>`;
    }

    #renderList() {
        if (this._listTab === 'archived') {
            if (this._visibleArchived.length === 0) return '<div style="color:var(--text-dim);font-size:0.78rem;padding:8px 0;">暂无归档记忆。</div>';
            return this._visibleArchived.map(m => this.#archivedItem(m)).join('');
        }
        if (this._visibleMemories.length === 0) return '<div style="color:var(--text-dim);font-size:0.78rem;padding:8px 0;">暂无记忆。发送消息后系统会自动提取值得记住的事实。</div>';
        return this._visibleMemories.map(m => this.#memoryItem(m)).join('');
    }

    #memoryItem(m) {
        const cat = CATEGORY_LABELS[m.category] || m.category || '事实';
        const entities = (m.entities || []).map(e => `#${escapeHtml(e)}`).join(' ');
        const stateLabel = m.state === 'active' ? '● 活跃' : '○ 休眠';
        const stateColor = m.state === 'active' ? '#7fd8a0' : '#c9b66a';
        const pinTag = m.pinned ? '📌' : '';
        return `<div style="background:var(--bg-card-soft);border-radius:10px;padding:8px 10px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
                <span style="font-size:0.68rem;color:#4f7cff;background:rgba(79,124,255,0.15);border-radius:8px;padding:1px 7px;">${cat}</span>
                ${this.#sourceLabel(m)}
                <span style="font-size:0.68rem;color:${stateColor};">${stateLabel}</span>
                <span style="font-size:0.68rem;color:var(--text-dim);">A=${Math.round(m.activation || 0)}</span>
                <span style="margin-left:auto;display:flex;gap:6px;">
                    <button data-mem-action="pin" data-mem-id="${m.id}" title="${m.pinned ? '取消固定' : '固定'}" style="background:none;border:none;cursor:pointer;font-size:0.8rem;">${pinTag || '📌'}</button>
                    <button data-mem-action="edit" data-mem-id="${m.id}" title="编辑" style="background:none;border:none;cursor:pointer;font-size:0.8rem;">✏️</button>
                    <button data-mem-action="delete" data-mem-id="${m.id}" title="删除" style="background:none;border:none;cursor:pointer;font-size:0.8rem;">🗑️</button>
                </span>
            </div>
            <div style="font-size:0.8rem;color:var(--text-secondary);line-height:1.4;">${escapeHtml(m.content)}</div>
            ${entities ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px;">${entities}</div>` : ''}
        </div>`;
    }

    #archivedItem(m) {
        return `<div style="background:var(--bg-card-soft);border-radius:10px;padding:8px 10px;">
            <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:0.68rem;color:var(--text-dim);">❄ 归档</span>
                ${this.#sourceLabel(m)}
                <span style="margin-left:auto;display:flex;gap:6px;">
                    <button data-mem-action="restore" data-mem-id="${m.id}" title="恢复" style="background:none;border:none;cursor:pointer;font-size:0.8rem;">♻️</button>
                    <button data-mem-action="delete-archived" data-mem-id="${m.id}" title="永久删除" style="background:none;border:none;cursor:pointer;font-size:0.8rem;">🗑️</button>
                </span>
            </div>
            <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.4;">${escapeHtml(m.content)}</div>
        </div>`;
    }

    #listTabStyle(tab) {
        const active = this._listTab === tab;
        return `background:${active ? 'var(--accent)' : 'var(--bg-card-soft)'};color:${active ? '#fff' : 'var(--text-dim)'};border:none;border-radius:10px;padding:4px 12px;font-size:0.72rem;cursor:pointer;`;
    }

    #scopeTabStyle(scope) {
        const active = this._filter === scope;
        return `background:${active ? 'var(--accent)' : 'var(--bg-card-soft)'};color:${active ? '#fff' : 'var(--text-dim)'};border:none;border-radius:10px;padding:4px 12px;font-size:0.72rem;cursor:pointer;`;
    }

    /** 按记忆域筛选:当前角色 / 全局 / 全部 */
    #filterByScope(records) {
        const cid = String(this.getCurrentChatId());
        if (this._filter === 'global') {
            return (records || []).filter(m => m && (m.chatId === 'global' || m.chatId == null));
        }
        if (this._filter === 'all') return records || [];
        return (records || []).filter(m => m && (m.chatId === 'global' || m.chatId == null || String(m.chatId) === cid));
    }

    /** 记忆来源标注:🌐 全局 或 角色名 */
    #sourceLabel(m) {
        if (m && (m.chatId === 'global' || m.chatId == null)) {
            return `<span style="font-size:0.66rem;color:#b7a6ff;background:rgba(183,166,255,0.12);border-radius:8px;padding:1px 7px;">🌐 全局</span>`;
        }
        const chat = this.getChats().find(c => String(c.id) === String(m?.chatId));
        const name = chat?.settings?.roleName || chat?.title || '角色';
        return `<span style="font-size:0.66rem;color:#8ec9ff;background:rgba(142,201,255,0.12);border-radius:8px;padding:1px 7px;">${escapeHtml(name)}</span>`;
    }

    #logTabStyle(tab) {
        const active = this._logTab === tab;
        return `background:${active ? 'var(--accent)' : 'var(--bg-card-soft)'};color:${active ? '#fff' : 'var(--text-dim)'};border:none;border-radius:10px;padding:4px 12px;font-size:0.72rem;cursor:pointer;`;
    }

    #renderLogs() {
        const map = { extract: this._extractLogs, hit: this._hitLogs, inject: this._injectLogs };
        const logs = map[this._logTab] || [];
        if (logs.length === 0) return '<div style="color:var(--text-dim);font-size:0.78rem;padding:8px 0;">暂无记录。</div>';
        const renderer = { extract: this.#extractLogItem, hit: this.#hitLogItem, inject: this.#injectLogItem }[this._logTab];
        return logs.map(l => renderer.call(this, l)).join('');
    }

    #statCard(label, value, color = 'var(--text-dim)') {
        return `<div style="flex:1;min-width:60px;background:var(--bg-card-soft);border-radius:12px;padding:10px;text-align:center;">
            <div style="font-size:1.3rem;font-weight:600;color:${color};">${value}</div>
            <div style="font-size:0.7rem;color:var(--text-dim);">${label}</div>
        </div>`;
    }

    #extractLogItem(l) {
        const d = l.detail || {};
        const actionLabel = { new: '➕ 新建', dup: '⏭ 去重', fail: '⚠ 失败', none: '— 无事实' }[d.action] || d.action || '';
        const color = d.action === 'fail' ? 'var(--danger)' : 'var(--text-dim)';
        const time = new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false });
        const text = d.content ? escapeHtml(d.content) : (d.message || d.error || '');
        return `<div style="font-size:0.72rem;color:${color};padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="color:var(--text-dim);">[${time}]</span> ${actionLabel} ${text}
        </div>`;
    }

    #hitLogItem(l) {
        const d = l.detail || {};
        const time = new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false });
        const injected = d.injected ? ' → 已注入' : '';
        return `<div style="font-size:0.72rem;color:#9fd6ff;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="color:var(--text-dim);">[${time}]</span> 🎯 命中(${d.method || 'L1'}) ${escapeHtml(d.content || '')}${injected}
        </div>`;
    }

    #injectLogItem(l) {
        const d = l.detail || {};
        const time = new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false });
        const preview = (d.contents || []).map(c => escapeHtml(c)).join('；');
        return `<div style="font-size:0.72rem;color:#b7f0c0;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="color:var(--text-dim);">[${time}]</span> 💉 注入 ${d.count || 0} 条：${preview}
        </div>`;
    }
}

export default MemoryPanel;
