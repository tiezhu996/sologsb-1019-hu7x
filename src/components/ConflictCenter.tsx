import { For, Show, createSignal } from 'solid-js';
import { Button, Paper, Typography } from '@suid/material';
import type { PendingConflict } from '../types';
import type { CodingStore } from '../store/coding-store';

export default function ConflictCenter(props: { store: CodingStore }) {
  const [tab, setTab] = createSignal<'pending' | 'resolved'>('pending');

  const groupHint = (conflict: PendingConflict) => {
    if (conflict.kind.startsWith('theme')) return '主题单元';
    if (conflict.kind.startsWith('segment')) return '片段单元';
    if (conflict.kind.startsWith('transcript')) return '访谈单元';
    return '项目单元';
  };

  return (
    <Paper class="panel conflict-panel" elevation={0}>
      <div class="panel-heading conflict-heading">
        <div>
          <Typography variant="overline">MERGE CONFLICTS</Typography>
          <Typography variant="h6">字段级合并冲突台</Typography>
        </div>
        <div class="conflict-badge" classList={{ has: props.store.pendingConflicts().length > 0 }}>
          {props.store.pendingConflicts().length} 条待处理
        </div>
      </div>

      <div class="inspector-tabs">
        <button classList={{ active: tab() === 'pending' }} onClick={() => setTab('pending')}>
          待研究员选择（{props.store.pendingConflicts().length}）
        </button>
        <button classList={{ active: tab() === 'resolved' }} onClick={() => setTab('resolved')}>
          已处理记录（{props.store.resolutions().length}）
        </button>
      </div>

      <Show when={tab() === 'pending'}>
        <Show
          when={props.store.pendingConflicts().length}
          fallback={<div class="empty-state">不同标签页对同一变更单元给出不同结果时，会在这里并列保留两份意见；选择前均不生效。当前没有待处理冲突。</div>}
        >
          <p class="conflict-rule">
            不同单元的改动已自动合并；下列同一单元存在分歧，两份结果都保留，请逐条选择采用哪一份，选择后立即对所有标签页生效。
          </p>
          <div class="conflict-list">
            <For each={props.store.pendingConflicts()}>{(conflict) => (
              <article class="conflict-card">
                <header>
                  <div>
                    <span class="conflict-tag">{groupHint(conflict)}</span>
                    <strong>{props.store.conflictLocation(conflict)}</strong>
                  </div>
                  <span class="conflict-field">{conflict.fieldLabel}</span>
                </header>
                <div class="conflict-opinions">
                  <For each={conflict.opinions}>{(opinion) => (
                    <button
                      class="opinion-card"
                      classList={{ mine: opinion.writerId === props.store.myWriterId() }}
                      onClick={() => props.store.resolveOneConflict(conflict.id, opinion.writerId)}
                    >
                      <div class="opinion-meta">
                        <span class="opinion-source">{opinion.label}</span>
                        <span class="opinion-choose">采用此结果 →</span>
                      </div>
                      <p>{props.store.renderOpinionValue(conflict.kind, opinion.value)}</p>
                    </button>
                  )}</For>
                </div>
                <footer>
                  基线原值：<span>{props.store.renderOpinionValue(conflict.kind, conflict.baseValue)}</span>
                  · 产生于 {new Date(conflict.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </footer>
              </article>
            )}</For>
          </div>
        </Show>
      </Show>

      <Show when={tab() === 'resolved'}>
        <Show
          when={props.store.resolutions().length}
          fallback={<div class="empty-state">尚无已处理的合并冲突。</div>}
        >
          <div class="resolved-list">
            <For each={props.store.resolutions()}>{(record) => (
              <div class="resolved-item">
                <strong>{record.entityLabel} · {record.fieldLabel}</strong>
                <span>{new Date(record.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 已选择生效</span>
              </div>
            )}</For>
          </div>
        </Show>
      </Show>
    </Paper>
  );
}
