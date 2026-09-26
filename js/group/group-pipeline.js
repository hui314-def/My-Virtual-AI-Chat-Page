// ============================================================
// 群聊 · 发言流水线（Pipeline）
// ------------------------------------------------------------
// 一次「用户发言 → 多位成员依次回复」的完整流程：
//   1. 决定发言者：@点名者必发言并排在最前，编排者用**剩余名额**补位（D20）；
//      未点名时完全交给编排者（orchestrator.js）
//   2. 按顺序逐个成员流式发言（**不并行**，避免上下文错乱与消息乱序）
//      发言期间**支持用户插话**：插话会并入后续成员的上下文，并在本轮结束后
//      触发一次重新编排来回应（旁观模式不支持插话）
//   3. 可选「自动接力」：再问一次编排者「有没有人想接话」，带上限
//   4. 全程受「单次消息总发言条数上限」约束，并支持随时中断
//
// 关于「成员怎么看到群聊记录」：
//   不用多轮 role 消息，而是把群聊记录拼成一段「发言人：内容」的转录，
//   一次性放进 user 消息，再明确要求"紧接着往下说"。
//   好处：模型不会误以为自己在续写别人的话，也不会把名字前缀写进回复。
// ============================================================
import { stripHiddenTags, replaceSTMacros } from '../core/utils.js';
import { decideSpeakers, pickLeastRecentMember, pickByOrder } from './orchestrator.js';

/** 单次用户消息允许的发言条数硬上限（防止配置失误导致无限输出） */
const ABSOLUTE_MAX_REPLIES = 50;
/** 旁观模式的安全上限：即使配置成"无限"也不会真的跑到天荒地老 */
const SPECTATOR_HARD_CAP = 200;

// ==================== 提示词组装 ====================

/**
 * 组装某位成员这一次发言要用的 messages。
 *
 * @param {Object} p
 * @param {Object} p.member     - 当前发言成员（resolveMembers 的结果）
 * @param {Array}  p.members    - 全部成员
 * @param {Array}  p.history    - 截止目前的群聊消息
 * @param {Object} p.policy     - { contextMessages }
 * @param {string} p.userName   - 显示给模型的「用户」称呼
 * @param {string} [p.userBio]  - 用户简介
 * @param {Object} [p.attachment] - { name, content } 本条消息的文本附件
 * @param {Function} [p.renderInjection] - 渲染「提示词注入」块的回调（与私聊一致）。
 *   由 GroupRuntime 注入，参数为 { roleName, userName, userBio, rolePersona }，
 *   返回已渲染的文本或 null。传 callback 而不是 manager，是为了让本模块保持无应用依赖。
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMemberMessages({ member, members, history, policy, userName = '用户', userBio = '', attachment = null, renderInjection = null }) {
    const s = member.settings || {};
    const roleName = member.displayName || s.roleName || '成员';
    const others = members.filter(m => m.memberId !== member.memberId).map(m => m.displayName);

    const limit = policy.contextMessages || 12;
    const recent = history.slice(-limit);

    // SillyTavern 宏上下文（与主程序 simulateAIResponse 保持一致的字段）
    const stCtx = {
        roleName,
        userName,
        greeting: s.greeting,
        charVersion: s.cardMeta?.characterVersion,
        input: '',
        original: '',
        messages: recent.map(m => ({
            role: m.role,
            text: m.role === 'ai' ? stripHiddenTags(m.text || '') : (m.text || ''),
        })),
    };

    // ---- system：人设 + 群聊规则 ----
    let system = `你是一位角色扮演者，你的姓名是“ ${roleName} ”。关于你的角色简介是：\n\n`
        + (s.persona ? replaceSTMacros(s.persona, stCtx) : '')
        + `\n\n总之你需要始终以“ ${roleName} ”的身份和口吻回应\n\n`;

    system += userBio
        ? `关于和你对话的当前用户的名称是：${userName}，简介：${userBio}`
        : `关于和你对话的当前用户名称叫：${userName}。`;

    if (s.cardSystemPrompt) system += `\n\n【附加系统设定】\n${replaceSTMacros(s.cardSystemPrompt, stCtx)}`;
    if (s.cardExampleMessages) system += `\n\n【角色对话示例(用于模仿语气与风格)】\n${replaceSTMacros(s.cardExampleMessages, stCtx)}`;

    system += `\n\n【你正在一个多人聊天室中】\n`
        + (others.length ? `群里的其他成员有：${others.join('、')}。\n` : '目前群里暂时只有你一个人。\n')
        + `聊天记录里每条消息都会以「发言人名字：内容」的形式给出，方便你分辨是谁说的。\n\n`
        + `【群聊规则】\n`
        + `1. 只以「${roleName}」自己的身份发言，绝对不要替其他成员说话，也不要复述别人的话。\n`
        + `2. 不要在自己的回复开头写名字前缀，直接说话即可。\n`
        + `3. 保持你原本的性格、语气和说话习惯。\n`
        + `4. 这是日常聊天，回复请简短自然（建议 150 字以内），可以包含括号里的动作或神态描写。\n`
        + `5. 如果话题与你无关，可以简短表达态度，不必强行展开。\n\n`
        + `【回复格式规则】\n`
        + `当你的回复中包含非语言表达的内容时，请使用括号（）将这些内容包裹起来。例如：“（轻轻叹气）我相信你能做到。”`;

    // ---- 提示词注入（与私聊 simulateAIResponse 一致）----
    // 位置也保持一致：放在 system prompt 的末尾。
    // 占位符 {roleName} / {rolePersona} 用**该成员自己的**信息渲染，
    // 所以每个成员拿到的注入块都是针对它本人定制的。
    if (typeof renderInjection === 'function') {
        try {
            const block = renderInjection({
                roleName,
                userName,
                userBio,
                rolePersona: s.persona || '',
            });
            if (block) system += '\n\n' + replaceSTMacros(block, stCtx);
        } catch (err) {
            // 注入失败不能影响发言：记日志后继续
            console.warn('[GroupPipeline] 提示词注入渲染失败：', err);
        }
    }

    // ---- user：群聊转录 + 发言指令 ----
    const transcript = recent.map(m => {
        const who = m.role === 'user' ? userName : (m.name || '某位成员');
        const text = m.role === 'user' ? (m.text || '') : stripHiddenTags(m.text || '');
        return `${who}：${text}`;
    }).filter(l => l.trim()).join('\n');

    const hasHistory = transcript.trim().length > 0;
    const instruction = hasHistory
        ? `请以「${roleName}」的身份，紧接着上面的聊天记录往下说。
只输出「${roleName}」要说的话本身——不要写名字前缀，不要写旁白或解释，不要复述聊天记录。`
        : `聊天室刚刚建立，还没有人说话。请你以「${roleName}」的身份主动开口，向大家打个招呼，或者起一个话题。
只输出「${roleName}」要说的话本身——不要写名字前缀，不要写旁白或解释。`;

    let userContent = `【群聊记录】\n${transcript || '（暂无记录）'}\n\n【现在请你发言】\n${instruction}`;
    if (attachment && attachment.content) {
        userContent += `\n\n【本条消息附带的文件】\n文件名为「${attachment.name}」，内容如下：\n\`\`\`\n${attachment.content}\n\`\`\``;
    }

    return [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
    ];
}

// ==================== 单个成员的流式发言 ====================

/** 数字兜底：非法值 → 默认值；超出范围 → 夹到范围内 */
function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 去掉回复开头可能出现的「成员名：」前缀 */
function stripLeadingName(text, name) {
    if (!name) return text;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text || '').replace(new RegExp(`^\\s*${escaped}\\s*[:：]\\s*`), '');
}

/**
 * 让某位成员流式发言，返回完整文本。
 * @returns {Promise<{text: string, thinkText: string}>}
 */
export async function streamMemberReply({ service, member, messages, images = [], onChunk, onThinking, ctl }) {
    const options = {
        temperature: clampNum(member.temperature, 0, 2, 0.8),
        topP: clampNum(member.topP, 0, 1, 0.9),
        maxTokens: clampNum(member.maxTokens, 50, 8000, 500),
        thinkLevel: clampNum(member.thinkLevel, 0, 4, 0),
        images,
    };

    let full = '';
    let thinkFull = '';

    for await (const block of service.streamChat(messages, options)) {
        if (ctl && ctl.aborted) break;
        if (!block) continue;
        if (block.type === 'content' && block.text) {
            full += block.text;
            if (onChunk) onChunk(block.text);
        } else if (block.type === 'thinking' && block.text) {
            thinkFull += block.text;
            if (onThinking) onThinking(block.text);
        }
    }

    return { text: stripLeadingName(full, member.displayName).trim(), thinkText: thinkFull };
}

// ==================== 决定发言者（含 @点名 补位） ====================

/**
 * 计算本轮的发言者列表。
 *
 * 发言顺序（`policy.speakerOrder`）：
 *   · `orchestrator`（默认）→ 调编排者决定
 *   · `rotate`  → 按「最久没说话」轮转，**不调模型**（省一次请求）
 *   · `random`  → 随机挑人，同样不调模型
 * 无论哪种顺序，@点名 都仍然生效（被点名者必发言）。
 *
 * @param {'answer'|'relay'} [p.mode] - 'answer' 会处理 @点名；'relay' 不处理
 * @returns {Promise<Object>} decision 对象（含 speakers / mentioned / extra / reason / source / degraded）
 */
async function resolveSpeakers({ members, policy, history, userText, mentionIds, memberService, orchestratorService, ctl, onStatus, onDecision, mode = 'answer' }) {
    const validIds = new Set(members.map(m => m.memberId));
    const maxResponders = Math.max(1, Math.min(policy.maxResponders || 2, members.length));
    const order = policy.speakerOrder || 'orchestrator';

    // ---------- 轮流 / 随机：不调用编排者 ----------
    if (order === 'rotate' || order === 'random') {
        const mentioned = (mode === 'answer' ? (mentionIds || []) : [])
            .filter(id => validIds.has(id))
            .slice(0, maxResponders);

        const pool = members.filter(m => !mentioned.includes(m.memberId));
        const picked = pickByOrder(order, pool, history, maxResponders - mentioned.length);
        const orderLabel = order === 'rotate' ? '轮流发言' : '随机发言';

        const decision = {
            speakers: mentioned.concat(picked),
            mentioned: [...mentioned],
            extra: [...picked],
            reason: mode === 'relay'
                ? `自动接力 · ${orderLabel}`
                : (mentioned.length ? `已点名「${mentioned.map(id => members.find(m => m.memberId === id)?.displayName).filter(Boolean).join('、')}」· ${orderLabel}` : orderLabel),
            source: order,
            degraded: false,
        };
        if (onDecision) onDecision(decision);
        return decision;
    }

    // ---------- 编排者决定 ----------
    const mentioned = (mode === 'answer' ? (mentionIds || []) : [])
        .filter(id => validIds.has(id))
        .slice(0, maxResponders);

    if (mentioned.length) {
        const mentionedNames = mentioned
            .map(id => members.find(m => m.memberId === id)?.displayName)
            .filter(Boolean);

        const decision = {
            speakers: [...mentioned],
            mentioned: [...mentioned],
            extra: [],
            reason: `用户点名了「${mentionedNames.join('、')}」`,
            source: 'mention',
            degraded: false,
        };

        const remaining = maxResponders - mentioned.length;
        if (remaining > 0) {
            const orch = await decideSpeakers({
                service: orchestratorService,
                members,
                history,
                userText,
                policy: { ...policy, maxResponders: remaining },
                mode: 'answer',
                mentionedNames,
                onStatus,
            });

            const extra = orch.speakers.filter(id => !mentioned.includes(id));
            decision.speakers = mentioned.concat(extra);
            decision.extra = extra;
            decision.degraded = orch.degraded;

            if (extra.length) {
                decision.source = 'mention+orchestrator';
                decision.reason = `已点名「${mentionedNames.join('、')}」；${orch.reason || '编排者补充了其他成员'}`;
            } else {
                decision.reason = orch.degraded
                    ? `已点名「${mentionedNames.join('、')}」；${orch.reason}`
                    : `已点名「${mentionedNames.join('、')}」，编排者认为无需其他人补充`;
            }
        }

        if (onDecision) onDecision(decision);
        return decision;
    }

    const decision = await decideSpeakers({
        service: orchestratorService,
        members,
        history,
        userText,
        policy: { ...policy, maxResponders },
        mode,
        onStatus,
    });
    if (onDecision) onDecision(decision);
    return decision;
}

// ==================== 主流程 ====================

/**
 * 执行一轮完整的「用户发言 → 群聊回应」。
 *
 * @param {Object}   ctx
 * @param {Array}    ctx.members             - resolveMembers() 的结果
 * @param {Object}   ctx.policy              - 编排策略
 * @param {Array}    ctx.history             - 截止用户发言为止的历史（**含**本条用户消息）
 * @param {string}   ctx.userText
 * @param {string[]} [ctx.mentionIds]
 * @param {Object}   ctx.memberService       - 主模型实例
 * @param {Object}   ctx.orchestratorService - 辅助模型实例
 * @param {Object}   [ctx.ctl]               - 中断控制 { aborted: boolean }
 * @param {string}   [ctx.userName]
 * @param {string}   [ctx.userBio]
 * @param {Object}   [ctx.attachment]        - { name, content }
 * @param {string[]} [ctx.images]            - 本条消息的图片 dataUrl
 * @param {Array}    [ctx.interjections]     - **用户插话队列**（与 GroupRuntime 共享的数组）。
 *   群聊回复进行中，用户可以继续发言「插话」：队列里的内容会在下一位成员发言前并入上下文，
 *   并在本轮发言结束后**触发一次重新编排**来回应插话（不受「自动接力」开关限制）。
 *   旁观模式下不传该参数（旁观不支持插话）。
 * @param {Object}   [ctx.hooks]
 * @returns {Promise<Array>} 本轮新增的 AI 消息（{ memberId, memberName, text, thinkText }）
 */
export async function runGroupTurn(ctx) {
    const {
        members, policy, history, userText, mentionIds = [],
        memberService, orchestratorService, ctl,
        userName = '用户', userBio = '', attachment = null, images = [],
        renderInjection = null,
        hooks = {},
    } = ctx;

    const {
        onStatus, onDecision, onMemberStart, onMemberEnd,
        onMemberChunk, onMemberThinking, onSave, onError,
    } = hooks;

    if (!members.length) {
        if (onStatus) onStatus('⚠️ 群聊里没有可用的成员', 'warn');
        return [];
    }

    const maxTotal = Math.min(ABSOLUTE_MAX_REPLIES, Math.max(1, policy.maxTotalReplies || 6));
    const maxResponders = Math.max(1, Math.min(policy.maxResponders || 2, members.length));

    /**
     * 本轮新增的**全部**条目（AI 发言 + 用户插话），保持时间顺序，
     * 用于 liveHistory —— 这样「后发言的成员」能看到用户中途插入的话。
     */
    const turnItems = [];
    /** 本轮新增的 AI 消息（作为返回值；条数上限只统计它） */
    const aiMessages = [];

    const liveHistory = () => history.concat(turnItems);
    const aborted = () => !!(ctl && ctl.aborted);

    /** 用户插话队列（由 GroupRuntime 共享传入）：本轮期间用户又发的消息 */
    const interjectQueue = Array.isArray(ctx.interjections) ? ctx.interjections : null;
    /** 本轮期间是否发生过插话（用于触发「回应插话」的重新编排） */
    let interjected = false;
    /** 最近一条插话（含它的 @点名） */
    let lastInterjection = null;

    /** 把队列里的用户插话并入本轮历史，让后续发言的成员都能看到 */
    const drainInterjections = () => {
        if (!interjectQueue || !interjectQueue.length) return 0;
        let n = 0;
        while (interjectQueue.length) {
            const item = interjectQueue.shift();
            turnItems.push({ role: 'user', text: item.text || '', name: null, memberId: null });
            // 插话自带的图片并入本轮图片集合，让后续发言的成员也能看到
            if (Array.isArray(item.imageUrls) && item.imageUrls.length) {
                for (const u of item.imageUrls) {
                    if (u && !images.includes(u)) images.push(u);
                }
            }
            lastInterjection = item;
            interjected = true;
            n += 1;
        }
        return n;
    };

    // ---------- 第一步：决定发言者 ----------
    const decision = await resolveSpeakers({
        members, policy, history: liveHistory(), userText, mentionIds,
        memberService, orchestratorService, ctl, onStatus, onDecision,
    });
    let speakers = decision.speakers;
    if (aborted()) return aiMessages;

    if (!speakers.length) {
        if (onStatus) onStatus('🤔 这一轮没有成员想搭话', 'idle');
        return aiMessages;
    }

    // ---------- 第二步：顺序发言（含「回应插话」与自动接力） ----------
    let relayRound = 0;

    while (speakers.length) {
        for (const id of speakers) {
            if (aborted()) return aiMessages;
            if (aiMessages.length >= maxTotal) {
                if (onStatus) onStatus(`已到达本轮发言条数上限（${maxTotal} 条）`, 'idle');
                return aiMessages;
            }

            // 轮到下一位之前，先把用户插话并入上下文（本人说话时看不到，但后面的成员能看到）
            drainInterjections();

            const member = members.find(m => m.memberId === id);
            if (!member) continue;

            if (onMemberStart) onMemberStart(member);

            try {
                const messages = buildMemberMessages({
                    member, members, history: liveHistory(),
                    policy, userName, userBio, attachment, renderInjection,
                });

                const { text, thinkText } = await streamMemberReply({
                    service: memberService,
                    member,
                    messages,
                    images,
                    ctl,
                    onChunk: (t) => onMemberChunk && onMemberChunk(member, t),
                    onThinking: (t) => onMemberThinking && onMemberThinking(member, t),
                });

                if (aborted()) return aiMessages;

                if (!text) {
                    if (onStatus) onStatus(`「${member.displayName}」没有说什么`, 'idle');
                    if (onMemberEnd) onMemberEnd(member, '', thinkText);
                    continue;
                }

                const msg = {
                    memberId: member.memberId,
                    memberName: member.displayName,
                    text,
                    thinkText: thinkText || '',
                };
                aiMessages.push(msg);
                turnItems.push({ role: 'ai', text, name: member.displayName, memberId: member.memberId });
                if (onSave) await onSave(msg);
                if (onMemberEnd) onMemberEnd(member, text, thinkText);

            } catch (err) {
                console.error(`[GroupPipeline] 成员「${member.displayName}」发言失败：`, err);
                if (onError) onError(err, member);
                if (onMemberEnd) onMemberEnd(member, '', '');
            }
        }

        if (aborted()) break;
        if (aiMessages.length >= maxTotal) break;

        // 兜住循环结束时仍在队列里的插话（比如刚好在最后一位成员发言期间发来的）
        drainInterjections();

        // ---------- 第三步：用户插话优先 → 重新编排一轮来回应插话 ----------
        // 注意：插话的回应**不受「自动接力」开关限制**——用户主动说话了，就应该有人回应。
        if (interjected) {
            interjected = false;
            if (onStatus) onStatus('💬 收到你的插话，正在重新编排…', 'orchestrating');

            const d = await resolveSpeakers({
                members,
                policy,
                history: liveHistory(),
                userText: lastInterjection?.text || userText,
                mentionIds: lastInterjection?.mentionIds || [],
                memberService,
                orchestratorService,
                ctl,
                onStatus,
                onDecision,
            });

            speakers = d.speakers.slice(0, maxResponders);
            if (!speakers.length) break;
            continue;
        }

        // ---------- 第四步：自动接力（默认行为，由轮数控制；0 = 不接力） ----------
        const relayRounds = Math.max(0, Number(policy.autoRelayMaxRounds) || 0);
        if (relayRound >= relayRounds) break;

        relayRound += 1;
        if (onStatus) onStatus(`🔁 自动接力（第 ${relayRound} / ${relayRounds} 轮）`, 'orchestrating');

        const lastUserText = [...history].reverse().find(m => m.role === 'user')?.text || userText;

        const relay = await resolveSpeakers({
            members,
            policy,
            history: liveHistory(),
            userText: lastUserText,
            mentionIds: [],
            memberService,
            orchestratorService,
            ctl,
            onStatus,
            // 接力轮：把轮次一并回传，便于页面显示「🔁 第 N 轮」
            onDecision: (d) => onDecision && onDecision({ ...d, relayRound }),
            mode: 'relay',
        });

        speakers = relay.speakers.filter(id => members.some(m => m.memberId === id)).slice(0, maxResponders);
    }

    if (onStatus) onStatus('✅ 本轮结束', 'idle');
    return aiMessages;
}

/**
 * 旁观模式：用户不说话，让成员们自己聊起来。
 * 每轮由编排者「顺着聊天气氛」挑 1 位成员开口；轮数可配置或无限，且随时可中断。
 * @returns {Promise<Array>} 旁观产出的 AI 消息
 */
export async function runSpectator(ctx) {
    const {
        members, policy, history,
        memberService, orchestratorService, ctl,
        userName = '用户', userBio = '',
        renderInjection = null,
        hooks = {},
    } = ctx;

    const {
        onStatus, onDecision, onMemberStart, onMemberEnd,
        onMemberChunk, onMemberThinking, onSave, onError,
    } = hooks;

    if (!members.length) {
        if (onStatus) onStatus('⚠️ 群聊里没有可用的成员', 'warn');
        return [];
    }

    /**
     * AI 消息（返回值 + onSave 用）。
     * ⚠️ 必须与「历史条目」分开维护：这些消息带 memberName/thinkText 但**没有 role**，
     * 直接塞进历史会让编排者看不到发言人（转录里全变成「某位成员」），
     * 也会让 pickLeastRecentMember 找不到「谁刚说过」→ 同一个人霸屏。
     */
    const produced = [];
    /** 历史条目（role / name / memberId），与 runGroupTurn 的 turnItems 同构 */
    const turnItems = [];
    const liveHistory = () => history.concat(turnItems);
    const aborted = () => !!(ctl && ctl.aborted);

    const rawRounds = Number(policy.spectatorRounds);
    const unlimited = !Number.isFinite(rawRounds) || rawRounds < 0;
    const maxRounds = unlimited ? SPECTATOR_HARD_CAP : Math.max(1, Math.min(SPECTATOR_HARD_CAP, rawRounds));

    let round = 0;

    while (round < maxRounds) {
        if (aborted()) break;

        round += 1;
        const label = unlimited ? `第 ${round} 轮 / ∞` : `第 ${round} / ${maxRounds} 轮`;
        if (onStatus) onStatus(`👀 旁观模式 · ${label}`, 'spectator');

        // 发言顺序同样受 speakerOrder 影响：轮流/随机模式下不调用编排者（省钱、更快）
        const decision = await resolveSpeakers({
            members,
            policy: { ...policy, maxResponders: 1 },
            history: liveHistory(),
            userText: '',
            mentionIds: [],
            memberService,
            orchestratorService,
            ctl,
            onStatus,
            mode: 'spectator',
        });
        if (aborted()) break;

        let speakers = decision.speakers.slice(0, 1);

        // 兜底 1：没有可用人选时，按轮转点名，保证闲聊继续
        if (!speakers.length) {
            const fb = pickLeastRecentMember(members, liveHistory());
            if (!fb) break;
            speakers = [fb.memberId];
            decision.reason = '（自由闲聊：无人主动开口，按轮转点名）';
            decision.source = decision.source + '+rotate';
        } else if (members.length > 1 && produced.length > 0 && !policy.allowConsecutiveSpeakers) {
            // 兜底 2：编排者仍选了「上一位刚说过」的成员 → 换成最久没说的那位。
            // 旁观是自由闲聊，同一个人连续霸屏会失去多角色的意义；
            // 提示词里已经给了发言次数统计，这里只是最后一道保险。
            // ⚠️ 若用户开启了「允许同一成员连续发言」，这条保险要让路。
            const lastSpeakerId = produced[produced.length - 1].memberId;
            if (lastSpeakerId && speakers[0] === lastSpeakerId) {
                const others = members.filter(m => m.memberId !== lastSpeakerId);
                const fb = pickLeastRecentMember(others, liveHistory());
                if (fb) {
                    const lastName = members.find(m => m.memberId === lastSpeakerId)?.displayName || '上一位';
                    decision.reason = `（自由闲聊：避免「${lastName}」连续发言，轮到「${fb.displayName}」）`;
                    decision.source = decision.source + '+rotate';
                    speakers = [fb.memberId];
                }
            }
        }
        if (onDecision) onDecision({ ...decision, spectatorRound: round });

        const member = members.find(m => m.memberId === speakers[0]);
        if (!member) continue;

        if (onMemberStart) onMemberStart(member);

        try {
            const messages = buildMemberMessages({
                member, members, history: liveHistory(), policy, userName, userBio, renderInjection,
            });

            const { text, thinkText } = await streamMemberReply({
                service: memberService,
                member,
                messages,
                ctl,
                onChunk: (t) => onMemberChunk && onMemberChunk(member, t),
                onThinking: (t) => onMemberThinking && onMemberThinking(member, t),
            });

            if (aborted()) return produced;

            if (text) {
                const msg = {
                    memberId: member.memberId,
                    memberName: member.displayName,
                    text,
                    thinkText: thinkText || '',
                };
                produced.push(msg);
                // 历史条目：带上 role 与 name，让编排者能看到「谁说了什么」
                turnItems.push({
                    role: 'ai',
                    text,
                    name: member.displayName,
                    memberId: member.memberId,
                });
                if (onSave) await onSave(msg);
                if (onMemberEnd) onMemberEnd(member, text, thinkText);
            } else {
                if (onStatus) onStatus(`「${member.displayName}」没有说话`, 'idle');
                if (onMemberEnd) onMemberEnd(member, '', thinkText);
            }
        } catch (err) {
            console.error(`[GroupPipeline] 旁观发言失败：`, err);
            if (onError) onError(err, member);
            if (onMemberEnd) onMemberEnd(member, '', '');
        }
    }

    if (!aborted() && !unlimited && round >= maxRounds) {
        if (onStatus) onStatus('✅ 旁观结束', 'idle');
    }
    return produced;
}
