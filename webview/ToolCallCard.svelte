<script lang="ts">
  import type { Change } from 'diff';
  import { getToolMeta, isWriteTool, COLLAPSE_THRESHOLD } from './toolMeta';
  import DiffBlock from './DiffBlock.svelte';

  export let toolName: string;
  export let summary: string;
  export let status: 'pending' | 'running' | 'completed' | 'error' | 'pending-approval' = 'pending';
  export let params: unknown = undefined;
  export let result: unknown = undefined;
  export let diffHunks: Change[] | null = null;
  export let filePath: string | undefined = undefined;
  export let originalContent: string | undefined = undefined;
  export let newContent: string | undefined = undefined;
  export let onOpenDiff: ((filePath: string, original: string, modified: string) => void) | undefined = undefined;
  export let pendingApprovalID: string | undefined = undefined;
  export let onApprove: (() => void) | undefined = undefined;
  export let onReject: (() => void) | undefined = undefined;

  $: meta = getToolMeta(toolName);

  $: borderColor =
    status === 'running'           ? 'var(--vscode-charts-blue, #4fc1ff)' :
    status === 'completed'         ? 'var(--vscode-testing-iconPassed, #89ca78)' :
    status === 'error'             ? 'var(--vscode-charts-red, #e06c75)' :
    status === 'pending-approval'  ? 'var(--vscode-charts-yellow, #e5c07b)' :
    /* pending */                    'var(--vscode-panel-border, #444)';

  $: statusIcon =
    status === 'running'           ? '◌' :
    status === 'completed'         ? '✓' :
    status === 'error'             ? '✕' :
    status === 'pending-approval'  ? '⏸' :
    /* pending */                    '○';

  let expanded = false;
  $: if (status === 'error') expanded = true;

  // Result collapse logic
  $: resultLines = result !== undefined ? String(result).split('\n') : [];
  $: resultCollapsible = resultLines.length > COLLAPSE_THRESHOLD;
  let showAllResult = false;
</script>

<div class="tool-card" style="border-left-color: {borderColor};">
  <div class="tool-header" on:click={() => expanded = !expanded} role="button" tabindex="0"
       on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') expanded = !expanded; }}>
    <button class="tool-chevron" on:click|stopPropagation={() => expanded = !expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}>
      {expanded ? '▼' : '▶'}
    </button>
    <span class="tool-icon">{meta.icon}</span>
    <span class="tool-label">{meta.label}</span>
    {#if summary}
      <span class="tool-sep">·</span>
      <span class="tool-summary">{summary}</span>
    {/if}
    <span class="status-badge status-{status}">{statusIcon} {status}</span>
  </div>
  {#if status === 'pending-approval'}
    <div class="approval-bar">
      <span class="approval-label">Approve this file write?</span>
      <button class="approval-approve" on:click={() => onApprove && onApprove()}>Approve</button>
      <button class="approval-reject"  on:click={() => onReject && onReject()}>Reject</button>
    </div>
  {/if}
  {#if expanded}
    <div class="tool-body">
      {#if params !== undefined}
        <div class="tool-section">
          <div class="tool-section-label">Params</div>
          <pre class="tool-pre">{JSON.stringify(params, null, 2)}</pre>
        </div>
      {/if}
      {#if diffHunks !== null && diffHunks.length > 0 && isWriteTool(toolName)}
        <div class="tool-section">
          <div class="tool-section-header">
            <div class="tool-section-label">Diff</div>
            {#if filePath && originalContent !== undefined && newContent !== undefined && onOpenDiff}
              <button class="open-diff-btn" on:click={() => onOpenDiff(filePath, originalContent, newContent)} title="Open in diff editor">
                🔀 Open diff
              </button>
            {/if}
          </div>
          <DiffBlock hunks={diffHunks} />
        </div>
      {/if}
      {#if result !== undefined}
        <div class="tool-section">
          <div class="tool-section-label">Result</div>
          {#if resultCollapsible && !showAllResult}
            <pre class="tool-pre">{resultLines.slice(0, COLLAPSE_THRESHOLD).join('\n')}</pre>
            <button class="show-more" on:click={() => showAllResult = true}>
              Show {resultLines.length - COLLAPSE_THRESHOLD} more lines
            </button>
          {:else}
            <pre class="tool-pre">{String(result)}</pre>
            {#if resultCollapsible}
              <button class="show-less" on:click={() => showAllResult = false}>Show less</button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
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
    cursor: pointer;
    user-select: none;
  }
  .tool-header:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
  }

  .tool-chevron {
    flex-shrink: 0;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 2px;
    font-size: 9px;
    opacity: 0.6;
    line-height: 1;
  }
  .tool-chevron:hover { opacity: 1; }

  .tool-icon { flex-shrink: 0; font-size: 13px; }

  .tool-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
    white-space: nowrap;
  }

  .tool-sep { opacity: 0.4; flex-shrink: 0; }

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
  .status-pending-approval { color: var(--vscode-charts-yellow, #e5c07b); }

  .approval-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, #252526);
  }

  .approval-label {
    font-size: 11px;
    flex: 1;
    color: var(--vscode-foreground, #ccc);
    opacity: 0.8;
  }

  .approval-approve {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .approval-approve:hover { opacity: 0.9; }

  .approval-reject {
    background: none;
    color: var(--vscode-charts-red, #e06c75);
    border: 1px solid var(--vscode-charts-red, #e06c75);
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
    opacity: 0.8;
  }
  .approval-reject:hover { opacity: 1; }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  .status-badge.status-running {
    animation: spin 1.2s linear infinite;
    display: inline-block;
  }

  .tool-body {
    padding: 8px 10px;
    font-size: 12px;
  }

  .tool-section { margin-bottom: 8px; }

  .tool-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .tool-section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
  }

  .open-diff-btn {
    background: none;
    border: 1px solid var(--vscode-panel-border, #555);
    color: var(--vscode-textLink-foreground, #4fc1ff);
    font-size: 10px;
    cursor: pointer;
    padding: 1px 6px;
    border-radius: 3px;
    opacity: 0.8;
    line-height: 1.4;
  }
  .open-diff-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }

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

  .show-more,
  .show-less {
    display: block;
    margin-top: 4px;
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #4fc1ff);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 0;
    text-align: left;
    opacity: 0.8;
  }
  .show-more:hover,
  .show-less:hover { opacity: 1; text-decoration: underline; }
</style>
