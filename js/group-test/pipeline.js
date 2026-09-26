// ============================================================
// 群聊原型 · 发言流水线（Pipeline）
// ------------------------------------------------------------
// 一次「用户发言 → 多位成员依次回复」的完整流程：
//
//   1. 决定发言者：@点名者必发言并排在最前，**编排者仍用剩余名额补位**；
//      未点名时完全交给编排者（orchestrator.js）
//   2. 按顺序逐个成员流式发言（**不并行**，避免上下文错乱与消息乱序）
//   3. 可选「自动接力」：再问一次编排者「有没有人想接话」，带上限
//   4. 全程受「单次消息总发言条数上限」约束，并支持随时中断
//
// 关于「成员怎么看到群聊记录」：
//   我们**不用**多轮 role 消息，而是把群聊记录拼成一段「发言人：内容」的
//   转录文本，一次性放进 user 消息里，再明确要求"紧接着往下说"。
//   这样做的好处是：模型不会误以为自己在续写别人的话，也不会把名字前缀写进回复。
//   代价是每次都要重发一段转录文本（token 略高），对原型阶段是可以接受的取舍。
// ============================================================
import { stripHiddenTags } from '../core/utils.js';
import { decideSpeakers, pickLeastRecentMember } from './orchestrator.js';

/** 单次用户消息允许的发言条数硬上限（防止配置失误导致无限输出） */
const ABSOLUTE_MAX_REPLIES = 50;

/**
 * 组装某位成员这一次发言要用的 messages。
 *
 * @param {Object} p
 * @param {Object} p.member   - 当前发言的成员
 * @param {Array}  p.members  - 全部成员
 * @param {Array}  p.history  - 截止目前的群聊消息 [{ role, name?, memberId?, text }]
 * @param {Object} p.policy   - { contextMessages }
 * @param {string} p.userName - 显示给模型的「用户」称呼
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMemberMessages({ member, members, history, policy, userName = '用户' }) {
    const others = members
        .filter(m => m.memberId !== member.memberId)
        .map(m => m.displayName);

    const system = [
        `你是一位角色扮演者，你的姓名是「${member.displayName}」。`,
        member.persona ? `关于你的角色简介：\n${member.persona}` : '',
        `总之你需要始终以「${member.displayName}」的身份和口吻说话。`,
        '',
        '【你正在一个多人聊天室中】',
        others.length
            ? `群里的其他成员有：${others.join('、')}。`
            : '目前群里暂时只有你一个人。',
        `用户的名字是「${userName}」。聊天记录里每条消息都会以「发言人名字：内容」的形式给出，方便你分辨是谁说的。`,
        '',
        '【群聊规则】',
        `1. 只以「${member.displayName}」自己的身份发言，绝对不要替其他成员说话，也不要复述别人的话。`,
        '2. 不要在自己的回复开头写名字前缀，直接说话即可。',
        '3. 保持你原本的性格、语气和说话习惯。',
        '4. 这是日常聊天，回复请简短自然（建议 150 字以内），可以包含括号里的动作或神态描写。',
        '5. 如果话题与你无关，可以简短表达态度，不必强行展开。',
        '',
        '【回复格式规则】',
        '当你的回复中包含非语言表达的内容时，请使用括号（）将这些内容包裹起来。例如：“（轻轻叹气）我相信你能做到。”',
    ].filter(Boolean).join('\n');

    const limit = policy.contextMessages || 12;
    const transcript = history.slice(-limit).map(m => {
        const who = m.role === 'user' ? userName : (m.name || '某位成员');
        // AI 历史剥离 <think> / <soul> 等隐藏内容，避免内心独白污染上下文
        const text = m.role === 'user' ? (m.text || '') : stripHiddenTags(m.text || '');
        return `${who}：${text}`;
    }).filter(line => line.trim()).join('\n');

    const hasHistory = transcript.trim().length > 0;
    const instruction = hasHistory
        ? `请以「${member.displayName}」的身份，紧接着上面的聊天记录往下说。
只输出「${member.displayName}」要说的话本身——不要写名字前缀，不要写旁白或解释，不要复述聊天记录。`
        : `聊天室刚刚建立，还没有人说话。请你以「${member.displayName}」的身份主动开口，向大家打个招呼，或者起一个话题。
只输出「${member.displayName}」要说的话本身——不要写名字前缀，不要写旁白或解释。`;

    const userContent = `【群聊记录】
${transcript || '（暂无记录）'}

【现在请你发言】
${instruction}`;

    return [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
    ];
}

/**
 * 让某位成员流式发言，返回完整文本。
 *
 * @param {Object}   p
 * @param {Object}   p.service   - 主模型 ModelService 实例
 * @param {Object}   p.member    - 发言成员
 * @param {Array}    p.messages  - buildMemberMessages 的结果
 * @param {Function} [p.onChunk] - 正文增量回调 (text)
 * @param {Function} [p.onThinking] - 思考增量回调 (text)
 * @param {Object}   [p.ctl]     - 中断控制 { aborted: boolean }
 * @returns {Promise<string>} 完整回复文本
 */
export async function streamMemberReply({ service, member, messages, onChunk, onThinking, ctl }) {
    const options = {
        temperature: clampNum(member.temperature, 0, 2, 0.8),
        topP: clampNum(member.topP, 0, 1, 0.9),
        maxTokens: clampNum(member.maxTokens, 50, 8000, 500),
        // 群聊里默认关闭思考，避免每条都要等很久；角色原本开了就尊重它
        thinkLevel: clampNum(member.thinkLevel, 0, 4, 0),
    };

    let full = '';
    const generator = service.streamChat(messages, options);

    for await (const block of generator) {
        if (ctl && ctl.aborted) break;
        if (!block) continue;
        if (block.type === 'content' && block.text) {
            full += block.text;
            if (onChunk) onChunk(block.text);
        } else if (block.type === 'thinking' && block.text) {
            if (onThinking) onThinking(block.text);
        }
    }

    // 万一模型仍然写了「名字：」前缀，剥掉一层
    return stripLeadingName(full, member.displayName).trim();
}

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
 * 执行一轮完整的「用户发言 → 群聊回应」。
 *
 * @param {Object}   ctx
 * @param {Array}    ctx.members           - [{ memberId, displayName, persona, ... }]
 * @param {Object}   ctx.policy            - 编排策略
 * @param {Array}    ctx.history           - 截止用户发言为止的历史（含本条用户消息）
 * @param {string}   ctx.userText          - 用户刚发的消息
 * @param {string[]} [ctx.mentionIds]      - @点名命中的成员 id
 * @param {Object}   ctx.memberService     - 主模型实例
 * @param {Object}   ctx.orchestratorService - 辅助模型实例
 * @param {Object}   [ctx.ctl]             - 中断控制 { aborted: boolean }
 * @param {Object}   [ctx.hooks]           - 各阶段回调
 * @returns {Promise<Array>} 本轮新增的 AI 消息数组
 */
export async function runGroupTurn(ctx) {
    const {
        members, policy, history, userText, mentionIds = [],
        memberService, orchestratorService, ctl,
        userName = '用户',
        hooks = {},
    } = ctx;

    const {
        onStatus, onDecision, onMemberStart, onMemberEnd,
        onMemberChunk, onMemberThinking, onError,
    } = hooks;

    const validIds = new Set(members.map(m => m.memberId));
    const maxTotal = Math.min(
        ABSOLUTE_MAX_REPLIES,
        Math.max(1, policy.maxTotalReplies || 6)
    );
    const maxResponders = Math.max(1, Math.min(policy.maxResponders || 2, members.length));

    /** 本轮已产出的 AI 消息 */
    const produced = [];
    /** 送给模型的「实时历史」= 原历史 + 本轮已产出 */
    const liveHistory = () => history.concat(produced);

    const aborted = () => !!(ctl && ctl.aborted);

    // ---------- 第一步：决定发言者 ----------
    let speakers;

    // @点名命中的成员（不存在的 id 会被过滤掉）
    const mentioned = (mentionIds || [])
        .filter(id => validIds.has(id))
        .slice(0, maxResponders);

    if (mentioned.length) {
        // @点名：被点名者**必定发言**，但**不跳过编排者**——
        // 编排者会用「剩下的名额」判断还有谁适合补充或回应。
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
                history: liveHistory(),
                userText,
                policy: { ...policy, maxResponders: remaining },
                mode: 'answer',
                mentionedNames,
                onStatus,
            });

            // 去重：编排者有时仍会重复点被点名的人
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
        speakers = decision.speakers;

    } else {
        // 普通流程（未点名，或 @ 了不存在的成员）
        const decision = await decideSpeakers({
            service: orchestratorService,
            members,
            history: liveHistory(),
            userText,
            policy: { ...policy, maxResponders },
            mode: 'answer',
            onStatus,
        });
        if (onDecision) onDecision(decision);
        speakers = decision.speakers;
    }

    if (!speakers.length) {
        if (onStatus) onStatus('🤔 这一轮没有成员想搭话', 'idle');
        return produced;
    }

    // ---------- 第二步：顺序发言（含自动接力） ----------
    let relayRound = 0;

    while (speakers.length) {
        for (const id of speakers) {
            if (aborted()) return produced;
            if (produced.length >= maxTotal) {
                if (onStatus) onStatus(`已到达本轮发言条数上限（${maxTotal} 条）`, 'idle');
                return produced;
            }

            const member = members.find(m => m.memberId === id);
            if (!member) continue;

            if (onMemberStart) onMemberStart(member);

            try {
                const messages = buildMemberMessages({
                    member,
                    members,
                    history: liveHistory(),
                    policy,
                    userName,
                });

                const text = await streamMemberReply({
                    service: memberService,
                    member,
                    messages,
                    ctl,
                    onChunk: (t) => onMemberChunk && onMemberChunk(member, t),
                    onThinking: (t) => onMemberThinking && onMemberThinking(member, t),
                });

                if (aborted()) return produced;

                if (!text) {
                    // 空回复：不落库，给个提示继续下一位
                    if (onStatus) onStatus(`「${member.displayName}」没有说什么`, 'idle');
                    if (onMemberEnd) onMemberEnd(member, '');
                    continue;
                }

                const msg = {
                    role: 'ai',
                    memberId: member.memberId,
                    name: member.displayName,
                    text,
                };
                produced.push(msg);
                if (onMemberEnd) onMemberEnd(member, text);

            } catch (err) {
                console.error(`[Pipeline] 成员「${member.displayName}」发言失败：`, err);
                if (onError) onError(err, member);
                if (onMemberEnd) onMemberEnd(member, '');
            }
        }

        // ---------- 第三步：自动接力 ----------
        const relayRounds = Math.max(0, Number(policy.autoRelayMaxRounds) || 0);
        if (!policy.autoRelay || relayRound >= relayRounds) break;
        if (aborted()) break;
        if (produced.length >= maxTotal) break;

        relayRound += 1;
        if (onStatus) onStatus(`🔁 自动接力（第 ${relayRound} / ${relayRounds} 轮）`, 'orchestrating');

        // 接力轮没有新的用户消息：沿用最近一条用户消息作为语境锚点，避免提示词里出现空的「用户：」
        const lastUserText = [...history].reverse().find(m => m.role === 'user')?.text || userText;

        const relay = await decideSpeakers({
            service: orchestratorService,
            members,
            history: liveHistory(),
            userText: lastUserText,
            policy: { ...policy, maxResponders },
            mode: 'relay',
            onStatus,
        });
        if (onDecision) onDecision({ ...relay, relayRound });

        speakers = relay.speakers
            .filter(id => validIds.has(id))
            .slice(0, maxResponders);
    }

    if (onStatus) onStatus('✅ 本轮结束', 'idle');
    return produced;
}

/** 旁观模式的安全上限：即使配置成"无限"，也不会真的跑到天荒地老 */
const SPECTATOR_HARD_CAP = 200;

/**
 * 旁观模式：用户不说话，让成员们自己聊起来。
 *
 * 与 runGroupTurn 的区别：
 *   - 没有用户消息，每轮由编排者「顺着聊天气氛」挑 1 位成员开口
 *   - 编排者返回空数组时，用「最久没说话」兜底，保证闲聊不会卡住
 *   - 轮数可配置，也可以无限（-1），并**随时可中断**
 *
 * @param {Object} ctx - 同 runGroupTurn，额外支持 policy.spectatorRounds（-1 = 无限）
 * @returns {Promise<Array>} 本轮旁观产出的 AI 消息数组
 */
export async function runSpectator(ctx) {
    const {
        members, policy, history,
        memberService, orchestratorService, ctl,
        userName = '用户',
        hooks = {},
    } = ctx;

    const {
        onStatus, onDecision, onMemberStart, onMemberEnd,
        onMemberChunk, onMemberThinking, onError,
    } = hooks;

    const produced = [];
    const liveHistory = () => history.concat(produced);
    const aborted = () => !!(ctl && ctl.aborted);

    // 轮数：-1 / 非数字 → 无限
    const rawRounds = Number(policy.spectatorRounds);
    const unlimited = !Number.isFinite(rawRounds) || rawRounds < 0;
    const maxRounds = unlimited
        ? SPECTATOR_HARD_CAP
        : Math.max(1, Math.min(SPECTATOR_HARD_CAP, rawRounds));

    let round = 0;

    while (round < maxRounds) {
        if (aborted()) break;
        if (!members.length) break;

        round += 1;
        const label = unlimited ? `第 ${round} 轮 / ∞` : `第 ${round} / ${maxRounds} 轮`;
        if (onStatus) onStatus(`👀 旁观模式 · ${label}`, 'orchestrating');

        // ---- 每轮由编排者挑 1 位成员 ----
        const decision = await decideSpeakers({
            service: orchestratorService,
            members,
            history: liveHistory(),
            userText: '',
            policy: { ...policy, maxResponders: 1 },
            mode: 'spectator',
            onStatus,
        });
        if (aborted()) break;

        let speakers = decision.speakers.slice(0, 1);

        // 兜底：编排者表示"没人想开口"时，按轮转点一位，保证闲聊继续
        if (!speakers.length) {
            const fb = pickLeastRecentMember(members, liveHistory());
            if (!fb) break;
            speakers = [fb.memberId];
            // 编排者说"没人想开口"，但旁观模式需要聊天继续 → 按轮转点名，并说明原因
            decision.reason = '（自由闲聊：编排者认为无人主动开口，按轮转点名）';
            decision.source = decision.source + '+rotate';
        }
        if (onDecision) onDecision({ ...decision, spectatorRound: round });

        const member = members.find(m => m.memberId === speakers[0]);
        if (!member) continue;

        if (onMemberStart) onMemberStart(member);

        try {
            const messages = buildMemberMessages({
                member,
                members,
                history: liveHistory(),
                policy,
                userName,
            });

            const text = await streamMemberReply({
                service: memberService,
                member,
                messages,
                ctl,
                onChunk: (t) => onMemberChunk && onMemberChunk(member, t),
                onThinking: (t) => onMemberThinking && onMemberThinking(member, t),
            });

            if (aborted()) return produced;

            if (text) {
                produced.push({
                    role: 'ai',
                    memberId: member.memberId,
                    name: member.displayName,
                    text,
                });
                if (onMemberEnd) onMemberEnd(member, text);
            } else {
                if (onStatus) onStatus(`「${member.displayName}」没有说话`, 'idle');
                if (onMemberEnd) onMemberEnd(member, '');
            }
        } catch (err) {
            console.error(`[Spectator] 成员「${member.displayName}」发言失败：`, err);
            if (onError) onError(err, member);
            if (onMemberEnd) onMemberEnd(member, '');
        }
    }

    if (!aborted() && !unlimited && round >= maxRounds) {
        if (onStatus) onStatus('✅ 旁观结束', 'idle');
    }
    return produced;
}
