<script lang="ts">
  export let modelLabel: string = '';
  export let onModelClick: () => void = () => {};
  export let onHistoryClick: () => void = () => {};
  export let onSettingsClick: () => void = () => {};
  export let onNewSessionClick: () => void = () => {};
</script>

<header class="app-header">
  <div class="header-left">
    <span class="header-title">opencode</span>
  </div>
  <div class="header-right">
    <button class="header-chip model-chip" on:click={onModelClick} title="Select model">
      <span class="chip-icon">⬡</span>
      <span class="chip-label">{modelLabel || '—'}</span>
    </button>
    <button class="header-icon-btn" on:click={onNewSessionClick} title="New session">
      <span>+</span>
    </button>
    <button class="header-icon-btn" on:click={onHistoryClick} title="Sessions">
      <span>🕐</span>
    </button>
    <button class="header-icon-btn" on:click={onSettingsClick} title="Settings">
      <span>⚙</span>
    </button>
  </div>
</header>

<style>
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
    height: 32px;
    flex-shrink: 0;
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .header-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .header-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border: none;
    border-radius: 3px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-chip:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.3));
  }

  .chip-icon {
    flex-shrink: 0;
    font-size: 10px;
  }

  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    font-size: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .header-icon-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.3));
  }
</style>
