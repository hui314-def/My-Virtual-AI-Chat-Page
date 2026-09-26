// ============================================================
// 流式正文渲染器（私聊 / 群聊共用）
// ------------------------------------------------------------
// 为什么需要它？
//   主程序原本有**两处**互不相干的流式渲染，各自只有一半优点：
//     · 私聊 script.js：每个 chunk 追加一个 <span class="fade-in-text">
//       → 有逐块淡入，但括号要等**整段生成完**才统一斜体化；
//     · 群聊 group-runtime.js：每个 rAF 整段重绘 innerHTML
//       → 括号闭合立刻斜体，但重绘会打断动画，没有淡入。
//
//   本模块把两者的优点合起来：
//     1. 按 `parseParenthesesContent()` 的结果**分段**渲染；
//     2. 括号闭合的瞬间，那一段从「普通文本」就地变成 `.action-text`（斜体），
//        可见文字不变，所以不会有跳动；
//     3. 普通文本段只**追加新长出来的字符**，每块都用 `.fade-in-text` 包裹
//        → 逐块淡入，且已输出部分的动画不会被后续更新重播。
//
//   因此「括号立即斜体」与「逐字淡入」可以同时成立。
// ============================================================
import { parseParenthesesContent } from '../core/utils.js';

/**
 * 往容器里追加一段「淡入」文本（沿用主程序既有的 .fade-in-text 动画）。
 * @returns {HTMLSpanElement|null}
 */
export function appendFadeText(container, text) {
    if (!container || !text) return null;
    const span = document.createElement('span');
    span.className = 'fade-in-text';
    span.textContent = text;
    container.appendChild(span);
    return span;
}

export class StreamTextRenderer {
    /**
     * @param {HTMLElement} containerEl - 正文容器（通常是气泡里的 <p>）
     */
    constructor(containerEl) {
        this.el = containerEl;
        /** 已渲染的分段：[{ type: 'speech'|'action', node, text }] */
        this.segments = [];
        if (this.el) {
            // 用 textContent 输出，需要 pre-wrap 才能保住换行（与生成完成后的 <br> 效果一致）
            this.el.style.whiteSpace = 'pre-wrap';
        }
    }

    /** 清空并重置（复用于新一条消息时调用） */
    reset() {
        if (this.el) this.el.innerHTML = '';
        this.segments = [];
    }

    /**
     * 用「截至目前的完整正文」增量更新 DOM。
     * 幂等：重复调用同样的文本不会产生任何 DOM 变化。
     * @param {string} fullText
     */
    update(fullText) {
        if (!this.el) return;
        const parts = parseParenthesesContent(String(fullText || ''));

        // 分段变少（模型改写了已输出内容，罕见）→ 移除多余的节点
        while (this.segments.length > parts.length) {
            const seg = this.segments.pop();
            try { seg.node.remove(); } catch { /* ignore */ }
        }

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const seg = this.segments[i];

            // ---- 新分段 ----
            if (!seg) {
                this.segments[i] = part.type === 'action'
                    ? { type: 'action', node: this.#appendActionNode(part, true), text: part.raw || '' }
                    : { type: 'speech', node: this.#appendSpeechNode(part.text || ''), text: part.text || '' };
                continue;
            }

            // ---- 类型变化：括号刚闭合，speech → action ----
            // 可见文字不变（都是「（内容）」），只是换成斜体。
            // 这里**就地改写同一个 DOM 节点**（不 replaceWith），避免任何重排/闪动；
            // 同时去掉 fade-in —— 这些字早就显示出来了，不该再淡入一次。
            if (seg.type !== part.type) {
                seg.node.className = part.type === 'action' ? 'action-text' : '';
                seg.node.textContent = part.type === 'action' ? (part.raw || '') : (part.text || '');
                seg.type = part.type;
                seg.text = part.type === 'action' ? (part.raw || '') : (part.text || '');
                continue;
            }

            // ---- 已闭合的括号内容不会再变化 ----
            if (part.type === 'action') continue;

            // ---- 普通文本段：只追加新长出来的字符（每块各自淡入） ----
            const next = part.text || '';
            if (next === seg.text) continue;

            if (next.startsWith(seg.text)) {
                appendFadeText(seg.node, next.slice(seg.text.length));
                seg.text = next;
            } else {
                // 已输出内容被改写 → 整段重建（保证正确性优先）
                const node = this.#makeSpeechNode(next);
                seg.node.replaceWith(node);
                this.segments[i] = { type: 'speech', node, text: next };
            }
        }
    }

    /**
     * 定稿：把普通文本段里的多个淡入 span 压平成单个文本节点，
     * 使最终 DOM 与「生成完成后重新渲染」的结构完全一致。
     */
    finish() {
        for (const seg of this.segments) {
            if (seg.type !== 'speech') continue;
            if (!seg.node.children || seg.node.children.length === 0) continue;
            seg.node.textContent = seg.text || '';
        }
    }

    // ---------------- 内部 ----------------

    #makeActionNode(raw, animate) {
        const span = document.createElement('span');
        span.className = animate ? 'action-text fade-in-text' : 'action-text';
        span.textContent = raw;
        return span;
    }

    #makeSpeechNode(text) {
        const wrap = document.createElement('span');
        appendFadeText(wrap, text);
        return wrap;
    }

    #appendActionNode(part, animate) {
        const node = this.#makeActionNode(part.raw || '', animate);
        this.el.appendChild(node);
        return node;
    }

    #appendSpeechNode(text) {
        const node = this.#makeSpeechNode(text);
        this.el.appendChild(node);
        return node;
    }
}

export default StreamTextRenderer;
