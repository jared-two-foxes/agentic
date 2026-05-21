<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  // Configure marked: enable GitHub-flavoured markdown, disable mangling of emails
  marked.setOptions({ gfm: true, breaks: false });

  function renderMarkdown(text: string): string {
    return DOMPurify.sanitize(marked.parse(text) as string);
  }

  // Types
  type TextPart = { type: 'text'; partID: string; text: string };
  type AssistantPart = TextPart;
  type UserMessage = { kind: 'user'; id: string; text: string };
  type AssistantMessage = { kind: 'assistant'; id: string; parts: AssistantPart[] };
  type Message = UserMessage | AssistantMessage;

  // VSCode API (cached)
  const vscode = acquireVsCodeApi();

  // State
  let messages: Message[] = [];
  let inputText = '';
  let status: 'connecting' | 'ready' | 'error' = 'connecting';
  let statusMessage = '';
  let messageListEl: HTMLElement;

  // Context bar state
  type AgentInfo = { name: string; description?: string };
  type ModelInfo = { id: string; providerID: string; name: string; hasVariants: boolean; variants: string[] };
  let agents: AgentInfo[] = [];
  let models: ModelInfo[] = [];
  let currentAgent: string | undefined;
  let currentModelId: string | undefined;
  let currentModelName: string | undefined;
  let currentVariant: string | undefined;
  let currentProviderID: string | undefined;
  let contextError: string | undefined;
  $: currentModelVariants = models.find(m => m.id === currentModelId && m.providerID === currentProviderID)?.variants ?? [];
  $: showVariantChip = currentModelVariants.length > 0;

  // Monotonic counter for stable IDs
  let _nextId = 0;
  function nextId(): string { return String(++_nextId); }

  // Prompt history stack.
  //historyStack[0] is the oldest entry; the live input is not stored here.
  // historyCursor === historyStack.length means "no history item selected" (live input).
  let historyStack: string[] = [];
  let historyCursor = 0;   // index into historyStack; historyStack.length = live
  let historySaved = '';   // saves the live draft when the user starts navigating up

  // Reactive: disable send when input is empty or not ready
  $: canSend = inputText.trim().length > 0 && status === 'ready';

  // Scroll-to-bottom: only if already near the bottom (within 80px)
  let _shouldStick = true;
  function onScroll() {
    if (!messageListEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messageListEl;
    _shouldStick = scrollHeight - scrollTop - clientHeight < 80;
  }

  function scrollToBottom() {
    if (messageListEl && _shouldStick) {
      requestAnimationFrame(() => {
        messageListEl.scrollTop = messageListEl.scrollHeight;
      });
    }
  }

  function getOrCreateAssistantMessage(): AssistantMessage {
    const last = messages[messages.length - 1];
    if (last && last.kind === 'assistant') {
      return last;
    }
    const msg: AssistantMessage = { kind: 'assistant', id: nextId(), parts: [] };
    messages = [...messages, msg];
    return msg;
  }

  /** Append a text delta to the part identified by partID, creating it if needed */
  function applyTextDelta(partID: string, delta: string) {
    const assistantMsg = getOrCreateAssistantMessage();
    const existing = assistantMsg.parts.find(p => p.partID === partID);
    if (existing) {
      existing.text += delta;
    } else {
      assistantMsg.parts = [...assistantMsg.parts, { type: 'text', partID, text: delta }];
    }
    messages = [...messages];
    scrollToBottom();
  }

  function handleSend() {
    const text = inputText.trim();
    if (!text) return;
    messages = [...messages, { kind: 'user', text, id: nextId() }];
    vscode.postMessage({ type: 'send', text });
    // Push to history; drop duplicate if same as last entry
    if (historyStack.length === 0 || historyStack[historyStack.length - 1] !== text) {
      historyStack = [...historyStack, text];
    }
    historyCursor = historyStack.length; // reset to live position
    historySaved = '';
    inputText = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
      return;
    }

    const textarea = e.currentTarget as HTMLTextAreaElement;

    if (e.key === 'ArrowUp') {
      // Only navigate up if the cursor is at the very start of the text
      if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return;
      if (historyStack.length === 0) return;
      if (historyCursor === historyStack.length) {
        // Entering history — save the current draft
        historySaved = inputText;
      }
      if (historyCursor > 0) {
        historyCursor -= 1;
        inputText = historyStack[historyCursor];
        e.preventDefault();
        // Move cursor to start so repeated ArrowUp keeps working
        requestAnimationFrame(() => {
          textarea.setSelectionRange(0, 0);
        });
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      // Only navigate down if the cursor is at the very end of the text
      if (textarea.selectionStart !== textarea.value.length || textarea.selectionEnd !== textarea.value.length) return;
      if (historyCursor === historyStack.length) return; // already at live position
      historyCursor += 1;
      if (historyCursor === historyStack.length) {
        // Returned to live position — restore draft
        inputText = historySaved;
        historySaved = '';
      } else {
        inputText = historyStack[historyCursor];
      }
      e.preventDefault();
      // Move cursor to end
      requestAnimationFrame(() => {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    }
  }

  onMount(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        case 'status': {
          const val = data.value;
          if (val === 'connecting' || val === 'ready' || val === 'error') {
            status = val;
          }
          statusMessage = typeof data.message === 'string' ? data.message : '';
          scrollToBottom();
          break;
        }
        case 'message.part.delta': {
          const props = data.properties ?? {};
          if (props.field === 'text' && typeof props.delta === 'string' && typeof props.partID === 'string') {
            applyTextDelta(props.partID, props.delta);
          }
          break;
        }
        case 'session.status': {
          const st = data.properties?.status as { type?: string; error?: unknown } | undefined;
          if (st?.type === 'error') {
            status = 'error';
            statusMessage = st.error ? String(st.error) : 'Session error';
          }
          break;
        }
        case 'session.idle': {
          // assistant turn complete — nothing special needed for v1
          break;
        }
        case 'newSession': {
          messages = [];
          status = 'connecting';
          statusMessage = '';
          // Reset prompt history for the new session
          historyStack = [];
          historyCursor = 0;
          historySaved = '';
          inputText = '';
          // Reset context selections (will be re-fetched when server confirms ready)
          currentAgent = undefined;
          currentModelId = undefined;
          currentProviderID = undefined;
          currentModelName = undefined;
          currentVariant = undefined;
          contextError = undefined;
          break;
        }
        case 'context': {
          agents = Array.isArray(data.agents) ? data.agents : [];
          models = Array.isArray(data.models) ? data.models : [];
          const cur = data.current ?? {};
          currentAgent = cur.agent;
          currentModelId = cur.modelId;
          currentProviderID = cur.providerID;
          currentModelName = models.find(m => m.id === currentModelId && m.providerID === currentProviderID)?.name ?? currentModelId;
          currentVariant = cur.variant;
          contextError = undefined;
          break;
        }
        case 'contextUpdate': {
          if (typeof data.agent === 'string') currentAgent = data.agent;
          if (typeof data.modelId === 'string') {
            currentModelId = data.modelId;
            currentProviderID = typeof data.providerID === 'string' ? data.providerID : currentProviderID;
            currentModelName = typeof data.modelName === 'string' ? data.modelName : data.modelId;
            currentVariant = undefined; // reset variant when model changes
          }
          if (typeof data.variant === 'string') currentVariant = data.variant;
          break;
        }
        case 'contextError': {
          contextError = typeof data.message === 'string' ? data.message : 'Failed to load context';
          break;
        }
        default:
          // unknown message type — ignore
          break;
      }
    };

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getStatus' });
    // Return cleanup so Svelte removes the listener when the component is destroyed
    return () => window.removeEventListener('message', handler);
  });

  afterUpdate(() => {
    scrollToBottom();
  });
</script>

<div class="chat-container">
  <!-- Status bar -->
  <div class="status-bar" class:status-connecting={status === 'connecting'} class:status-ready={status === 'ready'} class:status-error={status === 'error'}>
    <span class="status-dot"></span>
    <span class="status-text">{status}{statusMessage ? ': ' + statusMessage : ''}</span>
  </div>

  <!-- Context bar -->
  {#if agents.length > 0 || models.length > 0 || contextError}
    <div class="context-bar">
      {#if contextError}
        <span class="context-error">{contextError}
          <button class="context-retry" on:click={() => vscode.postMessage({ type: 'getStatus' })}>retry</button>
        </span>
      {:else}
        {#if currentAgent !== undefined || agents.length > 0}
          <button class="context-chip" on:click={() => vscode.postMessage({ type: 'pickAgent' })} title="Select agent">
            <span class="chip-icon">◈</span>
            <span class="chip-label">{currentAgent ?? '—'}</span>
          </button>
        {/if}
        {#if currentModelId !== undefined || models.length > 0}
          <button class="context-chip" on:click={() => vscode.postMessage({ type: 'pickModel' })} title="Select model">
            <span class="chip-icon">⬡</span>
            <span class="chip-label">{currentModelName ?? currentModelId ?? '—'}</span>
          </button>
        {/if}
        {#if showVariantChip}
          <button class="context-chip" on:click={() => vscode.postMessage({ type: 'pickVariant' })} title="Select variant">
            <span class="chip-icon">◇</span>
            <span class="chip-label">{currentVariant ?? 'default'}</span>
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Message list -->
  <div class="message-list" bind:this={messageListEl} on:scroll={onScroll}>
    {#each messages as msg (msg.id)}
      {#if msg.kind === 'user'}
        <div class="message user-message">
          <div class="bubble user-bubble">{msg.text}</div>
        </div>
      {:else if msg.kind === 'assistant'}
        <div class="message assistant-message">
          {#each msg.parts as part (part.partID)}
            {#if part.type === 'text'}
              <div class="assistant-text">{@html renderMarkdown(part.text)}</div>
            {/if}
          {/each}
        </div>
      {/if}
    {/each}
  </div>

  <!-- Input area -->
  <div class="input-area">
    <textarea
      class="chat-input"
      placeholder="Type a message…"
      bind:value={inputText}
      on:keydown={handleKeydown}
      rows="1"
    ></textarea>
    <button
      class="send-button"
      on:click={handleSend}
      disabled={!canSend}
    >Send</button>
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    height: 100vh;
    overflow: hidden;
  }

  .chat-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* Status bar */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 11px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-statusBar-background, var(--vscode-editor-background));
    color: var(--vscode-statusBar-foreground, var(--vscode-foreground));
    flex-shrink: 0;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.7;
  }

  .status-connecting { color: var(--vscode-charts-yellow, #e5c07b); }
  .status-ready { color: var(--vscode-charts-green, #98c379); }
  .status-error { color: var(--vscode-charts-red, #e06c75); }

  /* Message list */
  .message-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message {
    display: flex;
    flex-direction: column;
  }

  .user-message {
    align-items: flex-end;
  }

  .user-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 12px 12px 2px 12px;
    padding: 8px 12px;
    max-width: 80%;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .assistant-message {
    align-items: flex-start;
    max-width: 100%;
  }

  .assistant-text {
    word-break: break-word;
    line-height: 1.6;
    padding: 2px 0;
    min-width: 0;
  }

  /* Markdown-rendered elements inside assistant bubbles */
  :global(.assistant-text > *:first-child) { margin-top: 0; }
  :global(.assistant-text > *:last-child) { margin-bottom: 0; }

  :global(.assistant-text p) {
    margin: 0 0 0.6em;
    line-height: 1.6;
  }

  :global(.assistant-text h1),
  :global(.assistant-text h2),
  :global(.assistant-text h3),
  :global(.assistant-text h4),
  :global(.assistant-text h5),
  :global(.assistant-text h6) {
    margin: 0.8em 0 0.4em;
    font-weight: 600;
    line-height: 1.3;
  }
  :global(.assistant-text h1) { font-size: 1.3em; }
  :global(.assistant-text h2) { font-size: 1.15em; }
  :global(.assistant-text h3) { font-size: 1.05em; }

  :global(.assistant-text ul),
  :global(.assistant-text ol) {
    margin: 0 0 0.6em;
    padding-left: 1.5em;
  }
  :global(.assistant-text li) { margin: 0.15em 0; }

  :global(.assistant-text code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border-radius: 3px;
    padding: 0.1em 0.35em;
  }

  :global(.assistant-text pre) {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border-radius: 5px;
    padding: 10px 12px;
    overflow-x: auto;
    margin: 0 0 0.6em;
  }
  :global(.assistant-text pre code) {
    background: none;
    padding: 0;
    font-size: 0.88em;
    line-height: 1.5;
  }

  :global(.assistant-text blockquote) {
    margin: 0 0 0.6em;
    padding: 0 0 0 0.8em;
    border-left: 3px solid var(--vscode-panel-border, #555);
    color: var(--vscode-descriptionForeground, inherit);
    font-style: italic;
  }

  :global(.assistant-text a) {
    color: var(--vscode-textLink-foreground, #4fc1ff);
    text-decoration: none;
  }
  :global(.assistant-text a:hover) {
    text-decoration: underline;
  }

  :global(.assistant-text strong) { font-weight: 700; }
  :global(.assistant-text em) { font-style: italic; }

  :global(.assistant-text hr) {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, #444);
    margin: 0.8em 0;
  }

  :global(.assistant-text table) {
    border-collapse: collapse;
    margin: 0 0 0.6em;
    width: 100%;
    font-size: 0.9em;
  }
  :global(.assistant-text th),
  :global(.assistant-text td) {
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 4px 8px;
    text-align: left;
  }
  :global(.assistant-text th) {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    font-weight: 600;
  }

  /* Input area */
  .input-area {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
    flex-shrink: 0;
  }

  .chat-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    outline: none;
    min-height: 32px;
    max-height: 120px;
    overflow-y: auto;
    line-height: 1.4;
  }

  .chat-input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .send-button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: inherit;
    cursor: pointer;
    height: 32px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .send-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    filter: brightness(1.1);
  }

  .send-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Context bar */
  .context-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
    flex-shrink: 0;
    flex-wrap: wrap;
    min-height: 28px;
  }

  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    max-width: 160px;
    overflow: hidden;
  }

  .context-chip:hover {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground, var(--vscode-input-background));
  }

  .chip-icon {
    opacity: 0.6;
    font-size: 10px;
    flex-shrink: 0;
  }

  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-error {
    font-size: 11px;
    color: var(--vscode-charts-red, #e06c75);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .context-retry {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #4fc1ff);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    text-decoration: underline;
  }
</style>
