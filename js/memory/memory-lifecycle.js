// DMAE 生命周期层：管理记忆条目的活跃度与 Active/Dormant/Archived 状态迁移。
// 纯函数式设计（不依赖 DOM / 存储 / 网络），便于单元测试与复用。
// 白皮书公式参考：plans/记忆系统技术计划书.md §3.4。
import Constants from '../core/constants.js';

function deriveState(A) {
    if (A >= Constants.MEMORY_ACTIVE_THRESHOLD) return 'active';
    if (A > 0) return 'dormant';
    return 'archived';
}

export class MemoryLifecycle {
    /**
     * 对一条记忆执行一轮更新。
     * @param {Object} memory MemoryRecord
     * @param {boolean} userHit 本轮用户是否命中
     * @param {boolean} modelHit 本轮模型是否命中
     * @returns {Object} 更新后的记忆(不修改原对象)
     */
    static updateTurn(memory, userHit, modelHit) {
        if (!memory) return memory;
        if (memory.state === 'archived') return memory;      // Archived 不执行更新方程
        if (memory.resident) return { ...memory, state: 'active' };  // 常驻不衰减

        const A = memory.activation ?? 0;
        const Su = memory.userSilence ?? 0;
        const Sm = memory.modelSilence ?? 0;
        const I = memory.intrinsicValue || 1;
        const hits = memory.recentUserHits || [];
        const nw = hits.reduce((s, v) => s + (v ? 1 : 0), 0);  // 最近 w 轮命中次数

        // —— 用户有效奖励(用命中前的沉默值;久别重逢 × 饱和抑制 × 高频抑制) ——
        let Ru = 0;
        if (userHit) {
            const reunion = 1 + Constants.MEMORY_GAMMA * Math.log(1 + Su);
            const sat = Math.pow(1 - A / Constants.MEMORY_ACTIVATION_MAX, Constants.MEMORY_SATURATION_P);
            const repeat = 1 / (1 + Constants.MEMORY_RHO * nw);
            Ru = Constants.MEMORY_B_U * reunion * sat * repeat;
        }
        // —— 模型维护奖励(仅 Active;用户沉默越久越小) ——
        const Rm = (modelHit && A >= Constants.MEMORY_ACTIVE_THRESHOLD)
            ? Constants.MEMORY_B_M * Math.exp(-Constants.MEMORY_LAMBDA * Su)
            : 0;
        // —— 沉默衰减(命中当轮不因历史用户沉默二次扣分,白皮书 5.10) ——
        const Du = userHit ? 0 : Constants.MEMORY_ALPHA * Su * Su;
        const Dm = Constants.MEMORY_BETA * Sm * Sm;
        const D = (Du + Dm) / Math.sqrt(I);

        let newA = A + Ru + Rm - D;
        newA = Math.max(0, Math.min(Constants.MEMORY_ACTIVATION_MAX, newA));

        const newSu = userHit ? 0 : Su + 1;
        const newSm = modelHit ? 0 : Sm + 1;
        const newHits = [...hits, userHit ? 1 : 0];
        while (newHits.length > Constants.MEMORY_REPEAT_WINDOW) newHits.shift();

        return {
            ...memory,
            activation: newA,
            userSilence: newSu,
            modelSilence: newSm,
            recentUserHits: newHits,
            state: deriveState(newA),
            updatedAt: Date.now(),
        };
    }

    /** 归档唤醒：用户明确命中 Archived 记忆时，至少恢复到 Active 阈值。 */
    static wakeUp(memory) {
        if (!memory) return memory;
        const A = Math.min(
            Constants.MEMORY_ACTIVATION_MAX,
            Constants.MEMORY_ACTIVE_THRESHOLD + Constants.MEMORY_WAKEUP_BONUS
        );
        return {
            ...memory,
            activation: A,
            state: 'active',
            userSilence: 0,
            modelSilence: 0,
            recentUserHits: [1],
            archivedAt: null,
            updatedAt: Date.now(),
        };
    }

    /** 强制归档（A 归零并标记 archived）。 */
    static archive(memory) {
        if (!memory) return memory;
        return { ...memory, activation: 0, state: 'archived', archivedAt: Date.now(), updatedAt: Date.now() };
    }
}

export default MemoryLifecycle;
