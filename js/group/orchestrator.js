// ============================================================
// 群聊 · 编排者（Orchestrator）
// ------------------------------------------------------------
// 职责：判断「这一轮该由群里的哪几位成员开口」。
//
// 设计要点（见 plans/multi_agent_orchestrator_plan.md §4）：
//   1. 使用「辅助任务模型」（auxModel），非流式 + JSON 输出，成本低；
//   2. 只输出 JSON，自身不产生正文，**不进消息流**；
//   3. 三层降级：JSON 解析 → 正则抠数组 → 关键词打分兜底；
//   4. @点名 的语义是「保证发言」而非「独占发言」——被点名者必定发言，
//      编排者用**剩余名额**决定还有谁补充（D20）。
// ============================================================

/** 人设摘要截断长度 */
const PERSONA_SNIPPET = 120;

/** 取字符串的前 n 个字符（单行化 + 截断） */
export function truncate(text, n) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 中英文通用的二元组（用于关键词重合度打分） */
function bigrams(text) {
    const s = String(text || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
}

// ==================== 提示词组装 ====================

/**
 * 统计最近记录里各成员的发言情况（用于让编排者保持发言均衡）。
 *
 * 背景：编排者只能看到「聊天记录」本身，看不到次数统计。某位成员一旦说得多，
 * 记录里就全是它 → 大语言模型天然倾向于「顺着已有的说话人继续」→ 形成正反馈，
 * 同一位成员越说越多（旁观模式尤其明显）。把统计显式喂给模型是最直接的解法。
 *
 * @returns {Array<{member: Object, count: number, gap: number|null}>}
 *   gap = 距最后一条消息隔了几条（0 = 刚说过）；null = 还没说过
 */
function buildSpeakingStats(members, history) {
    const total = history.length;
    return members.map(m => {
        let count = 0;
        let lastIdx = -1;
        history.forEach((h, i) => {
            if (h.role === 'ai' && h.memberId === m.memberId) {
                count += 1;
                lastIdx = i;
            }
        });
        return {
            member: m,
            count,
            gap: lastIdx === -1 ? null : (total - 1 - lastIdx),
        };
    });
}

/** 把发言统计渲染成提示词里的一段 */
function renderSpeakingStats(members, history) {
    if (!history.length) return '';
    const lines = buildSpeakingStats(members, history).map(({ member, count, gap }) => {
        let when;
        if (gap === null) when = '还没说过';
        else if (gap === 0) when = '上一条就是它说的';
        else when = `${gap} 条前说过`;
        return `- ${member.displayName}：最近说了 ${count} 次 · ${when}`;
    }).join('\n');
    return `\n【发言次数统计（请据此保持均衡）】\n${lines}\n`;
}

/**
 * @param {'answer'|'relay'|'spectator'} mode
 * @param {string[]} mentionedNames - 用户已 @ 点名的成员名（他们必发言，编排者只负责补位）
 */
function buildDecisionPrompt({ members, history, userText, maxResponders, mode = 'answer', mentionedNames = [], allowConsecutive = false }) {
    const memberLines = members.map(m => {
        const persona = truncate(m.persona, PERSONA_SNIPPET) || '（无设定）';
        return `- id: ${m.memberId} | 名字: ${m.displayName}\n  人设摘要: ${persona}`;
    }).join('\n');

    const transcript = history.length
        ? history.map(m => {
            const who = m.role === 'user' ? '用户' : (m.name || '某位成员');
            return `${who}：${truncate(m.text, 200)}`;
        }).join('\n')
        : '（暂无聊天记录）';

    const hasMention = mentionedNames.length > 0 && mode === 'answer';
    const mentionedBlock = hasMention
        ? `\n\n【用户已点名的成员（他们一定会发言，你不必再选他们）】\n${mentionedNames.join('、')}`
        : '';

    let taskSection;
    let extraRule;
    let maxDesc;

    if (mode === 'spectator') {
        taskSection = `【当前任务】
现在用户没有发言，聊天室处于「自由闲聊」状态。请你决定**这一轮**由谁来开口。`;
        // ⚠️ 这里刻意把「轮流开口」放在最前面：
        // 若只说「顺着聊天气氛往下接」，模型会一直选正在说话的那位，导致独角戏。
        extraRule = '当前是自由闲聊：请让成员们**轮流开口**，优先选「最近说得少 / 还没说过」的成员；在此前提下再让话题自然连贯。聊天室还没人说话时，就选一位最合适来开场的人。';
        maxDesc = `最多选择 ${maxResponders} 位成员`;
    } else if (mode === 'relay') {
        taskSection = `【当前任务】
用户刚刚发过消息，现在需要你判断：是否还有成员想接着上一条继续补充或回应别人。`;
        extraRule = '只在确实有成员想补充、或想回应别人时才选人；没人需要补充就返回空数组 []。';
        maxDesc = `最多选择 ${maxResponders} 位成员`;
    } else if (hasMention) {
        taskSection = `【用户刚发送的消息】
用户：${userText}${mentionedBlock}`;
        extraRule = `用户已经点名了上面列出的成员，**请不要再选择他们**。你只需要判断：除了他们之外，还有没有其他成员适合补充或回应这条消息？
需要就给出来，不需要就返回空数组 []——不要为了凑人数而选人。`;
        maxDesc = `最多再选择 ${maxResponders} 位成员（被点名的成员不占这些名额）`;
    } else {
        taskSection = `【用户刚发送的消息】
用户：${userText}`;
        extraRule = '请依据用户这条消息的内容来选择回应者。';
        maxDesc = `最多选择 ${maxResponders} 位成员`;
    }

    return `你是一个多人聊天室的「发言调度器」。你的唯一职责是判断：这一轮应该由聊天室里的哪几位成员开口说话。

【聊天室成员】
${memberLines}
${renderSpeakingStats(members, history)}
【最近的聊天记录】
${transcript}

${taskSection}

【调度规则】
1. 只选择「确实与当前话题相关」的成员。相关性来自成员的人设、专长，以及聊天记录中的上下文。
2. ${maxDesc}，按发言先后顺序排列。
3. 如果这一轮确实没有成员适合开口，可以返回空数组 []。
4. 保持聊天秩序：不要让成员重复别人的话，也不要让所有人都一拥而上。
5. **保持发言均衡（重要）**：请参考上面的「发言次数统计」——
   · 优先让「最近说得少」「还没说过」的成员开口；
${allowConsecutive
        ? '   · 本群已允许同一位成员连续发言，若剧情确实需要，可以让它接着说下去；\n'
        : '   · **不要让同一位成员连续两轮发言**（除非确实只有它适合）；\n'}   · 不要因为聊天记录里某人的话最多，就一直让它说下去。
6. ${extraRule}
7. 只输出一个 JSON 对象，不要输出任何解释、前言、Markdown 代码块或多余符号。

【输出格式】
{"speakers":["成员id1","成员id2"],"reason":"一句话说明为什么选他们"}`;
}

// ==================== 返回解析 ====================

/**
 * 解析编排者返回文本 → { speakers: string[], reason, source, rawCount }
 * 支持成员 id 与成员名混用。
 */
function parseDecision(raw, members) {
    if (!raw) return null;
    let text = String(raw).trim();
    if (!text) return null;

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let obj = null;
    let source = 'json';

    try { obj = JSON.parse(text); } catch { /* 继续降级 */ }

    if (!obj) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { obj = JSON.parse(m[0]); } catch { /* 继续降级 */ } }
    }

    if (!obj) {
        const m = text.match(/["']?speakers["']?\s*[:：]\s*\[([^\]]*)\]/i);
        if (!m) return null;
        obj = { speakers: m[1].split(',').map(s => s.trim()), reason: '（正则兜底解析）' };
        source = 'regex';
    }

    if (!obj || !Array.isArray(obj.speakers)) return null;

    const byId = new Set(members.map(m => m.memberId));
    const byName = new Map(members.map(m => [m.displayName, m.memberId]));

    const rawCount = obj.speakers.filter(s => String(s ?? '').trim()).length;
    const speakers = [];
    for (const item of obj.speakers) {
        const key = String(item ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
        if (!key) continue;
        const id = byId.has(key) ? key : byName.get(key);
        if (id && !speakers.includes(id)) speakers.push(id);
    }

    return { speakers, reason: String(obj.reason || '').trim(), source, rawCount };
}

// ==================== 兜底策略 ====================

/**
 * 挑出「最久没说话」的成员（旁观模式轮转兜底也用这个）。
 * @returns {Object|null}
 */
export function pickLeastRecentMember(members, history) {
    const ids = pickLeastRecentMembers(members, history, 1);
    return ids.length ? (members.find(m => m.memberId === ids[0]) || null) : null;
}

/**
 * 按「最久没说话」的顺序挑 n 位成员（「轮流发言」模式用）。
 * @returns {string[]} memberId 数组
 */
export function pickLeastRecentMembers(members, history, n) {
    const count = Math.max(0, Math.min(Number(n) || 0, members.length));
    if (!count) return [];

    const scored = members.map(m => {
        let lastIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'ai' && history[i].memberId === m.memberId) { lastIdx = i; break; }
        }
        return {
            id: m.memberId,
            // 从没说过 → 最优先；越久没说数值越大
            silence: lastIdx === -1 ? history.length + 1 : history.length - lastIdx,
        };
    });
    scored.sort((a, b) => b.silence - a.silence);
    return scored.slice(0, count).map(s => s.id);
}

/**
 * 随机挑 n 位成员（「随机」模式用，不重复）。
 * @returns {string[]} memberId 数组
 */
export function pickRandomMembers(members, n) {
    const count = Math.max(0, Math.min(Number(n) || 0, members.length));
    const pool = members.map(m => m.memberId);
    const out = [];
    while (out.length < count && pool.length) {
        out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
}

/**
 * 「非编排者」的发言顺序（轮流 / 随机）—— **不调用模型**，省一次请求、出话更快。
 * @param {'rotate'|'random'} order
 * @returns {string[]} memberId 数组
 */
export function pickByOrder(order, members, history, n) {
    return order === 'random'
        ? pickRandomMembers(members, n)
        : pickLeastRecentMembers(members, history, n);
}

/**
 * 关键词兜底：人设里命中越多二元组越相关；全为 0 分时按「最久没说话」轮转。
 */
function keywordFallback({ members, history, userText, maxResponders }) {
    const userGrams = bigrams(userText);

    const scored = members.map(m => {
        const hay = `${m.displayName} ${m.persona || ''}`.toLowerCase();
        let score = 0;
        for (const g of userGrams) {
            if (hay.includes(g)) score += 1;
        }
        if (m.displayName && String(userText || '').includes(m.displayName)) score += 10;

        let lastIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'ai' && history[i].memberId === m.memberId) { lastIdx = i; break; }
        }
        const silence = lastIdx === -1 ? history.length + 1 : history.length - lastIdx;

        return { m, score, silence };
    });

    const anyHit = scored.some(s => s.score > 0);
    if (anyHit) scored.sort((a, b) => (b.score - a.score) || (b.silence - a.silence));
    else scored.sort((a, b) => b.silence - a.silence);

    return scored.slice(0, maxResponders).map(s => s.m.memberId);
}

// ==================== 主入口 ====================

/**
 * 决定本轮发言者。
 *
 * @param {Object}   p
 * @param {Object}   p.service          - 已按「辅助模型」配置好的 ModelService 实例
 * @param {Array}    p.members          - resolveMembers() 的结果
 * @param {Array}    p.history          - [{ role:'user'|'ai', name?, memberId?, text }]
 * @param {string}   p.userText         - 用户刚发的消息（接力/旁观轮可为空）
 * @param {Object}   p.policy           - { maxResponders, contextMessages }
 * @param {string}   [p.mode]           - 'answer' | 'relay' | 'spectator'
 * @param {string[]} [p.mentionedNames] - 用户已 @ 点名的成员名
 * @param {Function} [p.onStatus]       - 状态提示回调 (text, level)
 * @returns {Promise<{speakers: string[], reason: string, source: string, degraded: boolean}>}
 */
export async function decideSpeakers({ service, members, history, userText, policy, mode = 'answer', mentionedNames = [], onStatus }) {
    const maxResponders = Math.max(1, Math.min(policy.maxResponders || 2, members.length));
    const contextMessages = policy.contextMessages || 12;
    const recent = history.slice(-contextMessages);

    const fallback = (why) => ({
        speakers: keywordFallback({ members, history: recent, userText, maxResponders }),
        reason: why,
        source: 'fallback',
        degraded: true,
    });

    if (!members.length) return { speakers: [], reason: '群里没有可用成员', source: 'empty', degraded: false };
    if (!service) return fallback('未配置模型，已按关键词兜底指派');

    const prompt = buildDecisionPrompt({
        members, history: recent, userText, maxResponders, mode, mentionedNames,
        allowConsecutive: !!policy.allowConsecutiveSpeakers,
    });

    let raw = '';
    try {
        if (onStatus) onStatus('🎬 正在编排发言顺序…', 'orchestrating');
        raw = await service.generateText(prompt, {
            temperature: 0.3,
            maxTokens: 800,
            thinkLevel: 0,      // 丢弃思考，避免污染 JSON 解析
            jsonFormat: true,
        });
    } catch (err) {
        console.warn('[GroupOrchestrator] 调用失败，走关键词兜底：', err);
        return fallback('编排者调用失败，已按关键词兜底指派');
    }

    const parsed = parseDecision(raw, members);
    if (!parsed) {
        console.warn('[GroupOrchestrator] 无法解析返回内容，走关键词兜底。原始返回：', raw);
        return fallback('编排者返回格式异常，已按关键词兜底指派');
    }

    if (parsed.rawCount > 0 && parsed.speakers.length === 0) {
        console.warn('[GroupOrchestrator] 返回的成员标识无法识别，走关键词兜底。原始返回：', raw);
        return fallback('编排者返回了无法识别的成员，已按关键词兜底指派');
    }

    return {
        speakers: parsed.speakers.slice(0, maxResponders),
        reason: parsed.reason,
        source: parsed.source,
        degraded: false,
    };
}
