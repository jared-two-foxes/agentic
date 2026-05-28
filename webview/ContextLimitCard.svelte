<script lang="ts">
  export let onNewTask: (() => void) | undefined = undefined;
  let summariseClicked = false;
  function handleSummarise() {
    summariseClicked = true;
    setTimeout(() => { summariseClicked = false; }, 2000);
  }
</script>

<div class="context-limit-card">
  <span class="context-limit-icon">⚠</span>
  <p class="context-limit-msg">Context window full — the conversation is too long to continue.</p>
  <div class="context-limit-actions">
    <button class="ctx-btn-new-task" on:click={() => onNewTask && onNewTask()}>New Task</button>
    <button class="ctx-btn-summarise" on:click={handleSummarise}>
      {summariseClicked ? 'Coming soon…' : 'Summarise'}
    </button>
  </div>
</div>

<style>
  .context-limit-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent);
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    border-radius: 0 4px 4px 0;
  }
  .context-limit-icon { font-size: 1.1em; }
  .context-limit-msg {
    margin: 0;
    font-size: 0.85em;
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .context-limit-actions { display: flex; gap: 8px; }
  .ctx-btn-new-task, .ctx-btn-summarise {
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
    background: none;
    color: var(--vscode-editorWarning-foreground, #cca700);
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 0.8em;
  }
  .ctx-btn-new-task:hover, .ctx-btn-summarise:hover {
    background: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editor-background, #1e1e1e);
  }
</style>
