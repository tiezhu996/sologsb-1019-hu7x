import { For, Show, createMemo } from 'solid-js';
import type { PendingConflict } from '../types';
import type { CodingStore } from '../store/coding-store';
import { describeUnit, renderValue } from '../utils/sync';

interface ConflictGroup {
  key: string;
  title: string;
  subtitle: string;
  items: PendingConflict[];
}

/** 冲突处理中心：同一变更单元的两份（或多份）结果都展示，研究员逐项选择后才生效 */
export default function ConflictCenter(props: { store: CodingStore; open: boolean; onClose: () => void }) {
  const ctx = createMemo(() => ({
    themeName: (id: string) => props.store.state.themes.find((theme) => theme.id === id)?.name,
    transcriptTitle: (id: string) => props.store.state.transcripts.find((item) => item.id === id)?.title
  }));

  const groups = createMemo<ConflictGroup[]>(() => {
    const map = new Map<string, ConflictGroup>();
    props.store.conflicts().forEach((conflict) => {
      let key = conflict.scope;
      let title = '';
      let subtitle = '';
      if (conflict.scope === 'theme') {
        key += `:${conflict.entityId}`;
        title = props.store.state.themes.find((theme) => theme.id === conflict.entityId)?.name
          ?? `已删除或未合并的主题 ${conflict.entityId.slice(-6)}`;
        subtitle = '主题';
      } else if (conflict.scope === 'segment') {
        key += `:${conflict.entityId}`;
        const segment = props.store.state.segments.find((item) => item.id === conflict.entityId);
        title = segment ? `${segment.time} · ${segment.speaker}` : `片段 ${conflict.entityId.slice(-6)}`;
        subtitle = segment ? segment.text.slice(0, 60) : '该片段可能尚未合并到本页视图';
      } else if (conflict.scope === 'transcript') {
        key += `:${conflict.entityId}`;
        const transcript = props.store.state.transcripts.find((item) => item.id === conflict.entityId);
        title = transcript?.title ?? `访谈 ${conflict.entityId.slice(-6)}`;
        subtitle = '访谈';
      } else {
        key = 'meta';
        title = '项目设置';
        subtitle = '编码者信息';
      }
      const group = map.get(key) ?? { key, title, subtitle, items: [] };
      group.items.push(conflict);
      map.set(key, group);
    });
    return [...map.values()];
  });

  const involvedClientIds = createMemo(() => {
    const ids = new Set<string>();
    props.store.conflicts().forEach((conflict) => conflict.candidates.forEach((candidate) => ids.add(candidate.clientId)));
    return [...ids];
  });

  const render = (unit: string, value: unknown) => renderValue(unit, value, ctx());

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide conflict-center" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <header>
          <div>
            <span class="eyebrow">FIELD-LEVEL MERGE</span>
            <h2 id="conflict-title">合并冲突处理（{props.store.conflicts().length} 个变更单元）</h2>
          </div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </header>
        <p class="modal-intro">
          不冲突的变更单元已自动合并。下列单元在两个标签页中被改成了不同结果，<strong>两份结果都原样保留、均未生效</strong>；
          请逐项选择以哪一份为准。关闭浏览器或断网期间这些冲突也不会丢失。
        </p>

        <Show when={props.store.conflicts().length > 1}>
          <div class="conflict-bulk">
            <span>批量处理：</span>
            <For each={involvedClientIds()}>
              {(clientId) => <button class="button secondary" onClick={() => props.store.adoptAllFromClient(clientId)}>全部采用「{props.store.clientLabel(clientId)}」</button>}
            </For>
          </div>
        </Show>

        <div class="conflict-groups">
          <For each={groups()} fallback={<div class="empty-state">没有待处理冲突。不同标签页对不同单元的修改会自动合并到一起。</div>}>
            {(group) => (
              <div class="conflict-group">
                <div class="conflict-group-head"><strong>{group.title}</strong><span>{group.subtitle}</span></div>
                <For each={group.items}>{(conflict) => {
                  const descriptor = describeUnit(conflict.unit);
                  return (
                    <div class="conflict-unit" data-field={descriptor.field}>
                      <div class="conflict-unit-label">变更单元 · {conflict.fieldLabel}</div>
                      <Show when={conflict.base !== undefined}>
                        <div class="conflict-option base">
                          <div class="option-meta"><span>原值（合并前基线）</span></div>
                          <pre>{render(conflict.unit, conflict.base)}</pre>
                          <button class="button secondary" onClick={() => props.store.resolveConflict(conflict.unit, null)}>保留原值</button>
                        </div>
                      </Show>
                      <For each={conflict.candidates}>{(candidate) => (
                        <div class="conflict-option" classList={{ own: candidate.clientId === props.store.clientInfo().id }}>
                          <div class="option-meta">
                            <span>{props.store.clientLabel(candidate.clientId)}</span>
                            <small>{new Date(candidate.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>
                          </div>
                          <pre>{render(conflict.unit, candidate.value)}</pre>
                          <button class="button primary" onClick={() => props.store.resolveConflict(conflict.unit, candidate.clientId)}>采用此结果</button>
                        </div>
                      )}</For>
                    </div>
                  );
                }}</For>
              </div>
            )}
          </For>
        </div>

        <footer>
          <span class="conflict-foot-note">存在未处理冲突时无法导出编码结果，以避免任何一页的改动被静默丢弃。</span>
          <button class="button primary" onClick={props.onClose}>稍后处理</button>
        </footer>
      </section>
    </div>
  );
}
