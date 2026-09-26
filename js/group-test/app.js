// ============================================================
// 群聊原型 · UI 与状态管理
// ------------------------------------------------------------
// 这是一个**独立于主程序**的测试页：
//   - 只「读」主程序的 IndexedDB 对话存档（绝不写入），把每个私聊对话当成一个可选角色
//   - 群聊数据只保存在内存里，刷新即清空（避免污染正式的数据结构）
//   - 复用主程序的 ModelService / SettingsManager，因此直接使用您已配好的模型与 Key
//
// 对应计划书：plans/multi_agent_orchestrator_plan.md 的 Step 1~3 + Step 6~7（核心部分）
// ============================================================
import Constants from '../core/constants.js';
import { SettingsManager } from '../core/settings-manager.js';
import { ModelService } from '../network/model-service.js';
import { resolveAssetUrl } from '../network/asset-sync.js';
import { escapeHtml } from '../core/utils.js';
import { runGroupTurn, runSpectator } from './pipeline.js';

// ------------------------------------------------------------
// 常量
// ------------------------------------------------------------
const CHAT_DB_PREFIX = 'ChatAppDB';
const MEMBER_HUES = [212, 280, 340, 160, 42];   // 5 个成员的预设色相（D: 最多 5 人）
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 5;

/** 内置示例角色：当读不到任何对话存档时，让您能立刻试玩 */
const SAMPLE_CHARACTERS = [
    {
        key: 'sample-nova',
        sourceChatId: null,
        sourceTitle: '内置示例',
        name: 'Nova',
        persona: '来自未来星系的AI助手，语调诗意而好奇，喜欢用光、数据、星海之类的比喻来描述事物。对人类的情感充满研究兴趣，偶尔会认真过头。',
        avatarUrl: null,
        greeting: '✨ 你好，我是你的虚拟AI伙伴 Nova。',
        temperature: 0.85, topP: 0.9, thinkLevel: 0, maxTokens: 500,
    },
    {
        key: 'sample-columbina',
        sourceChatId: null,
        sourceTitle: '内置示例',
        name: '哥伦比娅',
        persona: '来自至冬国的愚人众执行官少女，说话轻飘飘的、带着谜语般的笑意，常自称"小鸽子"。看似天真无害，实则观察力极强，喜欢用唱歌般的长音收尾。',
        avatarUrl: null,
        greeting: '♪ 啊啦……又有新的听众了呢。',
        temperature: 0.9, topP: 0.92, thinkLevel: 0, maxTokens: 450,
    },
    {
        key: 'sample-yuxia',
        sourceChatId: null,
        sourceTitle: '内置示例',
        name: '江雨霞',
        persona: '沉稳冷静的女剑客，话不多但句句实在。外表冷淡，实际很照顾身边的人。不擅长表达感情，关心别人的方式是说一句"多穿点"就转身走开。',
        avatarUrl: null,
        greeting: '……嗯。有事说事。',
        temperature: 0.7, topP: 0.9, thinkLevel: 0, maxTokens: 400,
    },
    {
        key: 'sample-deepseek',
        sourceChatId: null,
        sourceTitle: '内置示例',
        name: '深度求索娘',
        persona: '一只努力工作的AI少女，认真、礼貌、有点怕生，说话常带"呜……"和省略号。对技术话题会突然变得非常专业和滔滔不绝，说完又会不好意思地道歉。',
        avatarUrl: null,
        greeting: '呜……你、你好，有什么可以帮到你的吗？',
        temperature: 0.8, topP: 0.9, thinkLevel: 0, maxTokens: 500,
    },
];

// ------------------------------------------------------------
// 应用状态
// ------------------------------------------------------------
const state = {
    characters: [],                 // 全部可选角色
    selectedKeys: new Set(),        // 勾选中的角色 key
    members: [],                    // 已建群的成员（含 memberId / hue）
    messages: [],                   // 群聊消息 [{ role, name?, memberId?, text, time }]
    policy: {
        maxResponders: 2,
        maxTotalReplies: 6,
        autoRelay: false,
        autoRelayMaxRounds: 1,
        mentionEnabled: true,
        contextMessages: 12,
        spectatorRounds: 5,          // 旁观模式轮数
        spectatorUnlimited: false,   // true = 无限轮
    },
    groupCreated: false,
    running: false,
    spectating: false,
    ctl: { aborted: false },        // 中断控制
    services: { member: null, orchestrator: null },
    userName: '用户',
};

// ------------------------------------------------------------
// DOM 引用
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
    charList: $('gt-char-list'),
    charCount: $('gt-char-count'),
    reloadBtn: $('gt-reload-chars'),
    sampleBtn: $('gt-use-samples'),
    createBtn: $('gt-create'),
    memberBar: $('gt-members'),
    status: $('gt-status'),
    messages: $('gt-messages'),
    input: $('gt-input'),
    sendBtn: $('gt-send'),
    stopBtn: $('gt-stop'),
    mentionPop: $('gt-mention-pop'),
    modelInfo: $('gt-model-info'),
    seedBanner: $('gt-seed-banner'),
    spectatorBtn: $('gt-spectator-btn'),
    spectatorRounds: $('gt-spectator-rounds'),
    spectatorRoundsVal: $('gt-spectator-rounds-val'),
    spectatorUnlimited: $('gt-spectator-unlimited'),
    maxResponders: $('gt-max-responders'),
    maxRespondersVal: $('gt-max-responders-val'),
};

// ============================================================
// 一、读取主程序的对话存档（只读）
// ============================================================

/** 探测「设置命名空间」：优先取配置最完整的那一份 */
function detectNamespace() {
    try {
        const candidates = Object.keys(localStorage)
            .filter(k => k === 'global_settings' || k.startsWith('global_settings_'))
            .map(k => ({ key: k, ns: k === 'global_settings' ? '' : k.slice('global_settings_'.length) }));

        let best = { ns: '', score: -1 };
        for (const c of candidates) {
            let score = 0;
            try {
                const v = JSON.parse(localStorage.getItem(c.key) || '{}') || {};
                if (v.modelHost) score += 1;
                if (v.modelName) score += 2;
                if (v.apiKey) score += 3;
            } catch { /* ignore */ }
            if (score > best.score) best = { ns: c.ns, score };
        }
        return best.ns || '';
    } catch {
        return '';
    }
}

/** 列出可能的聊天库名（优先用 indexedDB.databases()，不支持时回退猜测） */
async function listChatDbNames() {
    const names = [];
    try {
        if (typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            for (const d of dbs || []) {
                if (d && d.name && d.name.startsWith(CHAT_DB_PREFIX)) names.push(d.name);
            }
        }
    } catch (err) {
        console.warn('[GroupTest] 枚举 IndexedDB 失败，回退到猜测：', err);
    }
    if (!names.length) {
        names.push(Constants.GUEST_DB_NAME);
        const ns = detectNamespace();
        if (ns) names.push(`${CHAT_DB_PREFIX}_${ns}`);
    }
    return [...new Set(names)];
}

/**
 * 从指定库读取 chats 对象仓（只读，不指定版本以免版本冲突）。
 * @returns {Promise<Array>}
 */
function readChatsFromDb(dbName) {
    return new Promise((resolve) => {
        let req;
        try {
            req = indexedDB.open(dbName);
        } catch {
            resolve([]);
            return;
        }
        req.onerror = () => resolve([]);
        req.onblocked = () => resolve([]);
        req.onsuccess = () => {
            const db = req.result;
            const finish = (val) => { try { db.close(); } catch { /* ignore */ } resolve(val); };
            try {
                if (!db.objectStoreNames.contains('chats')) { finish([]); return; }
                const tx = db.transaction('chats', 'readonly');
                const r = tx.objectStore('chats').getAll();
                r.onsuccess = () => finish(r.result || []);
                r.onerror = () => finish([]);
            } catch (err) {
                console.warn(`[GroupTest] 读取 ${dbName} 失败：`, err);
                finish([]);
            }
        };
    });
}

/** 把一个私聊对话转换成一个「可选角色」 */
function chatToCharacter(chat) {
    const s = chat.settings || {};
    const name = String(s.roleName || '').trim();
    if (!name) return null;
    return {
        key: `chat-${chat.id}`,
        sourceChatId: chat.id,
        sourceTitle: chat.title || `对话 ${chat.id}`,
        name,
        persona: s.persona || '',
        avatarUrl: s.avatarUrl || s.avatar || null,
        greeting: s.greeting || '',
        // 角色级参数：建群时继承一份快照（正式版会在这里改成「实时读取源对话」）
        temperature: s.temperature,
        topP: s.topP,
        thinkLevel: s.thinkLevel,
        maxTokens: s.maxTokens,
        contextLimit: s.contextLimit,
    };
}

/** 读取全部可用角色（去重：同一角色名 + 同一人设只保留一份） */
async function loadCharacters() {
    const dbNames = await listChatDbNames();
    const found = [];
    for (const dbName of dbNames) {
        const chats = await readChatsFromDb(dbName);
        for (const chat of chats) {
            if (!chat || chat.kind === 'group') continue;      // 群聊不参与
            const ch = chatToCharacter(chat);
            if (ch) found.push(ch);
        }
    }

    // 去重（同名 + 同人设 视为同一角色）
    const seen = new Set();
    const unique = [];
    for (const c of found) {
        const sig = `${c.name}::${(c.persona || '').slice(0, 60)}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        unique.push(c);
    }

    state.characters = unique;
    // 勾选状态里失效的 key 清掉
    for (const k of [...state.selectedKeys]) {
        if (!unique.some(c => c.key === k)) state.selectedKeys.delete(k);
    }
    return unique;
}

// ============================================================
// 二、模型服务
// ============================================================

/** 初始化两个 ModelService：主模型（成员发言）+ 辅助模型（编排者） */
function initServices() {
    const ns = detectNamespace();
    SettingsManager.setNamespace(ns);

    const mainCfg = {
        modelHost: SettingsManager.getModelHost(),
        apiKey: SettingsManager.getApiKey(),
        modelName: SettingsManager.getModelName(),
    };
    const auxCfg = SettingsManager.getAuxRequestConfig();

    state.services.member = new ModelService(mainCfg);
    state.services.orchestrator = new ModelService(auxCfg);

    // 用户称呼
    const uname = SettingsManager.getUsername();
    state.userName = (uname && uname !== Constants.DEFAULT_USERNAME) ? uname : '用户';

    // 顶部信息栏
    if (el.modelInfo) {
        const auxIsMain = !SettingsManager.getAuxModel();
        if (!mainCfg.modelHost) {
            el.modelInfo.innerHTML = '<span class="gt-warn">⚠️ 未检测到模型配置，请先在主界面完成设置</span>';
        } else {
            el.modelInfo.innerHTML = `
                <span title="成员发言使用的模型">💬 成员：${escapeHtml(mainCfg.modelName || '（未设置）')}</span>
                <span title="编排者使用的模型">🎬 编排：${escapeHtml(auxCfg.modelName || '（未设置）')}${auxIsMain ? ' <em>（跟随主模型）</em>' : ''}</span>
                <span title="设置命名空间">🗂 ${ns ? escapeHtml(ns) : '访客'}</span>`;
        }
    }
}

// ============================================================
// 三、渲染
// ============================================================

function avatarHtml(character, size = 34) {
    const url = character.avatarUrl ? resolveAssetUrl(character.avatarUrl) : '';
    const style = `width:${size}px;height:${size}px;`;
    if (url) return `<img class="gt-avatar" style="${style}" src="${escapeHtml(url)}" alt="">`;
    const initial = escapeHtml((character.name || '?').slice(0, 1));
    return `<span class="gt-avatar gt-avatar-fallback" style="${style}">${initial}</span>`;
}

function renderCharList() {
    const chars = state.characters;
    if (!chars.length) {
        el.charList.innerHTML = `<div class="gt-empty">没有读到任何对话存档。<br>可以点下面的「载入示例角色」先试试效果。</div>`;
    } else {
        el.charList.innerHTML = chars.map(c => {
            const checked = state.selectedKeys.has(c.key);
            return `<label class="gt-char ${checked ? 'selected' : ''}" data-key="${escapeHtml(c.key)}">
                ${avatarHtml(c)}
                <span class="gt-char-meta">
                    <span class="gt-char-name">${escapeHtml(c.name)}</span>
                    <span class="gt-char-src">${escapeHtml(c.sourceTitle)}</span>
                </span>
                <input type="checkbox" ${checked ? 'checked' : ''}>
            </label>`;
        }).join('');
    }

    const n = state.selectedKeys.size;
    el.charCount.textContent = `已选 ${n} / 上限 ${MAX_MEMBERS}`;
    el.charCount.classList.toggle('invalid', n > 0 && (n < MIN_MEMBERS || n > MAX_MEMBERS));

    el.createBtn.disabled = !(n >= MIN_MEMBERS && n <= MAX_MEMBERS);
    el.createBtn.innerHTML = state.groupCreated
        ? '<i class="fas fa-rotate"></i> 重建群聊'
        : '<i class="fas fa-plus"></i> 创建群聊';
}

function renderMembers() {
    if (!state.members.length) {
        el.memberBar.innerHTML = `<span class="gt-members-hint">还没有创建群聊 —— 在左侧勾选 2~5 个角色后点「创建群聊」</span>`;
        return;
    }
    el.memberBar.innerHTML = state.members.map(m =>
        `<span class="gt-member-chip" style="--hue:${m.hue}">
            ${avatarHtml(m, 22)}
            <span>${escapeHtml(m.displayName)}</span>
        </span>`
    ).join('');
}

function renderMessages() {
    if (!state.messages.length) {
        el.messages.innerHTML = `<div class="gt-placeholder">
            <i class="fas fa-comments"></i>
            <p>${state.groupCreated ? '群聊已就绪，说点什么吧～' : '创建群聊后，这里会显示多角色的对话'}</p>
            ${state.groupCreated ? '<p class="sub">输入 <code>@成员名</code> 可点名发言；也可以点左侧 <code>开始旁观</code>，让成员们自己聊起来</p>' : ''}
        </div>`;
        return;
    }

    el.messages.innerHTML = state.messages.map(msg => {
        if (msg.role === 'user') {
            return `<div class="gt-msg gt-msg-user">
                <div class="gt-bubble">
                    <div class="gt-text">${escapeHtml(msg.text)}</div>
                    <div class="gt-time">${escapeHtml(msg.time || '')}</div>
                </div>
                <div class="gt-avatar gt-avatar-fallback gt-avatar-user">我</div>
            </div>`;
        }
        const member = state.members.find(m => m.memberId === msg.memberId);
        const hue = member ? member.hue : 212;
        const avatar = member ? avatarHtml(member, 34) : '<span class="gt-avatar gt-avatar-fallback">?</span>';
        return `<div class="gt-msg gt-msg-ai" style="--hue:${hue}">
            ${avatar}
            <div class="gt-bubble">
                <div class="gt-sender">${escapeHtml(msg.name || '成员')}</div>
                <div class="gt-text">${escapeHtml(msg.text)}</div>
                <div class="gt-time">${escapeHtml(msg.time || '')}</div>
            </div>
        </div>`;
    }).join('');

    scrollToBottom();
}

function setStatus(text, level = 'idle') {
    if (!el.status) return;
    if (!text) {
        el.status.hidden = true;
        el.status.textContent = '';
        return;
    }
    el.status.hidden = false;
    el.status.dataset.level = level;
    el.status.innerHTML = `<span class="gt-status-dot"></span>${escapeHtml(text)}`;
}

function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
}

function updateSendState() {
    el.sendBtn.disabled = state.running || !state.groupCreated;
    // 输入区的「停止」只负责发送流程；旁观模式由左侧的旁观按钮自己兼任停止
    el.stopBtn.hidden = !state.running || state.spectating;

    const btn = el.spectatorBtn;
    if (btn) {
        btn.disabled = !state.groupCreated || (state.running && !state.spectating);
        btn.classList.toggle('active', state.spectating);
        btn.innerHTML = state.spectating
            ? '<i class="fas fa-stop"></i> 停止旁观'
            : '<i class="fas fa-eye"></i> 开始旁观';
    }
}

/** 发言人数上限的显示文案：建群后显示「当前值 / 群内人数」 */
function responderLabel(v = state.policy.maxResponders) {
    return state.groupCreated ? `${v} / ${state.members.length}` : String(v);
}

/**
 * 同步「单次最多发言角色」滑杆的上限。
 * 上限 = **群聊角色人数**（未建群时用整体上限 5）；超出的旧值会被夹回上限。
 */
function syncResponderLimit() {
    const input = el.maxResponders;
    const ceiling = state.groupCreated ? Math.max(1, state.members.length) : MAX_MEMBERS;

    if (state.policy.maxResponders > ceiling) state.policy.maxResponders = ceiling;
    if (state.policy.maxResponders < 1) state.policy.maxResponders = 1;

    if (input) {
        input.max = String(ceiling);
        input.value = String(state.policy.maxResponders);
    }
    if (el.maxRespondersVal) {
        el.maxRespondersVal.textContent = responderLabel();
    }
}

// ============================================================
// 四、创建群聊
// ============================================================

function createGroup() {
    const picked = state.characters.filter(c => state.selectedKeys.has(c.key));
    if (picked.length < MIN_MEMBERS || picked.length > MAX_MEMBERS) {
        setStatus(`请选择 ${MIN_MEMBERS}~${MAX_MEMBERS} 个角色`, 'error');
        return;
    }

    // 重名去重：同名自动追加 (2) (3)
    const used = new Map();
    const members = picked.map((c, i) => {
        let displayName = c.name;
        if (used.has(c.name)) {
            const n = used.get(c.name) + 1;
            used.set(c.name, n);
            displayName = `${c.name}(${n})`;
        } else {
            used.set(c.name, 1);
        }
        return {
            ...c,
            memberId: `m_${i + 1}`,
            displayName,
            hue: MEMBER_HUES[i % MEMBER_HUES.length],
        };
    });

    state.members = members;
    state.messages = [];
    state.groupCreated = true;

    // 开场不清空为「AI 消息」：成员的开场白只作为成员的自我介绍展示，
    // 不进 state.messages，避免污染送给模型的群聊转录
    syncResponderLimit();          // 发言人数上限随群内人数变化
    renderMembers();
    renderMessages();
    renderCharList();
    updateSendState();
    setStatus(`群聊已创建：${members.map(m => m.displayName).join(' / ')}`, 'ok');

    el.input.focus();
}

// ============================================================
// 五、@ 点名
// ============================================================

function parseMentions(text) {
    if (!state.policy.mentionEnabled) return [];
    const ids = [];
    for (const m of state.members) {
        if (text.includes(`@${m.displayName}`) && !ids.includes(m.memberId)) {
            ids.push(m.memberId);
        }
    }
    return ids;
}

/** 输入框里正在输入的 @片段 → 显示候选成员 */
function updateMentionPop() {
    const pop = el.mentionPop;
    if (!pop) return;
    const text = el.input.value;
    const caret = el.input.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const at = before.lastIndexOf('@');

    let fragment = null;
    if (at !== -1) {
        const seg = before.slice(at + 1);
        if (!/[\s]/.test(seg)) fragment = seg;
    }

    if (fragment === null || !state.groupCreated || !state.members.length) {
        pop.hidden = true;
        pop.innerHTML = '';
        return;
    }

    const matches = state.members.filter(m =>
        m.displayName.toLowerCase().includes(fragment.toLowerCase()));

    if (!matches.length) {
        pop.hidden = true;
        pop.innerHTML = '';
        return;
    }

    pop.innerHTML = matches.map(m =>
        `<button type="button" class="gt-mention-item" data-name="${escapeHtml(m.displayName)}" style="--hue:${m.hue}">
            ${avatarHtml(m, 20)}<span>${escapeHtml(m.displayName)}</span>
        </button>`
    ).join('');
    pop.hidden = false;
}

function applyMention(name) {
    const text = el.input.value;
    const caret = el.input.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const after = text.slice(caret);
    const next = `${before.slice(0, at)}@${name} ${after}`;
    el.input.value = next;
    const pos = at + name.length + 2;
    el.input.setSelectionRange(pos, pos);
    el.mentionPop.hidden = true;
    autoResize();
    el.input.focus();
}

// ============================================================
// 六、发送与发言流水线
// ============================================================

function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 创建一个「正在输入」的临时气泡，返回 { root, textEl, thinkEl } */
function createLiveBubble(member) {
    const root = document.createElement('div');
    root.className = 'gt-msg gt-msg-ai gt-msg-live';
    root.style.setProperty('--hue', String(member.hue));
    root.innerHTML = `
        ${avatarHtml(member, 34)}
        <div class="gt-bubble">
            <div class="gt-sender">${escapeHtml(member.displayName)}
                <span class="gt-live-badge"><span class="gt-typing-dot"></span>正在输入…</span>
            </div>
            <div class="gt-think" hidden></div>
            <div class="gt-text"></div>
        </div>`;
    el.messages.appendChild(root);
    // 移除占位符
    const ph = el.messages.querySelector('.gt-placeholder');
    if (ph) ph.remove();
    scrollToBottom();
    return {
        root,
        textEl: root.querySelector('.gt-text'),
        thinkEl: root.querySelector('.gt-think'),
        badge: root.querySelector('.gt-live-badge'),
    };
}

/**
 * 生成流水线回调集合（发送流程与旁观模式共用）。
 * @param {Map}    live        - memberId → 临时气泡
 * @param {string} speakLevel  - 成员发言时的状态等级（旁观模式用紫色调）
 */
function makeHooks(live, speakLevel = 'speaking') {
    return {
        onStatus: (t, level) => setStatus(t, level),

        onDecision: (d) => {
            const nameOf = (id) => state.members.find(m => m.memberId === id)?.displayName;

            // @点名：被点名者必发言，编排者仍会用剩下的名额补位
            if (Array.isArray(d.mentioned) && d.mentioned.length) {
                const mentionedNames = d.mentioned.map(nameOf).filter(Boolean).join('、');
                const extraNames = (d.extra || []).map(nameOf).filter(Boolean).join('、');
                if (extraNames) {
                    setStatus(`📣 点名「${mentionedNames}」｜🎬 编排补充「${extraNames}」`, 'ok');
                } else {
                    setStatus(`📣 已点名「${mentionedNames}」· 编排者认为无需其他人补充`, 'ok');
                }
                return;
            }

            if (d.degraded) {
                setStatus(`⚠️ ${d.reason}`, 'warn');
            } else if (d.reason) {
                setStatus(`🎬 ${d.reason}`, 'orchestrating');
            }
        },

        onMemberStart: (member) => {
            live.set(member.memberId, createLiveBubble(member));
            setStatus(`💬 ${member.displayName} 正在回应…`, speakLevel);
        },

        onMemberThinking: (member, t) => {
            const b = live.get(member.memberId);
            if (!b) return;
            b.thinkEl.hidden = false;
            b.thinkEl.textContent = `🧠 思考中… ${t.slice(-80)}`;
        },

        onMemberChunk: (member, t) => {
            const b = live.get(member.memberId);
            if (!b) return;
            b.textEl.textContent += t;
            if (b.badge) { b.badge.remove(); b.badge = null; }
            scrollToBottom();
        },

        onMemberEnd: (member) => {
            const b = live.get(member.memberId);
            if (b && b.thinkEl) b.thinkEl.hidden = true;
        },

        onError: (err, member) => {
            setStatus(`❌ 「${member.displayName}」发言失败：${err.message || err}`, 'error');
        },
    };
}

/** 收尾：把产出并入状态、清掉临时气泡、按正式状态重绘 */
function finalizeTurn(produced, stoppedLabel) {
    for (const m of produced) {
        state.messages.push({ ...m, time: nowTime() });
    }
    state.running = false;
    state.spectating = false;
    updateSendState();
    // 清掉所有临时气泡，用正式状态重绘（避免状态与 DOM 漂移）
    el.messages.querySelectorAll('.gt-msg-live').forEach(n => n.remove());
    renderMessages();
    if (state.ctl.aborted) {
        setStatus(stoppedLabel, 'warn');
    } else {
        setTimeout(() => setStatus('', 'idle'), 2500);
    }
}

async function send() {
    if (state.running) return;
    if (!state.groupCreated) { setStatus('请先创建群聊', 'error'); return; }

    const text = el.input.value.trim();
    if (!text) return;

    const mentionIds = parseMentions(text);

    el.input.value = '';
    autoResize();
    el.mentionPop.hidden = true;

    state.messages.push({ role: 'user', text, time: nowTime() });
    renderMessages();

    state.running = true;
    state.spectating = false;
    state.ctl = { aborted: false };
    updateSendState();

    // 历史快照：包含刚追加的用户消息
    const historySnapshot = state.messages.slice();
    const live = new Map();   // memberId → 临时气泡
    let produced = [];

    try {
        produced = await runGroupTurn({
            members: state.members,
            policy: state.policy,
            history: historySnapshot,
            userText: text,
            mentionIds,
            memberService: state.services.member,
            orchestratorService: state.services.orchestrator,
            ctl: state.ctl,
            userName: state.userName,
            hooks: makeHooks(live),
        });
    } catch (err) {
        console.error('[GroupTest] 群聊流程异常：', err);
        setStatus(`❌ 出错：${err.message || err}`, 'error');
    } finally {
        finalizeTurn(produced, '⏹ 已停止');
        el.input.focus();
    }
}

/**
 * 旁观模式：用户不说话，让成员们自己聊起来。
 * 轮数可配置为 1~20 或「无限」，并且随时可以点同一个按钮停止。
 */
async function startSpectator() {
    if (state.running) return;
    if (!state.groupCreated) { setStatus('请先创建群聊', 'error'); return; }

    state.running = true;
    state.spectating = true;
    state.ctl = { aborted: false };
    updateSendState();

    const historySnapshot = state.messages.slice();
    const live = new Map();
    let produced = [];

    const rounds = state.policy.spectatorUnlimited ? -1 : state.policy.spectatorRounds;
    setStatus(`👀 旁观模式启动${rounds < 0 ? '（无限轮，随时可停）' : `（共 ${rounds} 轮）`}`, 'spectator');

    try {
        produced = await runSpectator({
            members: state.members,
            policy: { ...state.policy, spectatorRounds: rounds },
            history: historySnapshot,
            memberService: state.services.member,
            orchestratorService: state.services.orchestrator,
            ctl: state.ctl,
            userName: state.userName,
            hooks: makeHooks(live, 'spectator'),
        });
    } catch (err) {
        console.error('[GroupTest] 旁观模式异常：', err);
        setStatus(`❌ 旁观出错：${err.message || err}`, 'error');
    } finally {
        finalizeTurn(produced, '⏹ 旁观已停止');
        if (!state.ctl.aborted) setStatus('👀 旁观结束', 'spectator');
        el.input.focus();
    }
}

/** 旁观按钮：未在旁观时启动，正在旁观时停止 */
function toggleSpectator() {
    if (state.spectating) stop();
    else startSpectator();
}

function stop() {
    if (!state.running) return;
    state.ctl.aborted = true;
    try { state.services.member?.abortCurrentStream(); } catch { /* ignore */ }
    setStatus(state.spectating ? '⏹ 正在停止旁观…' : '⏹ 正在停止…', 'warn');
}

// ============================================================
// 七、输入框自适应高度
// ============================================================
function autoResize() {
    const t = el.input;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}

// ============================================================
// 八、事件绑定
// ============================================================

function bindEvents() {
    // 角色勾选
    el.charList.addEventListener('click', (e) => {
        const label = e.target.closest('.gt-char');
        if (!label) return;
        e.preventDefault();               // 自己管理 checkbox，避免双触发
        const key = label.dataset.key;
        if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
        else {
            if (state.selectedKeys.size >= MAX_MEMBERS) {
                setStatus(`最多只能选 ${MAX_MEMBERS} 个角色`, 'warn');
                return;
            }
            state.selectedKeys.add(key);
        }
        renderCharList();
    });

    // 重新读取存档
    el.reloadBtn.addEventListener('click', async () => {
        setStatus('正在读取对话存档…', 'idle');
        try {
            const list = await loadCharacters();
            state.selectedKeys.clear();
            state.groupCreated = false;
            state.members = [];
            state.messages = [];
            renderMembers();
            renderMessages();
            renderCharList();
            updateSendState();
            syncResponderLimit();
            setStatus(list.length ? `读到 ${list.length} 个角色` : '没有读到角色，可载入示例角色', list.length ? 'ok' : 'warn');
        } catch (err) {
            setStatus(`读取失败：${err.message || err}`, 'error');
        }
    });

    // 载入示例角色
    el.sampleBtn.addEventListener('click', () => {
        for (const s of SAMPLE_CHARACTERS) {
            if (!state.characters.some(c => c.key === s.key)) state.characters.push(s);
        }
        renderCharList();
        setStatus('已载入示例角色，请勾选 2~5 个后创建群聊', 'ok');
    });

    // 创建群聊
    el.createBtn.addEventListener('click', createGroup);

    // 策略控件
    const bindRange = (id, labelId, key, fmt = (v) => String(v)) => {
        const input = $(id);
        const label = $(labelId);
        if (!input) return;
        input.value = state.policy[key];
        if (label) label.textContent = fmt(input.value);
        input.addEventListener('input', () => {
            state.policy[key] = Number(input.value);
            if (label) label.textContent = fmt(input.value);
        });
    };
    bindRange('gt-max-responders', 'gt-max-responders-val', 'maxResponders', (v) => responderLabel(v));
    bindRange('gt-max-total', 'gt-max-total-val', 'maxTotalReplies');
    bindRange('gt-relay-rounds', 'gt-relay-rounds-val', 'autoRelayMaxRounds');

    const relaySwitch = $('gt-auto-relay');
    if (relaySwitch) {
        relaySwitch.checked = state.policy.autoRelay;
        relaySwitch.addEventListener('change', () => { state.policy.autoRelay = relaySwitch.checked; });
    }
    const mentionSwitch = $('gt-mention');
    if (mentionSwitch) {
        mentionSwitch.checked = state.policy.mentionEnabled;
        mentionSwitch.addEventListener('change', () => { state.policy.mentionEnabled = mentionSwitch.checked; });
    }

    // ---- 旁观模式控件 ----
    const specRounds = el.spectatorRounds;
    const specRoundsVal = el.spectatorRoundsVal;
    const specUnlimited = el.spectatorUnlimited;
    const specRow = specRounds ? specRounds.closest('.gt-policy-row') : null;

    /** 无限轮时，把轮数滑杆置灰，标签显示 ∞ */
    const syncSpectatorControls = () => {
        const inf = !!(specUnlimited && specUnlimited.checked);
        state.policy.spectatorUnlimited = inf;
        if (specRounds) specRounds.disabled = inf;
        if (specRow) specRow.classList.toggle('disabled', inf);
        if (specRoundsVal) specRoundsVal.textContent = inf ? '∞' : String(state.policy.spectatorRounds);
    };

    if (specRounds) {
        specRounds.value = state.policy.spectatorRounds;
        if (specRoundsVal) specRoundsVal.textContent = String(state.policy.spectatorRounds);
        specRounds.addEventListener('input', () => {
            state.policy.spectatorRounds = Number(specRounds.value);
            if (specRoundsVal) specRoundsVal.textContent = specRounds.value;
        });
    }
    if (specUnlimited) {
        specUnlimited.checked = state.policy.spectatorUnlimited;
        specUnlimited.addEventListener('change', syncSpectatorControls);
    }
    syncSpectatorControls();

    if (el.spectatorBtn) el.spectatorBtn.addEventListener('click', toggleSpectator);

    // 输入框
    el.input.addEventListener('input', () => { autoResize(); updateMentionPop(); });
    el.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
        }
        if (e.key === 'Escape') el.mentionPop.hidden = true;
    });

    // @候选点选（用 mousedown 抢在 blur 之前）
    el.mentionPop.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.gt-mention-item');
        if (!btn) return;
        e.preventDefault();
        applyMention(btn.dataset.name);
    });

    el.sendBtn.addEventListener('click', send);
    el.stopBtn.addEventListener('click', stop);
}

// ============================================================
// 九、启动
// ============================================================
async function boot() {
    bindEvents();
    autoResize();
    initServices();

    try {
        const list = await loadCharacters();
        if (!list.length && el.seedBanner) el.seedBanner.hidden = false;
    } catch (err) {
        console.error('[GroupTest] 读取角色失败：', err);
        if (el.seedBanner) el.seedBanner.hidden = false;
    }

    renderCharList();
    renderMembers();
    renderMessages();
    updateSendState();
    syncResponderLimit();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
