// 字段级同步引擎的核心场景验证：用 esbuild 即时转译 TS 后在 Node 中运行
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const result = await build({
  entryPoints: ['src/utils/sync.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node'
});
const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
const file = join(dir, 'sync.mjs');
writeFileSync(file, result.outputFiles[0].text);
const { flattenState, diffUnits, reconcile, reconstructState, makeMetaFromState, deepEqual } = await import(`file://${file}`);

let failures = 0;
const assert = (cond, message) => {
  if (cond) console.log(`  ✓ ${message}`);
  else { failures += 1; console.error(`  ✗ ${message}`); }
};

/** 按 store 的真实行为，把对账结果中的剪枝应用到客户端记录上 */
const applyPruning = (records, result) => {
  Object.entries(result.prune).forEach(([clientId, items]) => {
    const record = records.find((r) => r.clientId === clientId);
    if (!record) return;
    const seqs = new Set(items.map((item) => item.seq));
    record.changes = record.changes.filter((entry) => !seqs.has(entry.seq));
  });
  Object.entries(result.clearEventIds).forEach(([clientId, ids]) => {
    const record = records.find((r) => r.clientId === clientId);
    if (!record) return;
    const idSet = new Set(ids);
    record.events = (record.events ?? []).filter((event) => !idSet.has(event.id));
  });
};

// 构造一份最小工作状态
const makeState = () => ({
  revision: 1, updatedAt: 't0', activeTranscriptId: 'tr1', activeSegmentId: 's1', activeThemeId: 't1',
  coderA: '甲', coderB: '乙',
  transcripts: [{ id: 'tr1', title: '访谈一', participant: '受访者', importedAt: 't0', sourceName: 'f' }],
  themes: [
    { id: 't1', name: '教育', parentId: null, color: '#000', definition: '定义甲', memo: '', examples: [] },
    { id: 't2', name: '家庭', parentId: null, color: '#111', definition: '', memo: '备忘乙', examples: ['例1'] }
  ],
  segments: [{ id: 's1', transcriptId: 'tr1', order: 0, speaker: '问', time: '00:01', text: '原文', assignments: { A: ['t1'], B: [] }, note: '' }],
  audit: []
});

let seq1 = 0;
let seq2 = 0;
const client = (id, label, changes, state) => ({
  clientId: id, label, createdAt: 't0', lastWriteAt: 't1', lastSeq: changes.length,
  changes, events: [], state
});
const change = (unit, value, at, seq) => ({ unit, value, at, seq });

console.log('场景 1：不同变更单元自动合并（名称 vs 定义；A 判断 vs B 判断）');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const a = structuredClone(base);
  a.themes[0].name = '教育经历';                       // 标签页1改主题名称
  a.segments[0].assignments.A = ['t1', 't2'];          // 标签页1改 A 判断
  const b = structuredClone(base);
  b.themes[0].definition = '定义乙';                   // 标签页2改同一主题定义
  b.themes[1].memo = '备忘乙改';                        // 标签页2改另一主题备忘
  b.segments[0].assignments.B = ['t2'];                // 标签页2改 B 判断
  const ca = diffUnits(flattenState(base), flattenState(a));
  const cb = diffUnits(flattenState(base), flattenState(b));
  const r = reconcile(meta, [
    client('c1', '标签页1', Object.entries(ca).map(([unit, value], i) => change(unit, value, 't1', ++seq1)), a),
    client('c2', '标签页2', Object.entries(cb).map(([unit, value], i) => change(unit, value, 't2', ++seq2)), b)
  ], 't3');
  assert(r.conflicts.length === 0, '无冲突');
  const merged = reconstructState(r.effective, { ...base, audit: r.meta.audit });
  assert(merged.themes.find((t) => t.id === 't1').name === '教育经历', '名称改动合入');
  assert(merged.themes.find((t) => t.id === 't1').definition === '定义乙', '定义改动合入');
  assert(merged.themes.find((t) => t.id === 't2').memo === '备忘乙改', '另一主题备忘记改动合入');
  assert(deepEqual(merged.segments[0].assignments.A, ['t1', 't2']), 'A 判断改动合入');
  assert(deepEqual(merged.segments[0].assignments.B, ['t2']), 'B 判断改动合入');
}

console.log('场景 2：同一单元两份不同结果都保留，且不自动生效');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const changes1 = [change('theme:t1:name', '名称一', 't1', 1)];
  const changes2 = [change('theme:t1:name', '名称二', 't2', 1)];
  const r = reconcile(meta, [client('c1', '标签页1', changes1, base), client('c2', '标签页2', changes2, base)], 't3');
  assert(r.conflicts.length === 1, '检出 1 个冲突单元');
  assert(r.conflicts[0].candidates.length === 2, '两份候选都保留');
  assert(r.conflicts[0].candidates.some((c) => c.value === '名称一'), '候选含标签页1结果');
  assert(r.conflicts[0].candidates.some((c) => c.value === '名称二'), '候选含标签页2结果');
  assert(r.effective['theme:t1:name'] === base.themes[0].name, '未决期间保持原值，不静默采用任何一方');
  assert(r.meta.base['theme:t1:name'] === base.themes[0].name, '基线不被未决候选污染');
}

console.log('场景 3：研究员选择后生效，被搁置一方不会复活；另一单元仍保留');
{
  const base = makeState();
  let meta = makeMetaFromState(base, 't0');
  const rec1 = client('c1', '标签页1', [
    change('theme:t1:name', '名称一', 't1', 1),
    change('theme:t1:definition', '定义一', 't1', 2)
  ], base);
  const rec2 = client('c2', '标签页2', [
    change('theme:t1:name', '名称二', 't2', 1),
    change('theme:t1:definition', '定义二', 't2', 1)
  ], base);
  let r = reconcile(meta, [rec1, rec2], 't3');
  assert(r.conflicts.length === 2, '两个单元各自独立冲突');
  // 裁决名称单元采用标签页2
  const nameConflict = r.conflicts.find((c) => c.unit === 'theme:t1:name');
  const chosen = nameConflict.candidates.find((c) => c.value === '名称二');
  const discarded = nameConflict.candidates.filter((c) => c.value !== '名称二').map((c) => c.value);
  meta = { ...r.meta, resolutions: { 'theme:t1:name': { value: '名称二', clientId: chosen.clientId, at: 't4', discarded } }, resolutionLog: [], audit: r.meta.audit };
  applyPruning([rec1, rec2], r);
  r = reconcile(meta, [rec1, rec2], 't4');
  applyPruning([rec1, rec2], r);
  assert(r.meta.base['theme:t1:name'] === '名称二', '裁决写入基线');
  assert(r.conflicts.length === 1 && r.conflicts[0].unit === 'theme:t1:definition', '定义单元仍是未决冲突');
  assert(rec1.changes.filter((c) => c.unit === 'theme:t1:name').length === 0, '标签页1的名称旧日志被剪除');
  assert(rec2.changes.filter((c) => c.unit === 'theme:t1:name').length === 0, '标签页2的名称旧日志被剪除');
  // 再对账一次（模拟存活标签页下一轮心跳），裁决应已彻底消化而不复活
  r = reconcile(r.meta, [rec1, rec2], 't5');
  assert(!r.conflicts.some((c) => c.unit === 'theme:t1:name'), '名称冲突不会复活');
  assert(r.meta.base['theme:t1:name'] === '名称二', '裁决结果持续生效');
}

console.log('场景 4：断网期间两页各自多次修改同一单元，恢复后只比对双方最终结果');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  // 标签页1离线连改三次：X -> Y -> Z
  const rec1 = client('c1', '标签页1', [
    change('segment:s1:assignA', ['t1'], 't1', 1),
    change('segment:s1:assignA', ['t2'], 't2', 2),
    change('segment:s1:assignA', ['t1', 't2'], 't3', 3)
  ], base);
  // 标签页2离线只改成清空
  const rec2 = client('c2', '标签页2', [change('segment:s1:assignA', [], 't2', 1)], base);
  const r = reconcile(meta, [rec1, rec2], 't9');
  assert(r.conflicts.length === 1, '最终结果不同 → 1 个冲突');
  const values = r.conflicts[0].candidates.map((c) => JSON.stringify(c.value)).sort();
  assert(values.includes('[]') && values.includes('["t1","t2"]'), '只保留双方最终结果（中间版本不参与）');
  applyPruning([rec1, rec2], r);
  assert(rec1.changes.length === 1 && deepEqual(rec1.changes[0].value, ['t1', 't2']), '旧序号日志被剪除，只留最新');
}

console.log('场景 5：主题判断按集合归一化，顺序不同不算冲突');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const rec1 = client('c1', '页1', [change('segment:s1:assignA', ['t1', 't2'], 't1', 1)], base);
  const rec2 = client('c2', '页2', [change('segment:s1:assignA', ['t2', 't1'], 't2', 1)], base);
  const r = reconcile(meta, [rec1, rec2], 't3');
  assert(r.conflicts.length === 0, '同集合不同顺序自动合并');
}

console.log('场景 6：只有一方改动的单元自动合入，另一方未触碰不丢任何内容');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const a = structuredClone(base);
  a.themes[1].examples = ['例1', '例2'];
  const ca = diffUnits(flattenState(base), flattenState(a));
  const r = reconcile(meta, [
    client('c1', '页1', Object.entries(ca).map(([u, v], i) => change(u, v, 't1', i + 1)), a),
    client('c2', '页2', [], base)
  ], 't3');
  const merged = reconstructState(r.effective, { ...base, audit: r.meta.audit });
  assert(deepEqual(merged.themes.find((t) => t.id === 't2').examples, ['例1', '例2']), '单方新增示例自动合入');
  assert(merged.themes.length === 2 && merged.segments.length === 1, '其余内容完整保留');
  assert(r.conflicts.length === 0, '无冲突');
}

console.log('场景 7：删除主题后墓碑保留、字段移除，引用该主题的片段仍保留');
{
  const base = makeState();
  const meta0 = makeMetaFromState(base, 't0');
  const a = structuredClone(base);
  a.themes = a.themes.filter((t) => t.id !== 't2');
  a.segments[0].assignments.A = a.segments[0].assignments.A.filter((id) => id !== 't2');
  const ca = diffUnits(flattenState(base), flattenState(a));
  const changes = Object.entries(ca).map(([u, v], i) => change(u, v, 't1', i + 1));
  const records = [client('c1', '页1', changes, a)];
  const r = reconcile(meta0, records, 't2');
  assert(r.meta.base['theme:t2:alive'] === false, '主题被标记删除（墓碑保留）');
  applyPruning(records, r);
  const r2 = reconcile(r.meta, records, 't3');
  assert(r2.meta.base['theme:t2:alive'] === false && r2.meta.base['theme:t2:name'] === null, '墓碑保留、字段值已移除');
  const merged = reconstructState(r2.effective, { ...base, audit: r2.meta.audit });
  assert(merged.themes.length === 1 && merged.segments.length === 1, '片段保留，主题移除');

  // 迟到的离线旧编辑不能让已删除主题复活
  const late = client('c2', '页2', [change('theme:t2:name', '家庭改名', 't4', 1)], base);
  const r3 = reconcile(r2.meta, [late], 't5');
  applyPruning([late], r3);
  const merged3 = reconstructState(r3.effective, { ...base, audit: r3.meta.audit });
  assert(merged3.themes.length === 1, '迟到的字段编辑不会复活已删除主题');
  assert(late.changes.length === 0, '迟到编辑被作为过期日志剪除');
}

console.log('场景 8：裁决保留原值时，双方改动都被搁置且归档');
{
  const base = makeState();
  let meta = makeMetaFromState(base, 't0');
  const rec1 = client('c1', '页1', [change('segment:s1:note', '备忘一', 't1', 1)], base);
  const rec2 = client('c2', '页2', [change('segment:s1:note', '备忘二', 't2', 1)], base);
  let r = reconcile(meta, [rec1, rec2], 't3');
  assert(r.conflicts.length === 1, '备忘冲突检出');
  meta = {
    ...r.meta,
    resolutions: { 'segment:s1:note': { value: '', clientId: null, at: 't4', discarded: ['备忘一', '备忘二'] } },
    resolutionLog: [{ id: 'r1', at: 't4', unit: 'segment:s1:note', label: '编码备忘', kept: '', discarded: ['备忘一', '备忘二'] }],
    audit: r.meta.audit
  };
  r = reconcile(meta, [rec1, rec2], 't4');
  assert(r.meta.base['segment:s1:note'] === '', '保留原值（空）生效');
  assert(r.conflicts.length === 0, '冲突解除');
  applyPruning([rec1, rec2], r);
  assert(rec1.changes.length === 0 && rec2.changes.length === 0, '双方日志均已剪除');
}

console.log('场景 9：两页各自新建不同实体，自动合并为两份都在');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const newTheme1 = { id: 't9', name: '新主题一', parentId: null, color: '#1', definition: '', memo: '', examples: [] };
  const newTheme2 = { id: 'ta', name: '新主题二', parentId: null, color: '#2', definition: '', memo: '', examples: [] };
  const a = structuredClone(base); a.themes.push(newTheme1);
  const b = structuredClone(base); b.themes.push(newTheme2);
  const records = [
    client('c1', '页1', Object.entries(diffUnits(flattenState(base), flattenState(a))).map(([u, v], i) => change(u, v, 't1', i + 1)), a),
    client('c2', '页2', Object.entries(diffUnits(flattenState(base), flattenState(b))).map(([u, v], i) => change(u, v, 't2', i + 1)), b)
  ];
  const r = reconcile(meta, records, 't3');
  assert(r.conflicts.length === 0, '新建不同实体不冲突');
  const merged = reconstructState(r.effective, { ...base, audit: r.meta.audit });
  assert(merged.themes.some((t) => t.id === 't9') && merged.themes.some((t) => t.id === 'ta'), '两个新主题都合入');
}

console.log('场景 10：一方删除主题、另一方同时修改其名称 → 两份都保留，不静默删除');
{
  const base = makeState();
  const meta = makeMetaFromState(base, 't0');
  const a = structuredClone(base);
  a.themes = a.themes.filter((t) => t.id !== 't2');
  const b = structuredClone(base);
  b.themes.find((t) => t.id === 't2').name = '家庭改名';
  const records = [
    client('c1', '删除方', Object.entries(diffUnits(flattenState(base), flattenState(a))).map(([u, v], i) => change(u, v, 't1', i + 1)), a),
    client('c2', '编辑方', Object.entries(diffUnits(flattenState(base), flattenState(b))).map(([u, v], i) => change(u, v, 't2', i + 1)), b)
  ];
  const r = reconcile(meta, records, 't3');
  const aliveConflict = r.conflicts.find((c) => c.unit === 'theme:t2:alive');
  const nameConflict = r.conflicts.find((c) => c.unit === 'theme:t2:name');
  assert(Boolean(aliveConflict), '删除与保留在 alive 单元上形成冲突');
  assert(Boolean(nameConflict), '改名结果也作为候选保留');
  assert(aliveConflict.candidates.some((c) => c.value === false), '删除结果（false）保留为候选');
  assert(nameConflict.candidates.some((c) => c.value === '家庭改名'), '改名结果保留为候选');
}

console.log('场景 11：删除冲突裁决——选择保留则删除方的 null 不落库；选择删除则实体消失');
{
  const base = makeState();
  let meta = makeMetaFromState(base, 't0');
  const a = structuredClone(base);
  a.themes = a.themes.filter((t) => t.id !== 't2');
  const b = structuredClone(base);
  b.themes.find((t) => t.id === 't2').name = '家庭改名';
  const records = [
    client('c1', '删除方', Object.entries(diffUnits(flattenState(base), flattenState(a))).map(([u, v], i) => change(u, v, 't1', i + 1)), a),
    client('c2', '编辑方', Object.entries(diffUnits(flattenState(base), flattenState(b))).map(([u, v], i) => change(u, v, 't2', i + 1)), b)
  ];
  let r = reconcile(meta, records, 't3');
  applyPruning(records, r);

  // 裁决 alive：保留（编辑方）。实际 store 会反复对账直到裁决彻底消化
  const aliveUnit = 'theme:t2:alive';
  meta = { ...r.meta, resolutions: { [aliveUnit]: { value: true, clientId: 'c2', at: 't4', discarded: [false] } }, resolutionLog: [], audit: r.meta.audit };
  for (let i = 0; i < 4; i += 1) {
    r = reconcile(meta, records, `t${5 + i}`);
    applyPruning(records, r);
    meta = r.meta;
  }
  assert(r.meta.base[aliveUnit] === true, '保留裁决生效，实体存活');
  assert(r.meta.base['theme:t2:name'] === '家庭改名', '编辑方的名称改动随后正常合入');
  const kept = reconstructState(r.effective, { ...base, audit: r.meta.audit });
  assert(kept.themes.find((t) => t.id === 't2')?.name === '家庭改名', '重建结果：主题保留且为新名称');

  // 再模拟另一组：裁决删除
  meta = makeMetaFromState(base, 't0');
  const records2 = [
    client('c1', '删除方', Object.entries(diffUnits(flattenState(base), flattenState(a))).map(([u, v], i) => change(u, v, 't1', i + 1)), a),
    client('c2', '编辑方', Object.entries(diffUnits(flattenState(base), flattenState(b))).map(([u, v], i) => change(u, v, 't2', i + 1)), b)
  ];
  r = reconcile(meta, records2, 't3');
  applyPruning(records2, r);
  meta = { ...r.meta, resolutions: { [aliveUnit]: { value: false, clientId: 'c1', at: 't4', discarded: [true] } }, resolutionLog: [], audit: r.meta.audit };
  for (let i = 0; i < 4; i += 1) {
    r = reconcile(meta, records2, `t${5 + i}`);
    applyPruning(records2, r);
    meta = r.meta;
  }
  assert(r.meta.base[aliveUnit] === false, '删除裁决生效：墓碑落下');
  const deleted = reconstructState(r.effective, { ...base, audit: r.meta.audit });
  assert(deleted.themes.length === 1, '重建结果：被删主题消失');
}

console.log(failures === 0 ? '\n全部场景通过 ✓' : `\n${failures} 个断言失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
