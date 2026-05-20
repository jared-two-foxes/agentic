<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';

  // Types
  type TextPart = { type: 'text'; text: string };
  type ToolCallPart = {
    type: 'tool';
    id: string;
    callID: string;
    tool: string;
    input: unknown;
    result?: unknown;
    error?: unknown;
    status: 'pending' | 'success' | 'failed';
  };
  type AssistantPart = TextPart | ToolCallPart;
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

  // Monotonic counter for stable IDs
  let _nextId = 0;
  function nextId(): string { return String(++_nextId); }

  // Safe JSON serialiser — handles cycles and BigInt without throwing
  function safeStringify(value: unknown, indent = 2): string {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString() + 'n';
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, indent) ?? 'null';
  }

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

  function handleSend() {
    const text = inputText.trim();
    if (!text) return;
    messages = [...messages, { kind: 'user', text, id: nextId() }];
    vscode.postMessage({ type: 'send', text });
    inputText = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
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
        case 'session.next.text.delta': {
          const delta: string = typeof data.properties?.delta === 'string' ? data.properties.delta : '';
          const assistantMsg = getOrCreateAssistantMessage();
          const parts = assistantMsg.parts;
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart.type === 'text') {
            lastPart.text += delta;
            messages = [...messages]; // trigger reactivity
          } else {
            assistantMsg.parts = [...parts, { type: 'text', text: delta }];
            messages = [...messages];
          }
          scrollToBottom();
          break;
        }
        case 'session.next.tool.called': {
          const props = data.properties ?? {};
          const callID: string = typeof props.callID === 'string' ? props.callID : nextId();
          const tool: string = typeof props.tool === 'string' ? props.tool : 'unknown';
          const assistantMsg = getOrCreateAssistantMessage();
          const toolPart: ToolCallPart = {
            type: 'tool',
            id: nextId(),
            callID,
            tool,
            input: props.input,
            status: 'pending',
          };
          assistantMsg.parts = [...assistantMsg.parts, toolPart];
          messages = [...messages];
          scrollToBottom();
          break;
        }
        case 'session.next.tool.success': {
          const { callID, structured } = data.properties ?? {};
          for (const msg of messages) {
            if (msg.kind === 'assistant') {
              for (const part of msg.parts) {
                if (part.type === 'tool' && part.callID === callID) {
                  part.result = structured;
                  part.status = 'success';
                }
              }
            }
          }
          messages = [...messages];
          break;
        }
        case 'session.next.tool.failed': {
          const { callID, error } = data.properties ?? {};
          for (const msg of messages) {
            if (msg.kind === 'assistant') {
              for (const part of msg.parts) {
                if (part.type === 'tool' && part.callID === callID) {
                  part.error = error;
                  part.status = 'failed';
                }
              }
            }
          }
          messages = [...messages];
          break;
        }
        case 'session.error': {
          status = 'error';
          statusMessage = safeStringify(data.properties?.error ?? {});
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

  <!-- Message list -->
  <div class="message-list" bind:this={messageListEl} on:scroll={onScroll}>
    {#each messages as msg (msg.id)}
      {#if msg.kind === 'user'}
        <div class="message user-message">
          <div class="bubble user-bubble">{msg.text}</div>
        </div>
      {:else if msg.kind === 'assistant'}
        <div class="message assistant-message">
          {#each msg.parts as part, i (part.type === 'tool' ? part.id : msg.id + '-text-' + i)}
            {#if part.type === 'text'}
              <div class="assistant-text">{part.text}</div>
            {:else if part.type === 'tool'}
              <details class="tool-card" class:tool-pending={part.status === 'pending'} class:tool-success={part.status === 'success'} class:tool-failed={part.status === 'failed'}>
                <summary class="tool-summary">
                  <span class="tool-icon">⚙</span>
                  <span class="tool-name">{part.tool}</span>
                  <span class="tool-status-badge">{part.status}</span>
                </summary>
                <div class="tool-body">
                  <div class="tool-section">
                    <strong>Input:</strong>
                    <pre class="tool-json">{safeStringify(part.input)}</pre>
                  </div>
                  {#if part.result !== undefined}
                    <div class="tool-section">
                      <strong>Result:</strong>
                      <pre class="tool-json">{safeStringify(part.result)}</pre>
                    </div>
                  {/if}
                  {#if part.error !== undefined}
                    <div class="tool-section tool-error-section">
                      <strong>Error:</strong>
                      <pre class="tool-json">{safeStringify(part.error)}</pre>
                    </div>
                  {/if}
                </div>
              </details>
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
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    padding: 2px 0;
  }

  /* Tool call cards */
  .tool-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    margin: 4px 0;
    background: var(--vscode-input-background);
    overflow: hidden;
    width: 100%;
  }

  .tool-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }

  .tool-summary::-webkit-details-marker { display: none; }

  .tool-icon { font-size: 12px; }

  .tool-name {
    font-weight: 600;
    font-size: 12px;
    flex: 1;
  }

  .tool-status-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #444);
    color: var(--vscode-badge-foreground, #fff);
  }

  .tool-pending .tool-status-badge { background: var(--vscode-charts-yellow, #e5c07b); color: #000; }
  .tool-success .tool-status-badge { background: var(--vscode-charts-green, #98c379); color: #000; }
  .tool-failed .tool-status-badge { background: var(--vscode-charts-red, #e06c75); color: #fff; }

  .tool-body {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border, #444);
  }

  .tool-section {
    margin-bottom: 8px;
  }

  .tool-section strong {
    display: block;
    font-size: 11px;
    margin-bottom: 2px;
    opacity: 0.8;
  }

  .tool-json {
    margin: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--vscode-editor-background);
    padding: 6px;
    border-radius: 4px;
    overflow-x: auto;
  }

  .tool-error-section .tool-json {
    color: var(--vscode-charts-red, #e06c75);
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
</style>
