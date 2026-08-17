// 话题级增量同步的 diff 引擎：对比「上次已同步快照」与当前会话，产出最小 patch。
// 纯函数、无 DOM/IndexedDB 依赖，便于单元测试。

// 参与「元数据字段级」对比的会话字段
const META_KEYS = ['title', 'date', 'pinned', 'currentTopicIndex', 'settings'];

/**
 * 防御性补齐身份标识：话题补 id、消息补 uid（仅当缺失时，幂等）。
 * 补发规则按位置确定（__t<话题下标> / __m<话题下标>_<消息下标>），
 * 仅用于迁移历史旧数据；补齐后的 id/uid 会随首次同步持久化。
 */
export function ensureChatIdentity(chat) {
    if (!chat || typeof chat !== 'object') return chat;
    const topics = Array.isArray(chat.topics) ? chat.topics : [];
    topics.forEach((topic, ti) => {
        if (!topic || typeof topic !== 'object') return;
        if (topic.id === undefined || topic.id === null) topic.id = '__t' + ti;
        const msgs = Array.isArray(topic.messages) ? topic.messages : [];
        msgs.forEach((m, mi) => {
            if (m && typeof m === 'object' && (m.uid === undefined || m.uid === null)) {
                m.uid = '__m' + ti + '_' + mi;
            }
        });
    });
    return chat;
}

/** 深拷贝（JSON 序列化）+ 补齐身份，返回纯数据对象，避免 Date / 引用副作用。 */
export function cloneChat(chat) {
    try {
        return ensureChatIdentity(JSON.parse(JSON.stringify(chat)));
    } catch {
        return chat;
    }
}

/**
 * 计算会话增量 patch。
 * @param {Object|null} snapshot 上次成功同步的快照；null 表示首次同步
 * @param {Object} current 当前会话对象
 * @returns {{isNew:boolean, hasChanges:boolean, meta:Object, topics:Array, removeTopicIds:Array}}
 */
export function diffChat(snapshot, current) {
    const cur = cloneChat(current);
    if (!snapshot) {
        return { isNew: true, hasChanges: true, meta: {}, topics: [], removeTopicIds: [] };
    }
    const snap = cloneChat(snapshot);

    // 1) 元数据字段级 diff
    const meta = {};
    for (const k of META_KEYS) {
        if (JSON.stringify(cur[k]) !== JSON.stringify(snap[k])) meta[k] = cur[k];
    }

    // 2) 话题级 diff：按 id 定位
    const snapById = new Map();
    for (const t of (snap.topics || [])) {
        if (t && t.id !== undefined && t.id !== null) snapById.set(String(t.id), t);
    }
    const curIds = new Set((cur.topics || []).map(t => String(t.id)));

    const topics = [];
    for (const t of (cur.topics || [])) {
        const st = snapById.get(String(t.id));
        if (!st || JSON.stringify(st) !== JSON.stringify(t)) topics.push(t);
    }

    const removeTopicIds = [];
    for (const [tid, st] of snapById) {
        if (!curIds.has(tid)) removeTopicIds.push(st.id);
    }

    const hasChanges = Object.keys(meta).length > 0 || topics.length > 0 || removeTopicIds.length > 0;
    return { isNew: false, hasChanges, meta, topics, removeTopicIds };
}

export default { diffChat, cloneChat, ensureChatIdentity };
