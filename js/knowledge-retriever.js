// 知识库检索:多库并发查询 + 相似度合并排序
// 从 script.js 分离(阶段2),风格与其余 js/ 模块一致(构造注入依赖)
import Constants from './constants.js';

export class KnowledgeRetriever {
    /**
     * @param {Object} deps
     * @param {() => Object} deps.getModalManager 惰性获取 modalManager(运行时读取 kbManager.apiBase)
     */
    constructor({ getModalManager }) {
        this.getModalManager = getModalManager;
    }

    /** 运行时才解析 modalManager 引用 */
    get modalManager() {
        return this.getModalManager();
    }

    /**
     * 从多个知识库中检索与查询相关的文档片段
     * @param {string[]} kbIds - 知识库ID列表
     * @param {string} query - 用户查询文本
     * @returns {Promise<Array<{content: string, filename: string, score: number}>>}
     */
    async retrieveKnowledge(kbIds, query) {
        const base = this.modalManager.kbManager.apiBase;
        const promises = kbIds.map(async (kbId) => {
            try {
                const response = await fetch(`${base}/knowledge_bases/${kbId}/search`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, top_k: Constants.KB_TOP_K })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                return (data.results || []).map(item => ({
                    content: item.content,
                    filename: item.filename || '未知',
                    score: item.score || 0
                }));
            } catch (err) {
                console.warn(`知识库 ${kbId} 检索失败:`, err);
                return [];
            }
        });
        const allResults = await Promise.all(promises);
        const merged = allResults.flat();
        merged.sort((a, b) => (b.score || 0) - (a.score || 0));
        return merged.slice(0, Constants.KB_MAX_RESULTS); // 最多取N条
    }
}
