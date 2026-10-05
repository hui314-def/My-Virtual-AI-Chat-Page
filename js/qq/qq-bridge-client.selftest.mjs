// 前端「关闭后不再周期推送」逻辑的验证脚本（Node 环境，用假的浏览器 API）
// 跑法：node js/qq/qq-bridge-client.selftest.mjs
import assert from 'node:assert';

// ---------- 假浏览器环境 ----------
const store = new Map();
const pushes = [];

globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/qq/config')) {
        pushes.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true, ready: true, readyDetail: 'ok' }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
};

const { QQBridgeClient } = await import('./qq-bridge-client.js');

let failed = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  （期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}）`}`);
    if (!ok) failed++;
}

const settingsManager = {
    getModelHost: () => 'http://localhost:11434',
    getApiKey: () => '',
    getModelName: () => 'qwen3.5:9b',
    getUsername: () => '访客',
    getBio: () => '',
    getTtsApiUrl: () => '',
    getTtsApiKey: () => '',
};

const client = new QQBridgeClient({
    settingsManager,
    getChats: () => [],
    chatRepo: null,
    modalManager: null,
    getDbName: () => 'ChatAppDB',
});

console.log('=== 关闭状态下的自动同步 ===');

// 1) 关闭 + 从未推送过 → 应该推一次（让后端知道要停）
client.writeConfig({ enabled: false, sourceChatId: null });
check('首次关闭时不应跳过（要先通知后端）', client.shouldSkipSync(), false);
let r = await client.push();
check('首次关闭会推一次', pushes.length, 1);
check('推送内容 enabled=false', pushes[0].enabled, false);

// 模拟 tick 成功后记下"这个关闭状态已同步"
client._syncedOffSnap = client.syncFingerprint(client.readConfig());
check('同一关闭状态判定为可跳过（生产方法）', client.shouldSkipSync(), true);

// 关闭状态下改了别的开关（例如勾上知识库）→ 指纹变了，不该跳过
client.writeConfig({ enabled: false, knowledgeEnabled: true });
check('关闭状态下改了选项就不跳过', client.shouldSkipSync(), false);
client._syncedOffSnap = client.syncFingerprint(client.readConfig());
check('再次同步后又可跳过', client.shouldSkipSync(), true);

// 2) 重新打开 → 状态变了，不该跳过
client.writeConfig({ enabled: true, sourceChatId: 'c1' });
check('重新打开后不跳过', client.shouldSkipSync(), false);
const r2 = await client.push();
check('重新打开会推送', pushes.length, 2);
check('推送内容 enabled=true', pushes[1].enabled, true);

// 3) 再关一次（配置变化）→ 应该推
client.writeConfig({ enabled: false });
check('重新关闭后不跳过（状态变化了）', client.shouldSkipSync(), false);
await client.push();
check('状态变化时会再推', pushes.length, 3);

console.log();
if (failed) {
    console.log(`[FAILED] ${failed} 项未通过`);
    process.exit(1);
}
console.log('[OK] 前端跳过逻辑全部通过');
