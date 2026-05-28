<script lang="ts">
  export let images: { dataUrl: string; mimeType: string }[] = [];
  export let onRemove: (index: number) => void = () => {};
</script>

{#if images.length > 0}
  <div class="image-preview-strip">
    {#each images as img, i}
      <div class="image-thumb-wrap">
        <img class="image-thumb" src={img.dataUrl} alt="Pasted image {i + 1}" />
        <button
          class="image-remove-btn"
          title="Remove image"
          on:click={() => onRemove(i)}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .image-preview-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }

  .image-thumb-wrap {
    position: relative;
    display: inline-block;
    flex-shrink: 0;
  }

  .image-thumb {
    width: 60px;
    height: 60px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #555);
    display: block;
  }

  .image-remove-btn {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .image-remove-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
