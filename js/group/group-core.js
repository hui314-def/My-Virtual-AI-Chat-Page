// ============================================================
// 群聊 · 核心数据层
// ------------------------------------------------------------
// 职责：
//   1. 定义「角色级参数 / 空间级参数」的边界（继承规则）
//   2. 成员的参数解析（实时读取源对话）与对账（源对话消失 → 脱钩兜底）
//   3. 群聊对象的默认结构与策略默认值
//   4. 渲染辅助（成员配色、显示名、头像）
//
// 设计要点（见 plans/multi_agent_orchestrator_plan.md §3）：
//   **读取时解析（Lazy Resolve）**——群成员不存副本，每次渲染/发言前实时读源对话。
//   因此「原对话改了，群里立刻跟着变」天然成立，无需任何监听或同步代码。
//   唯一需要兜底的是「源对话消失」，此时才把最后一次读到的值写入 snapshot 并标记脱钩。
// ============================================================
import Constants from '../core/constants.js';

// ==================== 常量 ====================

/** 群聊成员数量限制 */
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 5;

/** 成员配色（最多 5 人，依次分配色相） */
export const MEMBER_HUES = [212, 280, 340, 160, 42];

/**
 * 「角色级参数」清单：这些字段由群成员**实时继承自源对话**。
 * 不在此列表中的设置（背景 / BGM / 用户画像）走「群空间设置」，由群聊独立维护。
 */
export const ROLE_LEVEL_KEYS = [
    'roleName', 'persona', 'greeting', 'avatarUrl',
    'ttsEnabled', 'ttsVoice',
    'temperature', 'topP', 'thinkLevel', 'maxTokens', 'contextLimit',
    // 角色卡附加字段（SillyTavern 导入）：属于角色本身，一并继承
    'cardSystemPrompt', 'cardExampleMessages', 'cardMeta',
];

/** 群空间设置（群聊独立维护，不从成员继承） */
export const SPACE_LEVEL_KEYS = [
    // 群聊自己的头像：显示在左侧「智能体档案」列表中
    'avatarUrl',
    'bgType', 'bgImageUrl', 'bgVideoUrl', 'bgVideoMode', 'bgVideoName',
    'bgMusicEnabled', 'bgMusicUrl', 'bgMusicMode', 'bgMusicName', 'bgMusicVolume',
    'userProfileName', 'userProfileBio',
];

// ==================== 基础判断 ====================

/** 是否群聊会话 */
export function isGroupChat(chat) {
    return !!(chat && chat.kind === 'group');
}

/** 从对象里挑出指定字段 */
export function pick(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const k of keys) {
        if (obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
}

// ==================== 群聊对象的默认结构 ====================

/** 编排策略默认值（与设置弹窗的控件一一对应） */
export function defaultOrchestratorPolicy() {
    return {
        maxResponders: 2,          // 单次最多发言角色数（上限 = 群内人数）
        maxTotalReplies: 6,        // 单次最多发言消息条数（1~∞）
        autoRelayMaxRounds: 1,     // 自动接力轮数（0 = 不接力；1~3）
        spectatorRounds: 3,        // 旁观模式轮数（-1 = 无限）
        contextMessages: 12,       // 参考的历史条数（编排者与成员共用）
        speakerOrder: 'orchestrator', // 发言顺序：orchestrator | rotate | random
        allowConsecutiveSpeakers: false, // 是否允许同一成员连续发言
    };
}

/** 发言顺序的合法取值 */
export const SPEAKER_ORDERS = ['orchestrator', 'rotate', 'random'];

/** 参考历史条数的取值范围 */
export const CONTEXT_MESSAGES_MIN = 4;
export const CONTEXT_MESSAGES_MAX = 30;

/**
 * 已废弃的编排字段。
 * 这些功能现在**默认就是开启的**，不再作为设置项暴露——
 * 留着开关反而会让用户以为「关掉就不生效了」。
 * `ensureGroupDefaults()` 会从存量群聊里把它们删掉，避免留下误导性的旧值。
 */
const OBSOLETE_ORCHESTRATOR_KEYS = [
    'autoRelay',        // 角色间自动接力 → 改由 autoRelayMaxRounds 表达（0 = 不接力）
    'mentionEnabled',   // @点名 → 始终启用
];

/** 群聊的「群空间设置」初始值：默认字段 + 可选继承第一个成员的背景 */
export function buildInitialSpaceSettings(sourceSettings = null) {
    const base = {
        avatarUrl: null,           // 群聊头像（默认不继承成员头像，显示为群组图标）
        bgType: null,
        bgImageUrl: null,
        bgVideoUrl: '',
        bgVideoMode: 'url',
        bgVideoName: '',
        bgMusicEnabled: false,
        bgMusicUrl: '',
        bgMusicMode: 'url',
        bgMusicName: '',
        bgMusicVolume: 0.5,
        userProfileName: '',
        userProfileBio: '',
    };
    if (sourceSettings) {
        // D15：群聊背景初始值跟随「第一个被选中的成员」，一次性复制后完全独立
        Object.assign(base, pick(sourceSettings, SPACE_LEVEL_KEYS));
    }
    // 群聊头像不从成员继承（否则群里会出现和某个私聊一模一样的头像，容易混淆）
    base.avatarUrl = null;
    return base;
}

/** 补齐群聊对象缺失的字段（兼容旧数据 / 手工构造的对象） */
export function ensureGroupDefaults(chat) {
    if (!isGroupChat(chat)) return chat;
    if (!Array.isArray(chat.members)) chat.members = [];
    if (!chat.orchestrator || typeof chat.orchestrator !== 'object') {
        chat.orchestrator = defaultOrchestratorPolicy();
    } else {
        chat.orchestrator = { ...defaultOrchestratorPolicy(), ...chat.orchestrator };
    }
    // 清理已废弃的旧字段（接力 / @点名 已改为默认实现）
    for (const k of OBSOLETE_ORCHESTRATOR_KEYS) delete chat.orchestrator[k];
    // 接力轮数：0 表示不接力，夹到 0~3
    const rounds = Number(chat.orchestrator.autoRelayMaxRounds);
    chat.orchestrator.autoRelayMaxRounds = Number.isFinite(rounds)
        ? Math.max(0, Math.min(3, Math.round(rounds)))
        : 1;
    // 发言顺序：非法值回退为「编排者决定」
    if (!SPEAKER_ORDERS.includes(chat.orchestrator.speakerOrder)) {
        chat.orchestrator.speakerOrder = 'orchestrator';
    }
    // 参考历史条数：夹到 4~30
    const ctxMsgs = Number(chat.orchestrator.contextMessages);
    chat.orchestrator.contextMessages = Number.isFinite(ctxMsgs)
        ? Math.max(CONTEXT_MESSAGES_MIN, Math.min(CONTEXT_MESSAGES_MAX, Math.round(ctxMsgs)))
        : 12;
    chat.orchestrator.allowConsecutiveSpeakers = !!chat.orchestrator.allowConsecutiveSpeakers;
    if (!chat.settings || typeof chat.settings !== 'object') {
        chat.settings = buildInitialSpaceSettings();
    } else {
        chat.settings = { ...buildInitialSpaceSettings(), ...pick(chat.settings, SPACE_LEVEL_KEYS) };
    }
    // 群聊 v1：固定单一话题
    if (!Array.isArray(chat.topics) || chat.topics.length === 0) {
        chat.topics = [{
            id: Date.now(),
            name: '群聊',
            createdAt: new Date().toISOString(),
            summary: null,
            messages: [],
        }];
    }
    if (chat.currentTopicIndex === undefined || chat.currentTopicIndex === null) {
        chat.currentTopicIndex = 0;
    }
    return chat;
}

// ==================== 成员参数的解析与对账 ====================

/**
 * 解析某成员**当前生效**的角色参数。
 *  - 未脱钩 → 实时读源对话（因此源对话一改，群里立刻跟着变）
 *  - 已脱钩（源对话被删）→ 使用脱钩瞬间保存的 snapshot
 * @returns {Object|null} 合并默认值后的设置对象；源对话不存在时返回 null（交给 reconcile 处理）
 */
export function resolveMemberSettings(member, allChats) {
    if (!member) return null;
    if (member.detached || !member.sourceChatId) {
        return { ...Constants.DEFAULT_SETTINGS, ...(member.snapshot || {}) };
    }
    const src = (allChats || []).find(c => c.id == member.sourceChatId);
    if (!src) return null;
    return { ...Constants.DEFAULT_SETTINGS, ...(src.settings || {}) };
}

/**
 * 解析出「可直接用于发言 / 渲染」的成员对象。
 * @returns {Array<Object>} [{ memberId, displayName, hue, detached, sourceTitle, settings, ...角色级参数 }]
 */
export function resolveMembers(chat, allChats) {
    if (!isGroupChat(chat)) return [];
    const out = [];
    for (let i = 0; i < (chat.members || []).length; i++) {
        const m = chat.members[i];
        const settings = resolveMemberSettings(m, allChats);
        if (!settings) continue;   // 源对话已消失且尚未对账：本轮跳过
        out.push({
            memberId: m.memberId,
            displayName: m.displayName || settings.roleName || `成员${i + 1}`,
            hue: MEMBER_HUES[i % MEMBER_HUES.length],
            detached: !!m.detached,
            sourceChatId: m.sourceChatId ?? null,
            sourceTitle: m.sourceTitle || '',
            settings,
            // 常用字段平铺出来，方便流水线直接读取
            roleName: settings.roleName,
            persona: settings.persona,
            avatarUrl: settings.avatarUrl || settings.avatar || null,
            temperature: settings.temperature,
            topP: settings.topP,
            thinkLevel: settings.thinkLevel,
            maxTokens: settings.maxTokens,
        });
    }
    return out;
}

/**
 * 对账成员：源对话被删除 → 把最后一次读到的角色级参数写入 snapshot，并标记「已脱钩」（D5）。
 *
 * 必须在每次渲染 / 发言前调用，否则 resolveMemberSettings 会拿到 null。
 * @returns {boolean} 是否发生了变化（true 时调用方需要保存会话并刷新侧边栏）
 */
export function reconcileGroupMembers(chat, allChats) {
    if (!isGroupChat(chat)) return false;
    let changed = false;

    for (const m of chat.members || []) {
        if (m.detached) continue;
        const src = (allChats || []).find(c => c.id == m.sourceChatId);

        if (!src) {
            // 源对话消失：用最后一次刷新的快照脱钩，成员仍留在群里正常发言
            m.snapshot = { ...(m.lastResolved || {}) };
            m.detached = true;
            m.sourceChatId = null;
            m.sourceTitle = (m.sourceTitle || '') + '（已脱钩）';
            changed = true;
        } else {
            // 持续刷新快照，供「脱钩瞬间」兜底使用
            m.lastResolved = pick(src.settings, ROLE_LEVEL_KEYS);
            if (!m.displayName && src.settings?.roleName) {
                m.displayName = src.settings.roleName;
                changed = true;
            }
            // 记录来源标题，便于设置弹窗展示
            const title = src.title || '';
            if (m.sourceTitle !== title) {
                m.sourceTitle = title;
                changed = true;
            }
        }
    }
    return changed;
}

// ==================== 显示名与配色 ====================

/**
 * 为一批角色生成去重后的显示名（同名追加 (2)、(3)…）。
 * @param {Array<{name:string}>} picked
 * @returns {string[]}
 */
export function buildDisplayNames(picked) {
    const used = new Map();
    return picked.map(c => {
        const name = c.name || '成员';
        if (used.has(name)) {
            const n = used.get(name) + 1;
            used.set(name, n);
            return `${name}(${n})`;
        }
        used.set(name, 1);
        return name;
    });
}

// ==================== 流水线用的历史格式转换 ====================

/**
 * 把主程序格式的会话消息转换成流水线格式。
 * 主程序：{ type:'user'|'ai', text, memberName?, memberId? }
 * 流水线：{ role:'user'|'ai', text, name?, memberId? }
 */
export function toPipelineHistory(messages) {
    return (messages || []).map(m => ({
        role: m.type === 'user' ? 'user' : 'ai',
        text: m.text || '',
        name: m.memberName || null,
        memberId: m.memberId || null,
    }));
}

/**
 * 把「含 @显示名 的原始文本」解析成被点名的成员 id 列表。
 * @param {string} text
 * @param {Array}  members  - resolveMembers() 的结果
 * @returns {string[]} memberId 数组
 */
export function parseMentions(text, members) {
    if (!text || !Array.isArray(members)) return [];
    const ids = [];
    for (const m of members) {
        if (!m.displayName) continue;
        if (text.includes(`@${m.displayName}`) && !ids.includes(m.memberId)) {
            ids.push(m.memberId);
        }
    }
    return ids;
}

/** 移除文本里的 @点名 标记（用于展示；发给模型的文本保留原文） */
export function stripMentionMarks(text, members) {
    let out = String(text || '');
    for (const m of members || []) {
        if (!m.displayName) continue;
        out = out.split(`@${m.displayName}`).join('');
    }
    return out.trim();
}
