<script lang="ts">
  export let toolName: string;
  export let summary: string;
  export let status: 'pending' | 'running' | 'completed' | 'error' = 'pending';
  export let params: unknown = undefined;
  export let result: unknown = undefined;

  $: borderColor =
    status === 'running'   ? 'var(--vscode-charts-blue, #4fc1ff)' :
    status === 'completed' ? 'var(--vscode-testing-iconPassed, #89ca78)' :
    status === 'error'     ? 'var(--vscode-charts-red, #e06c75)' :
    /* pending */            'var(--vscode-panel-border, #444)';
</script>

<div class="tool-card" style="border-left-color: {borderColor};">
  <div class="tool-header">
    <span class="tool-icon">🔧</span>
    <span class="tool-label">{toolName}</span>
    {#if summary}
      <span class="tool-sep">·</span>
      <span class="tool-summary">{summary}</span>
    {/if}
    <span class="status-badge status-{status}">{status}</span>
  </div>
  <div class="tool-body">
    {#if params !== undefined}
      <div class="tool-section">
        <div class="tool-section-label">Params</div>
        <pre class="tool-pre">{JSON.stringify(params, null, 2)}</pre>
      </div>
    {/if}
    {#if result !== undefined}
      <div class="tool-section">
        <div class="tool-section-label">Result</div>
        <pre class="tool-pre">{String(result)}</pre>
      </div>
    {/if}
  </div>
</div>

<style>
  .tool-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-left-width: 3px;
    border-radius: 6px;
    background: var(--vscode-input-background, #1e1e1e);
    overflow: hidden;
    margin: 4px 0;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    font-size: 12px;
  }

  .tool-icon {
    flex-shrink: 0;
    font-size: 13px;
  }

  .tool-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
    white-space: nowrap;
  }

  .tool-sep {
    opacity: 0.4;
    flex-shrink: 0;
  }

  .tool-summary {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .status-badge {
    flex-shrink: 0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    border: 1px solid currentColor;
    opacity: 0.8;
  }
  .status-pending   { color: var(--vscode-disabledForeground, #666); }
  .status-running   { color: var(--vscode-charts-blue, #4fc1ff); }
  .status-completed { color: var(--vscode-testing-iconPassed, #89ca78); }
  .status-error     { color: var(--vscode-charts-red, #e06c75); }

  .tool-body {
    display: none; /* expanded in FS3.4 */
    padding: 8px 10px;
    font-size: 12px;
  }

  .tool-section {
    margin-bottom: 8px;
  }

  .tool-section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    margin-bottom: 4px;
  }

  .tool-pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-textCodeBlock-background, #2d2d2d);
    padding: 6px 8px;
    border-radius: 4px;
  }
</style>
