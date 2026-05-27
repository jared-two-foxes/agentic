<script lang="ts">
  type SessionInfo = { id: string; title: string; directory: string; time: { created: number; updated: number } };

  export let sessionList: SessionInfo[] = [];
  export let sessionListLoading: boolean = false;
  export let activeSessionId: string | null = null;
  export let onClose: () => void = () => {};
  export let onSwitch: (id: string) => void = () => {};
  export let onRenameConfirm: (id: string, title: string) => void = () => {};
  export let onFork: (id: string) => void = () => {};
  export let onDelete: (id: string) => void = () => {};

  let renamingId: string | null = null;
  let renameValue = '';

  function startRename(id: string, currentTitle: string) {
    renamingId = id;
    renameValue = currentTitle;
  }

  function commitRename(id: string) {
    const trimmed = renameValue.trim();
    onRenameConfirm(id, trimmed);
    renamingId = null;
  }

  function handleOverlayKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      renamingId = null;
      onClose();
    }
  }

  function previewText(s: SessionInfo): string {
    const text = s.title || '';
    if (!text) return '(no messages)';
    return text.length > 80 ? text.slice(0, 80) + '…' : text;
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins  < 1)  return 'just now';
    if (mins  < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="session-overlay" on:keydown={handleOverlayKeydown}>
  <div class="session-panel">
    <div class="session-panel-header">
      <span class="session-panel-title">Sessions</span>
      <button class="session-panel-close" on:click={() => { renamingId = null; onClose(); }} title="Close">✕</button>
    </div>
    {#if sessionListLoading}
      <div class="session-loading">Loading…</div>
    {:else if sessionList.length === 0}
      <div class="session-empty">No sessions for this workspace.</div>
    {:else}
      <ul class="session-list">
        {#each sessionList as s (s.id)}
          <li class="session-row" class:session-active={s.id === activeSessionId}>
            {#if renamingId === s.id}
              <!-- svelte-ignore a11y-autofocus -->
              <input
                class="session-rename-input"
                autofocus
                bind:value={renameValue}
                on:keydown={(e) => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') renamingId = null; }}
                on:blur={() => commitRename(s.id)}
              />
            {:else}
              <button class="session-title-btn" on:click={() => onSwitch(s.id)} title="Switch to this session">
                <div class="session-title-row">
                  <span class="session-title">{s.title || '(untitled)'}</span>
                  <span class="session-time">{relativeTime(s.time?.updated ?? s.time?.created ?? 0)}</span>
                </div>
                <div class="session-meta-row">
                  <span class="session-preview">{previewText(s)}</span>
                  <span class="session-tokens" title="Token count (not available for historical sessions)">—</span>
                </div>
              </button>
              <div class="session-actions">
                <button class="session-action-btn" title="Rename" on:click={() => startRename(s.id, s.title)}>✎</button>
                <button class="session-action-btn" title="Fork" on:click={() => onFork(s.id)}>⑂</button>
                <button class="session-action-btn session-delete-btn" title="Delete" on:click={() => onDelete(s.id)}>🗑</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  /* ── Session overlay ──────────────────────────────────────────────────── */
  .session-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    background: transparent;
    pointer-events: none;
  }

  .session-panel {
    pointer-events: all;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    overflow: hidden;
  }

  .session-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-foreground);
    opacity: 0.7;
  }

  .session-panel-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.6;
    font-size: 12px;
    padding: 0 2px;
  }
  .session-panel-close:hover { opacity: 1; }

  .session-loading,
  .session-empty {
    padding: 12px 10px;
    font-size: 12px;
    opacity: 0.6;
    text-align: center;
  }

  .session-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .session-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    margin: 1px 4px;
  }
  .session-row:hover { background: var(--vscode-list-hoverBackground); }
  .session-row.session-active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

  .session-title-btn {
    flex: 1;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 2px;
    color: inherit;
    min-width: 0;
  }

  .session-title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px;
    min-width: 0;
    width: 100%;
  }

  .session-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    min-width: 0;
    width: 100%;
  }

  .session-title {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .session-time {
    font-size: 10px;
    opacity: 0.5;
    flex-shrink: 0;
  }

  .session-preview {
    font-size: 10px;
    opacity: 0.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .session-tokens {
    font-size: 10px;
    opacity: 0.45;
    flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .session-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
    flex-shrink: 0;
  }
  .session-row:hover .session-actions,
  .session-row.session-active .session-actions { opacity: 1; }

  .session-action-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: 3px;
    color: var(--vscode-foreground);
    opacity: 0.6;
  }
  .session-action-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .session-delete-btn:hover { color: var(--vscode-errorForeground); }

  .session-rename-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
  }
</style>
