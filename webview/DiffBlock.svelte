<script lang="ts">
  import type { Change } from 'diff';

  export let hunks: Change[];

  type DiffLine = {
    text: string;
    type: 'added' | 'removed' | 'context';
    oldNo: number | null;
    newNo: number | null;
  };

  $: lines = (() => {
    const result: DiffLine[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const hunk of hunks) {
      // Split on newlines; trailing newline produces a trailing empty string — discard it
      const raw = hunk.value.split('\n');
      const lineTexts = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
      for (const text of lineTexts) {
        if (hunk.added) {
          result.push({ text, type: 'added', oldNo: null, newNo: newNo++ });
        } else if (hunk.removed) {
          result.push({ text, type: 'removed', oldNo: oldNo++, newNo: null });
        } else {
          result.push({ text, type: 'context', oldNo: oldNo++, newNo: newNo++ });
        }
      }
    }
    return result;
  })();
</script>

<div class="diff-block">
  {#each lines as line, i (i)}
    <div class="diff-line diff-{line.type}">
      <span class="diff-gutter diff-gutter-old">{line.oldNo ?? ''}</span>
      <span class="diff-gutter diff-gutter-new">{line.newNo ?? ''}</span>
      <span class="diff-marker">{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
      <span class="diff-text">{line.text}</span>
    </div>
  {/each}
  {#if lines.length === 0}
    <div class="diff-empty">No changes</div>
  {/if}
</div>

<style>
  .diff-block {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    overflow-x: auto;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-textCodeBlock-background, #2d2d2d);
  }

  .diff-line {
    display: flex;
    align-items: baseline;
    min-width: 0;
    line-height: 1.5;
  }

  .diff-added {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(70, 166, 77, 0.2));
  }

  .diff-removed {
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.15));
  }

  .diff-context {
    background: transparent;
    opacity: 0.65;
  }

  .diff-gutter {
    flex-shrink: 0;
    width: 30px;
    text-align: right;
    padding: 0 4px;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    border-right: 1px solid var(--vscode-panel-border, #333);
    user-select: none;
    font-size: 10px;
    line-height: 1.5;
  }

  .diff-marker {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
    padding: 0 2px;
    user-select: none;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    font-size: 11px;
  }

  .diff-added .diff-marker { color: var(--vscode-charts-green, #89ca78); }
  .diff-removed .diff-marker { color: var(--vscode-charts-red, #e06c75); }

  .diff-text {
    flex: 1;
    padding: 0 6px;
    white-space: pre;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-foreground, #ccc);
  }

  .diff-empty {
    padding: 4px 8px;
    font-size: 11px;
    opacity: 0.5;
    font-style: italic;
    color: var(--vscode-foreground, #ccc);
  }
</style>
