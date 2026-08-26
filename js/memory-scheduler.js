// 记忆注入调度：组装本轮要注入 Prompt 的记忆块。
// 优先级：resident/pinned 必注入 > 本轮用户命中 > 其余 active（按 activation 降序 Top-K），
// 最后受 Token 预算（字符数上限）截断。
import Constants from './constants.js';

export class MemoryScheduler {
    /**
     * @param {Array} memories 热层记忆（active/dormant）
     * @param {Set<string>|Array} hitIds 本轮命中的记忆 id
     * @param {Object} [opts]
     * @param {number} [opts.topK] 其余 active 取前 K 条
     * @param {number} [opts.maxChars] 记忆块总字符数预算
     * @returns {Array} 按优先级排序、已截断的记忆列表
     */
    static buildInjection(memories, hitIds, opts = {}) {
        const topK = opts.topK ?? 5;
        const maxChars = opts.maxChars ?? 2000;
        const hit = new Set(hitIds || []);

        const must = [];       // resident / pinned
        const hitList = [];    // 本轮命中(非固定)
        const activeOthers = [];
        for (const m of memories || []) {
            if (!m || m.state === 'archived') continue;
            if (m.resident || m.pinned) { must.push(m); continue; }
            if (hit.has(m.id)) { hitList.push(m); continue; }
            if (m.state === 'active') activeOthers.push(m);
        }

        activeOthers.sort((a, b) => (b.activation || 0) - (a.activation || 0));
        const picked = [...must, ...hitList, ...activeOthers.slice(0, topK)];

        // 去重 + 预算截断
        const seen = new Set();
        const result = [];
        let total = 0;
        for (const m of picked) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            const len = (m.content || '').length + 1;   // +1 换行
            if (total + len > maxChars) break;
            result.push(m);
            total += len;
        }
        return result;
    }

    /** 把注入列表格式化为 system prompt 尾部记忆块文本。 */
    static renderBlock(injected) {
        if (!injected || injected.length === 0) return '';
        const lines = injected.map(m => {
            const tag = m.resident ? '常驻' : (m.pinned ? '固定' : (m.state === 'dormant' ? '唤醒' : '活跃'));
            return `- (${tag}) ${m.content}`;
        });
        return `\n\n[长期记忆]\n${lines.join('\n')}\n[记忆结束]`;
    }
}

export default MemoryScheduler;
