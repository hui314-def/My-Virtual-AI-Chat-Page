// ============================================================
// QQ 接入 · 「个性化设置 → QQ 接入」面板
// ------------------------------------------------------------
// 需求对应关系：
//   ① 开启接入 + 选择一个角色接入      → 本面板顶部开关与角色下拉
//   ② 继承原角色名称与模型参数          → qq-bridge-client 按 ROLE_LEVEL_KEYS 解析后推送
//   ③ 可选知识库 / 语音合成             → 本面板两个开关（与角色绑定保存）
//
// 面板只做两件事：把用户的选择存进 localStorage、把解析好的配置推给后端桥接服务。
// 真正的"回话"发生在后端，网页关掉也不影响（只要后端跑着）。
// ============================================================

export class QQSettings {
    /**
     * @param {Object} deps
     * @param {Object} deps.bridge        QQBridgeClient 实例
     * @param {() => Array} deps.getChats 取会话列表（角色下拉的数据源）
     * @param {Object} deps.modalManager  用于懒加载知识库列表
     */
    constructor({ bridge, getChats, modalManager }) {
        this.bridge = bridge;
        this.getChats = getChats;
        this.modalManager = modalManager;
        this._bound = false;
        this._statusTimer = null;
    }

    // ---------- 渲染 ----------

    /** 渲染整个面板（HTML 是固定的，这里只填数据 + 绑事件） */
    async render() {
        const pane = document.getElementById('tab-qq');
        if (!pane) return;

        this._renderChatOptions();
        await this._renderKnowledgeOptions();

        const cfg = this.bridge.readConfig();
        this._setValue('qq-enabled', !!cfg.enabled);
        this._setValue('qq-role', cfg.sourceChatId ?? '');
        this._setValue('qq-knowledge-enabled', !!cfg.knowledgeEnabled);
        this._setValue('qq-tts-enabled', !!cfg.ttsEnabled);
        this._setValue('qq-cooldown', this._num(cfg.cooldownSec, 10));
        this._setValue('qq-global-cooldown', this._num(cfg.globalCooldownSec, 3));
        this._setValue('qq-quota', this._num(cfg.hourlyQuota, 60));
        this._setValue('qq-probability', Math.round(this._num(cfg.probability, 0.25) * 100));
        // 分条发送：旧字段（maxRepliesPerMessage / replySplitChars）作为缺失时的回退
        this._setValue('qq-split-chars', this._num(cfg.replyPartMaxChars, this._num(cfg.replySplitChars, 80)));
        this._setValue('qq-parts-max', this._num(cfg.replyPartsMax, 3));
        this._setValue('qq-part-delay', this._num(cfg.partSendDelayMs, 400));
        this._setValue('qq-mention-bypass', cfg.mentionBypass !== false);
        // 互动行为：引用回复 / 戳一戳
        this._setValue('qq-reply-enabled', cfg.replyEnabled !== false);
        this._setValue('qq-reply-show-original', cfg.replyShowOriginal !== false);
        this._setValue('qq-poke-enabled', cfg.pokeEnabled !== false);
        this._setValue('qq-poke-cooldown', this._num(cfg.pokeCooldownSec, 60));
        this._setValue('qq-poke-quota', this._num(cfg.pokeHourlyQuota, 20));
        this._setValue('qq-poke-content', cfg.pokeContent || '');
        this._setValue('qq-poke-back', !!cfg.sendPokeBack);

        this._checkKnowledgeBoxes(Array.isArray(cfg.knowledgeIds) ? cfg.knowledgeIds : []);
        this._applyEnabledState();
        this._bind();
        this.refreshStatus();
    }

    /** 角色下拉：列出所有「单聊」会话（群聊会话本身没有单一角色，排除掉） */
    _renderChatOptions() {
        const sel = document.getElementById('qq-role');
        if (!sel) return;
        const chats = (this.getChats() || []).filter(c => c && c.kind !== 'group');
        const prev = sel.value;

        sel.innerHTML = '<option value="">— 请选择要接入 QQ 的角色 —</option>' + chats.map(c => {
            const name = (c.settings && c.settings.roleName) || c.title || '未命名';
            const title = c.title || '';
            const label = title && title !== name ? `${name}（${title}）` : name;
            return `<option value="${this._esc(c.id)}">${this._esc(label)}</option>`;
        }).join('');

        if (prev) sel.value = prev;
        if (!chats.length) {
            sel.innerHTML = '<option value="">— 还没有可选角色，请先新建一个对话 —</option>';
        }
    }

    /** 知识库多选：与网页「知识库」页签共用同一份列表 */
    async _renderKnowledgeOptions() {
        const box = document.getElementById('qq-knowledge-list');
        if (!box) return;
        box.innerHTML = '<div style="font-size:0.8rem;color:#8b93b0;">加载中…</div>';

        let bases = [];
        try {
            const kb = this.modalManager && this.modalManager.kbManager;
            if (kb) {
                // 复用网页知识库管理器的缓存：它已加载过就直接用，
                // 没加载过就触发一次加载（ensure 内部有懒加载标志，不会重复请求）。
                if (Array.isArray(kb.kbListCache)) {
                    bases = kb.kbListCache;
                } else {
                    if (typeof kb.ensureKnowledgeBaseLoaded === 'function') await kb.ensureKnowledgeBaseLoaded();
                    bases = Array.isArray(kb.kbListCache) ? kb.kbListCache : [];
                }
            }
        } catch (err) {
            console.warn('[QQ] 知识库列表加载失败：', err);
        }

        if (!bases.length) {
            box.innerHTML = '<div style="font-size:0.8rem;color:#8b93b0;">'
                + '未读取到知识库。请确认「知识库服务（端口 5051）」已启动，'
                + '并已前往「个性化设置 → 知识库」创建。</div>';
            return;
        }

        const cfg = this.bridge.readConfig();
        const selected = Array.isArray(cfg.knowledgeIds) ? cfg.knowledgeIds : [];
        box.innerHTML = bases.map(b => {
            const id = b.id || b.kb_id || b.name;
            const name = b.name || b.kb_name || id;
            const checked = selected.some(s => String(s) === String(id)) ? ' checked' : '';
            return `<label style="display:block;margin:2px 0;font-weight:normal;cursor:pointer;">`
                + `<input type="checkbox" class="qq-kb-item" value="${this._esc(id)}"${checked}> ${this._esc(name)}</label>`;
        }).join('');
    }

    _checkKnowledgeBoxes(ids) {
        document.querySelectorAll('.qq-kb-item').forEach(el => {
            el.checked = ids.some(s => String(s) === String(el.value));
        });
    }

    /** 开关关闭时，把该开关控制的那组设置灰掉——避免"看起来生效其实没生效" */
    _applyEnabledState() {
        const enabled = this._checked('qq-enabled');
        const roleRow = document.getElementById('qq-role-row');
        if (roleRow) {
            roleRow.style.opacity = enabled ? '1' : '0.5';
            roleRow.style.pointerEvents = enabled ? '' : 'none';
        }
        const optGroup = document.getElementById('qq-optional-group');
        if (optGroup) optGroup.style.display = enabled ? '' : 'none';
        const advGroup = document.getElementById('qq-advanced-group');
        if (advGroup) advGroup.style.display = enabled ? '' : 'none';
    }

    // ---------- 事件绑定 ----------

    _bind() {
        if (this._bound) return;
        this._bound = true;

        const on = (id, evt, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(evt, fn);
        };

        on('qq-enabled', 'change', () => {
            this._applyEnabledState();
            this.saveAndPush();
        });
        on('qq-role', 'change', () => this.saveAndPush());
        on('qq-knowledge-enabled', 'change', () => this.saveAndPush('knowledgeIds'));
        on('qq-tts-enabled', 'change', () => this.saveAndPush());

        // 知识库勾选是动态渲染的 → 用事件委托，避免每次重渲染都重新绑定
        const kbList = document.getElementById('qq-knowledge-list');
        if (kbList) {
            kbList.addEventListener('change', (e) => {
                if (e.target && e.target.classList.contains('qq-kb-item')) {
                    this.saveAndPush();
                }
            });
        }

        // 触发策略：数字输入用 change（不用 input，免得打字中途就推送）
        ['qq-cooldown', 'qq-global-cooldown', 'qq-quota', 'qq-probability',
            'qq-split-chars', 'qq-parts-max', 'qq-part-delay'].forEach(id => {
            on(id, 'change', () => this.saveAndPush());
        });
        on('qq-mention-bypass', 'change', () => this.saveAndPush());

        // 互动行为：引用回复 / 戳一戳
        ['qq-reply-enabled', 'qq-reply-show-original',
            'qq-poke-enabled', 'qq-poke-back'].forEach(id => {
            on(id, 'change', () => this.saveAndPush());
        });
        ['qq-poke-cooldown', 'qq-poke-quota'].forEach(id => {
            on(id, 'change', () => this.saveAndPush());
        });
        // 文本框用 change（失焦/回车才推送），避免每敲一个字就发一次配置
        on('qq-poke-content', 'change', () => this.saveAndPush());

        on('qq-push-btn', 'click', () => this.saveAndPush(true));
        on('qq-refresh-btn', 'click', () => this.refreshStatus());
    }

    // ---------- 保存与推送 ----------

    /** 把面板上的值存进 localStorage，然后推给后端。 */
    async saveAndPush(showToast) {
        const ids = [];
        document.querySelectorAll('.qq-kb-item').forEach(el => { if (el.checked) ids.push(el.value); });

        this.bridge.writeConfig({
            enabled: this._checked('qq-enabled'),
            sourceChatId: this._value('qq-role') || null,
            knowledgeEnabled: this._checked('qq-knowledge-enabled'),
            knowledgeIds: ids,
            ttsEnabled: this._checked('qq-tts-enabled'),
            cooldownSec: this._toNum('qq-cooldown', 10),
            globalCooldownSec: this._toNum('qq-global-cooldown', 3),
            hourlyQuota: this._toNum('qq-quota', 60),
            probability: this._toNum('qq-probability', 25) / 100,
            replyPartMaxChars: this._toNum('qq-split-chars', 80),
            replyPartsMax: this._toNum('qq-parts-max', 3),
            partSendDelayMs: this._toNum('qq-part-delay', 400),
            mentionBypass: this._checked('qq-mention-bypass'),
            replyEnabled: this._checked('qq-reply-enabled'),
            replyShowOriginal: this._checked('qq-reply-show-original'),
            pokeEnabled: this._checked('qq-poke-enabled'),
            pokeCooldownSec: this._toNum('qq-poke-cooldown', 60),
            pokeHourlyQuota: this._toNum('qq-poke-quota', 20),
            pokeContent: this._value('qq-poke-content') || '',
            sendPokeBack: this._checked('qq-poke-back'),
        });

        const res = await this.bridge.push();
        this._lastPayload = res.payload;
        this.refreshStatus();

        if (showToast) {
            const msg = res.ok
                ? `配置已推送${res.detail && res.detail !== 'ok' ? '（' + res.detail + '）' : ''}`
                : `推送失败：${res.detail}`;
            this._toast(msg, res.ok);
        }
    }

    /** 立刻推一次（打开面板时用，保证网页侧的最新角色设定被送到后端） */
    async pushNow() {
        const res = await this.bridge.push();
        this._lastPayload = res.payload;
        return res;
    }

    // ---------- 状态展示 ----------

    async refreshStatus() {
        const box = document.getElementById('qq-status');
        if (!box) return;
        box.innerHTML = '<span style="color:#b7c4ff;"><i class="fas fa-spinner fa-pulse"></i> 读取运行状态…</span>';

        const rt = await this.bridge.runtime();
        const cfg = this.bridge.readConfig();

        if (!rt.ok) {
            box.innerHTML = `<div style="color:#ffb46c;"><b>未连接到桥接服务</b></div>`
                + `<div style="font-size:0.8rem;margin-top:4px;color:#8b93b0;">`
                + `地址：<code>${this._esc(this.bridge.apiBase)}</code> · ${this._esc(rt.error || '')}<br>`
                + `请先启动后端服务：<code>python backend_code/qq_bot/qq_bot_api.py</code>（端口 5052）`
                + `</div>`;
            return;
        }

        const online = rt.online
            ? `<span style="color:#78e0a1;">● 协议端已连接</span>`
            : `<span style="color:#ff8f8f;">● 协议端未连接</span>`;
        const ready = rt.ready
            ? `<span style="color:#78e0a1;">● 配置就绪</span>`
            : `<span style="color:#ffb46c;">● 未就绪：${this._esc(rt.readyDetail || '')}</span>`;
        const stats = rt.stats || {};
        const dropped = stats.dropped || {};
        const dropText = Object.keys(dropped).length
            ? Object.entries(dropped).map(([k, v]) => `${this._dropLabel(k)} ${v}`).join(' · ')
            : '无';

        box.innerHTML = `
            <div style="margin-bottom:4px;">${online} &nbsp; ${ready}</div>
            <div style="font-size:0.8rem;color:#8b93b0;">
                角色：<b>${this._esc(rt.roleName || '未选择')}</b>
                · 模型：<code>${this._esc(rt.modelName || '—')}</code>
                ${rt.selfId ? `· 机器人 QQ：${this._esc(rt.selfId)}` : ''}
            </div>
            <div style="font-size:0.8rem;color:#8b93b0;margin-top:2px;">
                已接收 ${stats.seen || 0} 条 · 已回复 ${stats.replied || 0} 条
                · 被拦下：${this._esc(dropText)}
            </div>
            <div style="font-size:0.78rem;color:#6f7794;margin-top:2px;">
                配置推送：${rt.pushCount || 0} 次
                ${cfg.lastPushAt ? `· 最近成功推送 ${this._ago(cfg.lastPushAt)}` : ''}
            </div>
            ${(rt.logs && rt.logs.length) ? this._renderLogs(rt.logs) : ''}
        `;
    }

    _renderLogs(logs) {
        const lines = logs.slice(-8).map(l => {
            const color = l.level === 'error' ? '#ff8f8f' : (l.level === 'warn' ? '#ffb46c' : '#8b93b0');
            return `<div style="color:${color};">${this._esc(l.text)}</div>`;
        }).join('');
        return `<details style="margin-top:6px;">
            <summary style="cursor:pointer;font-size:0.8rem;color:#8b93b0;">桥接服务最近日志</summary>
            <div style="font-size:0.76rem;font-family:monospace;max-height:140px;overflow:auto;margin-top:4px;">${lines}</div>
        </details>`;
    }

    _dropLabel(key) {
        return {
            jitter: '随机抖动',
            cooldown: '同群冷却',
            global_cooldown: '全局冷却',
            quota: '小时配额',
        }[key] || key;
    }

    _ago(ts) {
        const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (sec < 60) return `${sec} 秒前`;
        if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
        if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
        return `${Math.floor(sec / 86400)} 天前`;
    }

    // ---------- 小工具 ----------

    _value(id) { const el = document.getElementById(id); return el ? el.value : ''; }
    _checked(id) { const el = document.getElementById(id); return !!(el && el.checked); }

    _setValue(id, v) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = (v === null || v === undefined) ? '' : v;
    }

    _toNum(id, fallback) {
        const n = Number(this._value(id));
        return Number.isFinite(n) ? n : fallback;
    }

    _num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    _esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 轻量提示：尽量复用网站既有的 toast（存在则用，不存在就静默） */
    _toast(text, ok) {
        try {
            const el = document.getElementById('toast') || document.querySelector('.toast');
            if (el) {
                el.textContent = text;
                el.style.background = ok ? 'rgba(60,160,110,0.92)' : 'rgba(180,70,70,0.92)';
                el.style.opacity = '1';
                clearTimeout(this._toastTimer);
                this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
                return;
            }
        } catch (err) { /* 忽略 */ }
        console.log(`[QQ] ${text}`);
    }
}
