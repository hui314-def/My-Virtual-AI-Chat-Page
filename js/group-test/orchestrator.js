// ============================================================
// 群聊原型 · 编排者（Orchestrator）
// ------------------------------------------------------------
// 职责：判断「用户刚发的这条消息，应该由群里的哪几位成员来回复」。
//
// 设计要点（与 plans/multi_agent_orchestrator_plan.md §4 一致）：
//   1. 使用「辅助任务模型」（auxModel），非流式 + JSON 输出，成本低；
//   2. 只输出 JSON，自身不产生任何正文，**不进消息流**；
//   3. 三层降级：JSON 解析 → 正则抠数组 → 关键词打分兜底；
//   4. 关键词兜底时优先选「最久没说话」的成员，保证轮转公平。
// ============================================================

/** 人设摘要截断长度 */
const PERSONA_SNIPPET = 120;

/** 取字符串的前 n 个字符 */
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

/**
 * 组装给编排者的提示词。
 * @param {'answer'|'relay'|'spectator'} mode - 决定任务描述：用户发言 / 自动接力 / 旁观闲聊
 * @param {string[]} [mentionedNames] - 用户已 @ 点名的成员名（他们必发言，编排者只负责补位）
 * @returns {string}
 */
function buildDecisionPrompt({ members, history, userText, maxResponders, mode = 'answer', mentionedNames = [] }) {
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

    // ---- 三种情境不同的「任务段」与「附加规则」 ----
    let taskSection;
    let extraRule;
    let maxDesc;

    if (mode === 'spectator') {
        taskSection = `【当前任务】
现在用户没有发言，聊天室处于「自由闲聊」状态。请你决定**这一轮**由谁来开口。`;
        extraRule = '当前是自由闲聊：请顺着聊天气氛与话题往下接；请尽量让成员轮流开口，不要总是同一个人。聊天室还没人说话时，就选一位最合适来开场的人。';
        maxDesc = `最多选择 ${maxResponders} 位成员`;
    } else if (mode === 'relay') {
        taskSection = `【当前任务】
用户刚刚发过消息，现在需要你判断：是否还有成员想接着上一条继续补充或回应别人。`;
        extraRule = '只在确实有成员想补充、或想回应别人时才选人；没人需要补充就返回空数组 []。';
        maxDesc = `最多选择 ${maxResponders} 位成员`;
    } else if (hasMention) {
        // 用户 @ 了点名：被点名者必定发言，编排者只负责用剩下的名额补位
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

【最近的聊天记录】
${transcript}

${taskSection}

【调度规则】
1. 只选择「确实与当前话题相关」的成员。相关性来自成员的人设、专长，以及聊天记录中的上下文。
2. ${maxDesc}，按发言先后顺序排列。
3. 如果这一轮确实没有成员适合开口，可以返回空数组 []。
4. 保持聊天秩序：不要让成员重复别人的话，也不要让所有人都一拥而上。
5. ${extraRule}
6. 只输出一个 JSON 对象，不要输出任何解释、前言、Markdown 代码块或多余符号。

【输出格式】
{"speakers":["成员id1","成员id2"],"reason":"一句话说明为什么选他们"}`;
}

/**
 * 解析编排者的返回文本 → speakers 数组（memberId）。
 * 支持成员名与 id 混用的情况。
 * @returns {{speakers: string[], reason: string, source: string}|null}
 */
function parseDecision(raw, members) {
    if (!raw) return null;
    let text = String(raw).trim();
    if (!text) return null;

    // 去掉 Markdown 代码块围栏
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let obj = null;

    // ① 直接 JSON 解析
    try { obj = JSON.parse(text); } catch { /* 继续降级 */ }

    // ② 从文本里抠出第一个 {...} 再解析
    if (!obj) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { obj = JSON.parse(m[0]); } catch { /* 继续降级 */ } }
    }

    // ③ 正则直接抓 "speakers": [...] 里的内容
    let source = 'json';
    if (!obj) {
        const m = text.match(/["']?speakers["']?\s*[:：]\s*\[([^\]]*)\]/i);
        if (!m) return null;
        obj = { speakers: m[1].split(',').map(s => s.trim()), reason: '（正则兜底解析）' };
        source = 'regex';
    }

    if (!obj || !Array.isArray(obj.speakers)) return null;

    // 归一化：允许模型返回 id 或成员名，去掉引号与空白
    const byId = new Map(members.map(m => [m.memberId, m.memberId]));
    const byName = new Map(members.map(m => [m.displayName, m.memberId]));

    const rawCount = obj.speakers.filter(s => String(s ?? '').trim()).length;

    const speakers = [];
    for (const raw of obj.speakers) {
        const key = String(raw ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
        if (!key) continue;
        const id = byId.get(key) || byName.get(key);
        if (id && !speakers.includes(id)) speakers.push(id);
    }

    return { speakers, reason: String(obj.reason || '').trim(), source, rawCount };
}

/**
 * 挑出「最久没说话」的成员。
 * 旁观模式里编排者返回空数组时用它兜底，保证闲聊不会卡住。
 * @returns {Object|null} 成员对象
 */
export function pickLeastRecentMember(members, history) {
    let best = null;
    let bestSilence = -1;
    for (const m of members) {
        let lastIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'ai' && history[i].memberId === m.memberId) { lastIdx = i; break; }
        }
        const silence = lastIdx === -1 ? history.length + 1 : history.length - lastIdx;
        if (silence > bestSilence) { bestSilence = silence; best = m; }
    }
    return best;
}

/**
 * 关键词兜底：人设里命中越多二元组，越可能相关；
 * 全部为 0 分时，选「最久没说话」的成员，保证轮转公平。
 * @returns {string[]} memberId 数组
 */
function keywordFallback({ members, history, userText, maxResponders }) {
    const userGrams = bigrams(userText);

    const scored = members.map(m => {
        const hay = `${m.displayName} ${m.persona || ''}`.toLowerCase();
        let score = 0;
        for (const g of userGrams) {
            if (hay.includes(g)) score += 1;
        }
        // 用户消息里直接出现了成员名字 → 强相关
        if (m.displayName && userText.includes(m.displayName)) score += 10;

        // 最久未发言的程度（越久越小 → 排序时越靠前）
        let lastIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'ai' && history[i].memberId === m.memberId) { lastIdx = i; break; }
        }
        const silence = lastIdx === -1 ? history.length + 1 : history.length - lastIdx;

        return { m, score, silence };
    });

    const anyHit = scored.some(s => s.score > 0);
    if (anyHit) {
        scored.sort((a, b) => (b.score - a.score) || (b.silence - a.silence));
    } else {
        // 无人命中：按「沉默时间」降序，即最久没说话的优先
        scored.sort((a, b) => b.silence - a.silence);
    }

    return scored.slice(0, maxResponders).map(s => s.m.memberId);
}

/**
 * 决定本轮发言者。
 *
 * @param {Object}   p
 * @param {Object}   p.service          - 已按「辅助模型」配置好的 ModelService 实例
 * @param {Array}    p.members          - [{ memberId, displayName, persona }]
 * @param {Array}    p.history          - [{ role:'user'|'ai', name?, memberId?, text }]
 * @param {string}   p.userText         - 用户刚发的消息（接力轮可为空）
 * @param {Object}   p.policy           - { maxResponders, contextMessages }
 * @param {string}   [p.mode]           - 'answer'（默认）| 'relay'（自动接力时追问）| 'spectator'
 * @param {string[]} [p.mentionedNames] - 用户已 @ 点名的成员名（他们必发言，编排者只负责补位）
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

    if (!service) return fallback('未配置模型，已按关键词兜底指派');

    const prompt = buildDecisionPrompt({ members, history: recent, userText, maxResponders, mode, mentionedNames });

    let raw = '';
    try {
        if (onStatus) onStatus('🎬 正在编排发言顺序…', 'orchestrating');
        raw = await service.generateText(prompt, {
            temperature: 0.3,
            maxTokens: 800,
            thinkLevel: 0,      // 丢弃思考，避免污染 JSON
            jsonFormat: true,   // Ollama → format:'json'；OpenAI 兼容 → response_format
        });
    } catch (err) {
        console.warn('[Orchestrator] 调用失败，走关键词兜底：', err);
        return fallback('编排者调用失败，已按关键词兜底指派');
    }

    const parsed = parseDecision(raw, members);
    if (!parsed) {
        console.warn('[Orchestrator] 无法解析返回内容，走关键词兜底。原始返回：', raw);
        return fallback('编排者返回格式异常，已按关键词兜底指派');
    }

    // 模型确实选了人，但返回的 id / 名字一个都对不上（多为模型杜撰）→ 同样降级
    if (parsed.rawCount > 0 && parsed.speakers.length === 0) {
        console.warn('[Orchestrator] 返回的成员标识无法识别，走关键词兜底。原始返回：', raw);
        return fallback('编排者返回了无法识别的成员，已按关键词兜底指派');
    }

    // 模型选了人，但超过上限 → 截断
    const speakers = parsed.speakers.slice(0, maxResponders);

    return {
        speakers,
        reason: parsed.reason,
        source: parsed.source,
        degraded: false,
    };
}
