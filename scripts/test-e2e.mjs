// 端到端冒烟：fake-indexeddb + db 层 + sync 引擎
// 模拟两个标签页共享同一个 IndexedDB（重开页面后数据仍在）
// 运行前需安装一次性开发依赖：npm install --no-save fake-indexeddb
import 'fake-indexeddb/auto';
globalThis.window ??= globalThis;
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [syncBundle, dbBundle] = await Promise.all([
  build({ entryPoints: ['src/utils/sync.ts'], bundle: true, format: 'esm', write: false, platform: 'node' }),
  build({ entryPoints: ['src/utils/db.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
]);
const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
const syncFile = join(dir, 'sync.mjs');
const dbFile = join(dir, 'db.mjs');
writeFileSync(syncFile, syncBundle.outputFiles[0].text);
writeFileSync(dbFile, dbBundle.outputFiles[0].text);

const sync = await import(`file://${syncFile}`);
const db = await import(`file://${dbFile}`);
const { flattenState, diffUnits, reconcile, reconstructState, makeMetaFromState } = sync;

let failures = 0;
const assert = (cond, message) => {
  if (cond) console.log(`  ✓ ${message}`);
  else { failures += 1; console.error(`  ✗ ${message}`); }
};

const seed = {
  revision: 1, updatedAt: 't0', activeTranscriptId: 'tr1', activeSegmentId: 's1', activeThemeId: 't1', coderA: '甲', coderB: '乙',
  transcripts: [{ id: 'tr1', title: '访谈一', participant: '受访者', importedAt: 't0', sourceName: 'f' }],
  themes: [{ id: 't1', name: '教育', parentId: null, color: '#0', definition: '', memo: '', examples: [] }],
  segments: [{ id: 's1', transcriptId: 'tr1', order: 0, speaker: '问', time: '00:01', text: '原文', assignments: { A: [], B: [] }, note: '' }],
  audit: []
};

// ---- 首次打开：写入共享基线 ----
let meta = makeMetaFromState(seed, 't0');
await db.writeMeta(meta);

const mkClient = (id, label) => ({ clientId: id, label, createdAt: 't0', lastWriteAt: 't1', lastSeq: 0, changes: [], events: [], state: null });
const apply = async (records, result) => {
  for (const [cid, items] of Object.entries(result.prune)) {
    const rec = records.find((r) => r.clientId === cid);
    if (!rec) continue;
    const seqs = new Set(items.map((i) => i.seq));
    rec.changes = rec.changes.filter((c) => !seqs.has(c.seq));
  }
  for (const [cid, ids] of Object.entries(result.clearEventIds)) {
    const rec = records.find((r) => r.clientId === cid);
    if (rec) {
      const s = new Set(ids);
      rec.events = (rec.events ?? []).filter((e) => !s.has(e.id));
    }
  }
  for (const rec of records) await db.putClient(rec);
};

console.log('E2E 1：两个标签页改不同单元，提交后自动合并并落库');
{
  const c1 = mkClient('tab-1', '标签页 1');
  const c2 = mkClient('tab-2', '标签页 2');
  const s1 = structuredClone(seed); s1.themes[0].name = '教育经历';
  const s2 = structuredClone(seed); s2.segments[0].assignments.A = ['t1'];
  c1.changes = Object.entries(diffUnits(flattenState(seed), flattenState(s1))).map(([u, v], i) => ({ unit: u, value: v, at: 't1', seq: i + 1 }));
  c2.changes = Object.entries(diffUnits(flattenState(seed), flattenState(s2))).map(([u, v], i) => ({ unit: u, value: v, at: 't2', seq: i + 1 }));
  c1.lastSeq = c1.changes.length; c2.lastSeq = c2.changes.length;
  await db.putClient(c1); await db.putClient(c2);

  const freshMeta = await db.readMeta();
  const clients = await db.readAllClients();
  const result = reconcile(freshMeta, clients, 't3');
  assert(result.conflicts.length === 0, '无冲突');
  await db.compareSetMeta(freshMeta.baseRev, result.meta);
  const records = clients;
  await apply(records, result);
  const merged = reconstructState(result.effective, { ...seed, audit: result.meta.audit });
  assert(merged.themes[0].name === '教育经历', '名称合入');
  assert(merged.segments[0].assignments.A.includes('t1'), 'A 判断合入');
}

console.log('E2E 2：同一单元两页改出不同结果 → 冲突落库；重开浏览器后仍可读出');
{
  const clients = await db.readAllClients();
  const c1 = clients.find((c) => c.clientId === 'tab-1');
  const c2 = clients.find((c) => c.clientId === 'tab-2');
  // 基于已合并基线各自再改备忘
  const baseState = reconstructState((await db.readMeta()).base, { ...seed, audit: [] });
  const s1 = structuredClone(baseState); s1.themes[0].definition = '定义来自标签页1';
  const s2 = structuredClone(baseState); s2.themes[0].definition = '定义来自标签页2';
  c1.changes.push(...Object.entries(diffUnits(flattenState(baseState), flattenState(s1))).map(([u, v], i) => ({ unit: u, value: v, at: 't4', seq: c1.lastSeq + i + 1 })));
  c2.changes.push(...Object.entries(diffUnits(flattenState(baseState), flattenState(s2))).map(([u, v], i) => ({ unit: u, value: v, at: 't5', seq: c2.lastSeq + i + 1 })));
  c1.lastSeq += 1; c2.lastSeq += 1;
  await db.putClient(c1); await db.putClient(c2);

  const freshMeta = await db.readMeta();
  const allClients = await db.readAllClients();
  const result = reconcile(freshMeta, allClients, 't6');
  assert(result.conflicts.length === 1, '检出 1 个冲突');
  // 未决时元数据不应推进覆盖（folded=false 时调用方不写 meta；这里显式断言冲突仍在）
  const conflictUnit = 'theme:t1:definition';
  assert(result.conflicts[0].unit === conflictUnit, '冲突单元正确');

  // 模拟“关闭并重新打开浏览器”：清空内存，仅从 IndexedDB 重新读取
  const reopenedMeta = await db.readMeta();
  const reopenedClients = await db.readAllClients();
  const reopened = reconcile(reopenedMeta, reopenedClients, 't7');
  assert(reopened.conflicts.length === 1, '重开后未处理冲突仍然保留');
  const cands = reopened.conflicts[0].candidates.map((c) => c.value);
  assert(cands.includes('定义来自标签页1') && cands.includes('定义来自标签页2'), '两份结果重开后都还在');
}

console.log('E2E 3：研究员选择标签页1的定义，裁决落库，重开后以裁决结果为准，且可以导出');
{
  const freshMeta = await db.readMeta();
  const clients = await db.readAllClients();
  const probe = reconcile(freshMeta, clients, 't8');
  const conflict = probe.conflicts[0];
  const chosen = conflict.candidates.find((c) => c.value === '定义来自标签页1');
  const discarded = conflict.candidates.filter((c) => c.value !== chosen.value).map((c) => c.value);
  const withResolution = {
    ...freshMeta,
    resolutions: { [conflict.unit]: { value: chosen.value, clientId: chosen.clientId, at: 't9', discarded } },
    resolutionLog: [...(freshMeta.resolutionLog ?? []), { id: 'r1', at: 't9', unit: conflict.unit, label: conflict.fieldLabel, kept: chosen.value, discarded }]
  };
  const resolved = reconcile(withResolution, clients, 't9');
  await apply(clients, resolved);
  const ok = await db.compareSetMeta(freshMeta.baseRev, resolved.meta);
  assert(ok, '裁决 CAS 写入成功');
  assert(resolved.meta.base['theme:t1:definition'] === '定义来自标签页1', '裁决进入基线');

  // 再跑两轮对账模拟心跳收敛
  let meta2 = resolved.meta;
  for (let i = 0; i < 3; i += 1) {
    const cc = await db.readAllClients();
    const rr = reconcile(meta2, cc, `t${10 + i}`);
    await apply(cc, rr);
    meta2 = rr.meta;
  }
  // 重开
  const finalMeta = await db.readMeta();
  const finalClients = await db.readAllClients();
  const finalResult = reconcile(finalMeta, finalClients, 't20');
  assert(finalResult.conflicts.length === 0, '重开后无未决冲突');
  const finalState = reconstructState(finalResult.effective, { ...seed, audit: finalResult.meta.audit });
  assert(finalState.themes[0].definition === '定义来自标签页1', '导出依据为研究员选定的结果');
  const exported = JSON.stringify(finalState);
  assert(exported.includes('定义来自标签页1') && !exported.includes('定义来自标签页2'), '导出内容只含已生效结果');
  assert(finalMeta.resolutionLog.length >= 1, '被搁置的结果在裁决历史中留有凭据');
}

console.log(failures === 0 ? '\n端到端冒烟全部通过 ✓' : `\n${failures} 个失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
