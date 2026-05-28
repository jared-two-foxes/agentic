<script lang="ts">
  export let files: string[] = [];
  export let query: string = '';
  export let onSelect: (path: string) => void = () => {};
  export let onDismiss: () => void = () => {};

  let activeIndex = 0;
  $: filtered = query
    ? files.filter(f => f.toLowerCase().includes(query.toLowerCase()))
    : files;
  $: if (filtered.length > 0 && activeIndex >= filtered.length) activeIndex = 0;

  export function moveUp() {
    activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
  }
  export function moveDown() {
    activeIndex = (activeIndex + 1) % filtered.length;
  }
  export function selectActive() {
    if (filtered[activeIndex]) onSelect(filtered[activeIndex]);
  }
</script>

{#if filtered.length > 0}
<ul class="file-picker" role="listbox">
  {#each filtered as file, i}
    <li
      class="file-picker-item"
      class:active={i === activeIndex}
      role="option"
      aria-selected={i === activeIndex}
      on:mousedown|preventDefault={() => onSelect(file)}
      on:mouseover={() => (activeIndex = i)}
    >
      <i class="codicon codicon-file"></i>
      {file}
    </li>
  {/each}
</ul>
{/if}

<style>
  .file-picker {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    z-index: 100;
    box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0,0,0,0.4));
  }
  .file-picker-item {
    padding: 4px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-picker-item.active,
  .file-picker-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    color: var(--vscode-list-activeSelectionForeground, currentColor);
  }
</style>
