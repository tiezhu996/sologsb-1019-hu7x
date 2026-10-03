import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { AppBar, Button, Chip, Paper, Toolbar, Typography } from '@suid/material';
import TranscriptPanel from './components/TranscriptPanel';
import ThemeTree from './components/ThemeTree';
import Inspector from './components/Inspector';
import ImportDialog from './components/ImportDialog';
import ConflictCenter from './components/ConflictCenter';
import { CreateThemeDialog, MergeThemeDialog, SplitThemeDialog } from './components/ThemeDialogs';
import { useCodingStore } from './store/coding-store';

export default function App() {
  const store = useCodingStore();
  const [importOpen, setImportOpen] = createSignal(false);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createParent, setCreateParent] = createSignal<string | undefined>();
  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [splitOpen, setSplitOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);

  const activeSegments = createMemo(() => store.state.segments
    .filter((segment) => segment.transcriptId === store.state.activeTranscriptId)
    .sort((a, b) => a.order - b.order));

  const moveSegment = (delta: number) => {
    const segments = activeSegments();
    const index = segments.findIndex((segment) => segment.id === store.state.activeSegmentId);
    const next = segments[Math.max(0, Math.min(segments.length - 1, index + delta))];
    if (next) {
      store.selectSegment(next.id);
      document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleKeys = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      store.downloadExport('json');
      return;
    }
    if (editing) return;
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); moveSegment(1); }
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); moveSegment(-1); }
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('.transcript-panel .native-input')?.focus();
    }
    if (event.key === '?') setShortcutsOpen((open) => !open);
    if (/^[1-9]$/.test(event.key)) {
      const theme = store.orderedThemes()[Number(event.key) - 1];
      if (theme) store.selectTheme(theme.id);
    }
    if (event.altKey && event.key.toLowerCase() === 'a' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'A', store.state.activeThemeId, true);
    }
    if (event.altKey && event.key.toLowerCase() === 'b' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'B', store.state.activeThemeId, true);
    }
  };

  onMount(() => {
    void store.initialize();
    window.addEventListener('keydown', handleKeys);
  });
  onCleanup(() => window.removeEventListener('keydown', handleKeys));

  return (
    <div class="app-shell">
      <AppBar position="static" class="topbar">
        <Toolbar class="toolbar">
          <div class="brand">
            <div class="brand-mark">码</div>
            <div><Typography variant="h6" component="div">访谈主题编码台</Typography><span>INTERPRETIVE CODING WORKBENCH</span></div>
          </div>
          <div class="top-actions">
            <div class="save-state">
              <span classList={{ pulsing: !store.storageReady(), offline: !store.online() }} />
              <Show when={store.pendingConflicts().length > 0} fallback={<>
                {!store.storageReady() ? '正在载入本地库' : store.online() ? `已保存 · r${store.state.revision}` : '离线工作中 · 本地保留'}
              </>}>
                <button class="conflict-jump" onClick={() => document.querySelector('.conflict-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                  {store.pendingConflicts().length} 条字段冲突待选择
                </button>
              </Show>
            </div>
            <Button color="inherit" size="small" disabled={!store.canUndo()} onClick={store.undo}>撤销</Button>
            <Button color="inherit" size="small" disabled={!store.canRedo()} onClick={store.redo}>重做</Button>
            <Button variant="outlined" color="inherit" size="small" onClick={() => setImportOpen(true)}>导入转写</Button>
            <Button variant="contained" color="secondary" size="small" onClick={() => store.downloadExport('json')}>导出编码</Button>
          </div>
        </Toolbar>
      </AppBar>

      <Show when={store.pendingConflicts().length > 0}>
        <div class="conflict-banner" role="alert">
          <div>
            <strong>检测到 {store.pendingConflicts().length} 个变更单元存在分歧</strong>
            <span>不同单元的改动已自动合并；同一单元的两份结果均已保留，在你明确选择前都不会生效，也不会进入导出。</span>
          </div>
          <div><Button size="small" variant="contained" color="warning" onClick={() => document.querySelector('.conflict-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>前往逐条选择</Button></div>
        </div>
      </Show>

      <section class="project-strip">
        <div><span class="eyebrow">CODING PROJECT</span><h1>{store.state.transcripts.find((item) => item.id === store.state.activeTranscriptId)?.title ?? '访谈语料库'}</h1></div>
        <div class="project-metrics">
          <div><strong>{store.state.segments.length}</strong><span>转写片段</span></div>
          <div><strong>{store.state.themes.length}</strong><span>层级主题</span></div>
          <div><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>编码分歧</span></div>
          <div><strong>{store.state.revision}</strong><span>本地修订</span></div>
        </div>
      </section>

      <main class="workspace-grid">
        <TranscriptPanel store={store} />
        <ThemeTree store={store} onCreate={(parentId) => { setCreateParent(parentId); setCreateOpen(true); }} onMerge={() => setMergeOpen(true)} onSplit={() => setSplitOpen(true)} />
        <Inspector store={store} />
      </main>

      <section class="conflict-strip">
        <ConflictCenter store={store} />
      </section>

      <section class="lower-grid">
        <Paper class="panel codebook-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">CODEBOOK HEALTH</span><h3>编码册质量检查</h3></div><Chip label="实时" size="small" /></div>
          <div class="health-grid">
            <div class="health-item"><strong>{store.state.segments.filter((segment) => !segment.assignments.A.length && !segment.assignments.B.length).length}</strong><span>未编码片段</span><small>可批量选择后重新编码</small></div>
            <div class="health-item"><strong>{store.state.themes.filter((theme) => !theme.definition).length}</strong><span>缺少定义的主题</span><small>定义会帮助后续编码保持一致</small></div>
            <div class="health-item"><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>双编码分歧</span><small>使用双人比较逐条处理</small></div>
          </div>
        </Paper>
        <Paper class="panel export-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">EXPORT & BACKUP</span><h3>研究数据出口</h3></div></div>
          <p>导出严格以字段级合并、并完成冲突选择后的结果为准；未处理冲突的任何一份意见都不会进入导出。CSV 适合表格复核，JSON 含完整账本与处理记录。</p>
          <div class="button-row"><Button variant="contained" onClick={() => store.downloadExport('json')}>下载 JSON 完整包</Button><Button variant="outlined" onClick={() => store.downloadExport('csv')}>下载 CSV 编码表</Button></div>
        </Paper>
      </section>

      <footer class="app-footer">
        <span>快捷键 J / K 切换片段 · 1–9 选择主题 · Alt+A / Alt+B 编码 · Ctrl+Z 撤销 · ? 查看帮助</span>
        <span>IndexedDB + localStorage 双写 · 断网/重开浏览器保留本地改动与未处理冲突 · 字段级三方合并</span>
      </footer>

      <ImportDialog open={importOpen()} onClose={() => setImportOpen(false)} onImport={store.importTranscript} />
      <CreateThemeDialog store={store} open={createOpen()} parentId={createParent()} onClose={() => { setCreateOpen(false); setCreateParent(undefined); }} />
      <MergeThemeDialog store={store} open={mergeOpen()} onClose={() => setMergeOpen(false)} />
      <SplitThemeDialog store={store} open={splitOpen()} onClose={() => setSplitOpen(false)} />

      <div class="modal-backdrop" classList={{ hidden: !shortcutsOpen() }} onClick={() => setShortcutsOpen(false)}>
        <section class="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header><div><span class="eyebrow">KEYBOARD</span><h2>键盘操作</h2></div><button class="modal-close" onClick={() => setShortcutsOpen(false)}>×</button></header>
          <div class="shortcut-list">
            <For each={[['J / K', '下一条 / 上一条片段'], ['1–9', '选择主题树中的主题'], ['Alt+A / Alt+B', '将当前主题分配给编码者'], ['/', '聚焦正文搜索'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['Ctrl+E', '导出 JSON'], ['?', '显示或隐藏此面板']]}>{([key, text]) => <div><kbd>{key}</kbd><span>{text}</span></div>}</For>
          </div>
        </section>
      </div>
    </div>
  );
}
