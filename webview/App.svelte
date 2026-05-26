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
  type UserMessage = { kind: 'user'; id: string; serverId?: string; text: string };
  type AssistantMessage = { kind: 'assistant'; id: string; parts: AssistantPart[] };
  type Message = UserMessage | AssistantMessage;

  type QuestionOption   = { label: string; description: string };
  type QuestionInfo     = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean };
  type QuestionRequest  = { id: string; sessionID: string; questions: QuestionInfo[] };
  type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: string[] };

  // Session management types
  type SessionInfo = { id: string; title: string; directory: string; time: { created: number; updated: number } };

  // VSCode API (cached)
  const vscode = acquireVsCodeApi();

  // State
  let messages: Message[] = [];
  let inputText = '';
  let status: 'connecting' | 'ready' | 'error' = 'connecting';
  let statusMessage = '';
  let messageListEl: HTMLElement;

  // Pending question / permission state
  let pendingQuestion: QuestionRequest | null = null;
  let questionAnswers: string[][] = [];   // one entry per QuestionInfo; each is array of selected labels
  let customAnswers: string[] = [];       // free-text per QuestionInfo when custom: true
  let pendingPermission: PermissionRequest | null = null;

  // Session management state
  let showSessionPanel = false;
  let sessionList: SessionInfo[] = [];
  let sessionListLoading = false;
  let activeSessionId: string | null = null;
  let currentSessionTitle: string | undefined = undefined;
  let renamingId: string | null = null;
  let renameValue = '';

  // Context bar state
  type AgentInfo = { name: string; description?: string; model?: { modelID: string; providerID: string } };
  type ModelInfo = { id: string; providerID: string; name: string; hasVariants: boolean; variants: string[] };
  let agents: AgentInfo[] = [];
  let models: ModelInfo[] = [];
  let currentAgent: string | undefined;
  let currentModelId: string | undefined;
  let currentModelName: string | undefined;
  let currentVariant: string | undefined;
  let currentProviderID: string | undefined;
  let contextError: string | undefined;
  let isContextLoaded = false;
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

  // Reactive: disable send when input is empty, not ready, or a card is awaiting response
  $: canSend = inputText.trim().length > 0 && status === 'ready' && !pendingQuestion && !pendingPermission && !isThinking;

  // Whether the model is currently generating a response
  let isThinking = false;

  // Edit state — set when the user clicks the pencil on a user bubble
  let editingMessageId: string | null = null;   // local msg.id of the bubble being edited
  let editingServerId: string | null = null;     // server-side messageID for the revert call
  let editOriginalText = '';                     // saved so cancel can restore it

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

  // ── Session management helpers ───────────────────────────────────────────

  function toggleSessionPanel() {
    showSessionPanel = !showSessionPanel;
    if (showSessionPanel) {
      sessionListLoading = true;
      renamingId = null;
      vscode.postMessage({ type: 'fetchSessions' });
    }
  }

  function switchSession(id: string) {
    if (id === activeSessionId) { showSessionPanel = false; return; }
    vscode.postMessage({ type: 'switchSession', sessionId: id });
  }

  function deleteSession(id: string) {
    vscode.postMessage({ type: 'deleteSession', sessionId: id });
  }

  function startRename(id: string, title: string) {
    renamingId = id;
    renameValue = title;
  }

  function commitRename(id: string) {
    const trimmed = renameValue.trim();
    if (trimmed) {
      vscode.postMessage({ type: 'renameSession', sessionId: id, title: trimmed });
      // Optimistically update the local list
      sessionList = sessionList.map(s => s.id === id ? { ...s, title: trimmed } : s);
      if (id === activeSessionId) currentSessionTitle = trimmed;
    }
    renamingId = null;
  }

  function forkSession(id: string) {
    showSessionPanel = false;
    vscode.postMessage({ type: 'forkSession', sessionId: id });
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

  function handleSessionPanelKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { showSessionPanel = false; renamingId = null; }
  }

  // ── Question card helpers ────────────────────────────────────────────────

  function toggleQuestionOption(qIdx: number, label: string, multiple: boolean) {
    const current = questionAnswers[qIdx] ?? [];
    if (multiple) {
      questionAnswers[qIdx] = current.includes(label)
        ? current.filter(l => l !== label)
        : [...current, label];
    } else {
      questionAnswers[qIdx] = current[0] === label ? [] : [label];
    }
    questionAnswers = [...questionAnswers];
  }

  $: questionReady = pendingQuestion !== null && pendingQuestion.questions.every((q, i) => {
    if (q.custom) {
      // custom: accept either a selected option OR a non-empty free-text answer
      return (questionAnswers[i]?.length ?? 0) > 0 || (customAnswers[i]?.trim().length ?? 0) > 0;
    }
    return (questionAnswers[i]?.length ?? 0) > 0;
  });

  function submitQuestion() {
    if (!pendingQuestion || !questionReady) return;
    // Merge custom free-text into answers: if no option selected but custom text present, use it
    const finalAnswers = pendingQuestion.questions.map((q, i) => {
      if (q.custom && (questionAnswers[i]?.length ?? 0) === 0 && customAnswers[i]?.trim()) {
        return [customAnswers[i].trim()];
      }
      return questionAnswers[i] ?? [];
    });
    vscode.postMessage({ type: 'questionReply', requestID: pendingQuestion.id, answers: finalAnswers });
    pendingQuestion = null;
    questionAnswers = [];
    customAnswers   = [];
  }

  function rejectQuestion() {
    if (!pendingQuestion) return;
    vscode.postMessage({ type: 'questionReject', requestID: pendingQuestion.id });
    pendingQuestion = null;
    questionAnswers = [];
    customAnswers   = [];
  }

  // ── Permission card helpers ──────────────────────────────────────────────

  function replyPermission(reply: 'once' | 'always' | 'reject') {
    if (!pendingPermission) return;
    vscode.postMessage({ type: 'permissionReply', requestID: pendingPermission.id, reply });
    pendingPermission = null;
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  function handleAbort() {
    isThinking = false;
    vscode.postMessage({ type: 'abort' });
  }

  function startEdit(msg: UserMessage) {
    editingMessageId = msg.id;
    editingServerId = msg.serverId ?? null;
    editOriginalText = msg.text;
    inputText = msg.text;
  }

  function cancelEdit() {
    editingMessageId = null;
    editingServerId = null;
    inputText = '';
    editOriginalText = '';
  }

  function handleSend() {
    const text = inputText.trim();
    if (!text) return;

    if (editingMessageId !== null) {
      // Trim messages: drop the edited bubble and everything after it
      const idx = messages.findIndex(m => m.id === editingMessageId);
      const trimmed = idx >= 0 ? messages.slice(0, idx) : messages;
      messages = [...trimmed, { kind: 'user', text, id: nextId(), serverId: undefined }];
      isThinking = true;
      vscode.postMessage({ type: 'editMessage', text, editMessageId: editingServerId });
      // Clear edit state
      editingMessageId = null;
      editingServerId = null;
      editOriginalText = '';
    } else {
      messages = [...messages, { kind: 'user', text, id: nextId() }];
      isThinking = true;
      vscode.postMessage({ type: 'send', text });
    }

    // Push to history; drop duplicate if same as last entry
    if (historyStack.length === 0 || historyStack[historyStack.length - 1] !== text) {
      historyStack = [...historyStack, text];
    }
    historyCursor = historyStack.length;
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
          if (st?.type === 'busy') {
            isThinking = true;
          } else if (st?.type === 'idle') {
            isThinking = false;
          } else if (st?.type === 'error') {
            isThinking = false;
            status = 'error';
            statusMessage = st.error ? String(st.error) : 'Session error';
          }
          break;
        }
        case 'question.asked': {
          const props = data.properties as QuestionRequest | undefined;
          if (props && Array.isArray(props.questions)) {
            pendingQuestion = props;
            questionAnswers = props.questions.map(() => []);
            customAnswers   = props.questions.map(() => '');
            scrollToBottom();
          }
          break;
        }
        case 'question.replied':
        case 'question.rejected': {
          pendingQuestion = null;
          questionAnswers = [];
          customAnswers   = [];
          break;
        }
        case 'permission.asked': {
          const props = data.properties as PermissionRequest | undefined;
          if (props && props.id) {
            pendingPermission = props;
            scrollToBottom();
          }
          break;
        }
        case 'permission.replied':
        case 'permission.rejected': {
          pendingPermission = null;
          break;
        }
        case 'session.idle': {
          isThinking = false;
          break;
        }
        case 'newSession': {
          messages = [];
          isThinking = false;
          // Do NOT reset status here — the server is still running.
          // The extension will immediately follow with a status message.
          statusMessage = '';
          // Reset prompt history for the new session
          historyStack = [];
          historyCursor = 0;
          historySaved = '';
          inputText = '';
          // Clear edit state
          editingMessageId = null;
          editingServerId = null;
          editOriginalText = '';
          // Clear any pending cards
          pendingQuestion = null;
          questionAnswers = [];
          customAnswers   = [];
          pendingPermission = null;
          // Clear session panel
          showSessionPanel = false;
          currentSessionTitle = undefined;
          // Reset context selections (will be re-fetched when server confirms ready)
          currentAgent = undefined;
          currentModelId = undefined;
          currentProviderID = undefined;
          currentModelName = undefined;
          currentVariant = undefined;
          contextError = undefined;
          break;
        }
        case 'sessionRestored': {
          messages = Array.isArray(data.messages) ? data.messages as Message[] : [];
          isThinking = false;
          // Reset prompt history for the restored session
          historyStack = [];
          historyCursor = 0;
          historySaved = '';
          inputText = '';
          // Clear edit state
          editingMessageId = null;
          editingServerId = null;
          editOriginalText = '';
          status = 'ready';
          statusMessage = '';
          const cur = data.current ?? {};
          if (cur.agent) currentAgent = cur.agent;
          if (cur.modelId) {
            currentModelId = cur.modelId;
            currentProviderID = cur.providerID;
            currentModelName = models.find(m => m.id === cur.modelId && m.providerID === cur.providerID)?.name ?? cur.modelId;
          }
          currentVariant = cur.variant;
          // Close session panel after switching
          showSessionPanel = false;
          scrollToBottom();
          break;
        }
        case 'sessionList': {
          sessionList = Array.isArray(data.sessions) ? data.sessions : [];
          activeSessionId = typeof data.activeId === 'string' ? data.activeId : null;
          // Keep current title in sync
          const active = sessionList.find(s => s.id === activeSessionId);
          if (active) currentSessionTitle = active.title;
          sessionListLoading = false;
          break;
        }
        case 'context': {
          isContextLoaded = true;
          agents = Array.isArray(data.agents) ? data.agents : [];
          models = Array.isArray(data.models) ? data.models : [];
          const cur = data.current ?? {};
          currentAgent = cur.agent ?? agents[0]?.name;
          currentModelId = cur.modelId ?? models[0]?.id;
          currentProviderID = cur.providerID ?? models[0]?.providerID;
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
          isContextLoaded = true;
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
  {#if isContextLoaded}
  <!-- Status bar -->
  <div class="status-bar" class:status-connecting={status === 'connecting'} class:status-ready={status === 'ready'} class:status-error={status === 'error'}>
    <span class="status-dot"></span>
    <span class="status-text">{status}{statusMessage ? ': ' + statusMessage : ''}</span>
  </div>

  <!-- Context bar -->
  {#if agents.length > 0 || models.length > 0 || contextError || true}
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
      <!-- Session picker button (always visible in context bar) -->
      <button class="context-chip session-chip" on:click={toggleSessionPanel} title="Sessions" class:active={showSessionPanel}>
        <span class="chip-icon">⊞</span>
        <span class="chip-label">{currentSessionTitle ?? 'Sessions'}</span>
      </button>
      <!-- New session button -->
      <button class="context-chip new-session-btn" on:click={() => vscode.postMessage({ type: 'newSession' })} title="New session">
        <span class="chip-icon">+</span>
      </button>
    </div>
  {/if}

  <!-- Session panel overlay -->
  {#if showSessionPanel}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="session-overlay" on:keydown={handleSessionPanelKeydown}>
      <div class="session-panel">
        <div class="session-panel-header">
          <span class="session-panel-title">Sessions</span>
          <button class="session-panel-close" on:click={() => { showSessionPanel = false; renamingId = null; }} title="Close">✕</button>
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
                  <!-- Inline rename input -->
                  <!-- svelte-ignore a11y-autofocus -->
                  <input
                    class="session-rename-input"
                    autofocus
                    bind:value={renameValue}
                    on:keydown={(e) => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') renamingId = null; }}
                    on:blur={() => commitRename(s.id)}
                  />
                {:else}
                  <button class="session-title-btn" on:click={() => switchSession(s.id)} title="Switch to this session">
                    <span class="session-title">{s.title || '(untitled)'}</span>
                    <span class="session-time">{relativeTime(s.time?.updated ?? s.time?.created ?? 0)}</span>
                  </button>
                  <div class="session-actions">
                    <button class="session-action-btn" title="Rename" on:click={() => startRename(s.id, s.title)}>✎</button>
                    <button class="session-action-btn" title="Fork" on:click={() => forkSession(s.id)}>⑂</button>
                    <button class="session-action-btn session-delete-btn" title="Delete" on:click={() => deleteSession(s.id)}>🗑</button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Message list -->
  <div class="message-list" bind:this={messageListEl} on:scroll={onScroll}>
    {#each messages as msg (msg.id)}
      {#if msg.kind === 'user'}
        <div class="message user-message">
          <div class="user-bubble-wrap" class:editing={msg.id === editingMessageId}>
            <div class="bubble user-bubble">{msg.text}</div>
            <button class="edit-btn" title="Edit message" on:click={() => startEdit(msg)}>✎</button>
          </div>
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

    {#if isThinking}
      <div class="message assistant-message thinking-indicator">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <button class="stop-button" on:click={handleAbort} title="Stop generation">Stop</button>
      </div>
    {/if}
  </div>

  <!-- Question card -->
  {#if pendingQuestion}
    <div class="prompt-card question-card">
      <div class="card-header">
        <span class="card-icon">?</span>
        <span class="card-title">Question{pendingQuestion.questions.length > 1 ? 's' : ''}</span>
      </div>
      {#each pendingQuestion.questions as qi, i}
        <div class="card-question">
          {#if qi.header}
            <div class="card-question-header">{qi.header}</div>
          {/if}
          <div class="card-question-body">{qi.question}</div>
          <div class="card-options">
            {#each qi.options as opt}
              <button
                class="card-option-btn"
                class:selected={questionAnswers[i]?.includes(opt.label)}
                title={opt.description}
                on:click={() => toggleQuestionOption(i, opt.label, qi.multiple ?? false)}
              >{opt.label}</button>
            {/each}
          </div>
          {#if qi.custom}
            <input
              class="card-custom-input"
              type="text"
              placeholder="Or type a custom answer…"
              bind:value={customAnswers[i]}
            />
          {/if}
        </div>
      {/each}
      <div class="card-actions">
        <button class="card-action-primary" disabled={!questionReady} on:click={submitQuestion}>Submit</button>
        <button class="card-action-secondary" on:click={rejectQuestion}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Permission card -->
  {#if pendingPermission}
    <div class="prompt-card permission-card">
      <div class="card-header">
        <span class="card-icon">⚠</span>
        <span class="card-title">Permission Request</span>
      </div>
      <div class="card-permission-body">
        <span class="card-permission-name">{pendingPermission.permission}</span>
        {#if pendingPermission.patterns?.length}
          <ul class="card-permission-patterns">
            {#each pendingPermission.patterns as p}
              <li><code>{p}</code></li>
            {/each}
          </ul>
        {/if}
      </div>
      <div class="card-actions">
        <button class="card-action-primary"   on:click={() => replyPermission('once')}>Allow once</button>
        <button class="card-action-always"    on:click={() => replyPermission('always')}>Allow always</button>
        <button class="card-action-secondary" on:click={() => replyPermission('reject')}>Deny</button>
      </div>
    </div>
  {/if}

  <!-- Edit mode banner -->
  {#if editingMessageId !== null}
    <div class="edit-banner">
      <span>Editing message</span>
      <button class="edit-cancel-btn" on:click={cancelEdit}>✕ Cancel</button>
    </div>
  {/if}

  <!-- Input area -->
  <div class="input-area">
    <textarea
      class="chat-input"
      placeholder="Type a message…"
      bind:value={inputText}
      on:keydown={handleKeydown}
      rows="1"
      disabled={!!pendingQuestion || !!pendingPermission}
    ></textarea>
    <button
      class="send-button"
      on:click={handleSend}
      disabled={!canSend}
    >Send</button>
  </div>
  {:else if status === 'error'}
    <div class="loading-screen">
      <span class="loading-error-icon">⚠</span>
      <p class="loading-text">Failed to start server</p>
      {#if statusMessage}<p class="loading-subtext">{statusMessage}</p>{/if}
      <button class="loading-retry-btn" on:click={() => vscode.postMessage({ type: 'getStatus' })}>Retry</button>
    </div>
  {:else}
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Starting opencode…</p>
    </div>
  {/if}
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
    position: relative;
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

  .user-bubble-wrap {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    max-width: 80%;
  }

  .user-bubble-wrap .edit-btn {
    display: none;
    position: absolute;
    left: -26px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.5;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    line-height: 1;
  }

  .user-bubble-wrap:hover .edit-btn,
  .user-bubble-wrap.editing .edit-btn {
    display: block;
  }

  .user-bubble-wrap .edit-btn:hover { opacity: 1; }

  .user-bubble-wrap.editing .user-bubble {
    outline: 2px solid var(--vscode-focusBorder, #007acc);
    outline-offset: 1px;
  }

  /* Edit mode banner */
  .edit-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    font-size: 11px;
    background: var(--vscode-inputValidation-infoBackground, rgba(0,122,204,0.15));
    border-top: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
    color: var(--vscode-foreground);
    flex-shrink: 0;
  }

  .edit-cancel-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    opacity: 0.7;
    padding: 0 4px;
  }
  .edit-cancel-btn:hover { opacity: 1; }

  .assistant-message {
    align-items: flex-start;
    max-width: 100%;
  }

  .thinking-indicator {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 5px;
    padding: 6px 2px;
    min-height: 24px;
  }

  .thinking-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: var(--vscode-foreground);
    opacity: 0.4;
    animation: thinking-bounce 1.2s ease-in-out infinite;
  }

  .thinking-dot:nth-child(1) { animation-delay: 0s; }
  .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dot:nth-child(3) { animation-delay: 0.4s; }

  .stop-button {
    margin-left: 8px;
    padding: 2px 8px;
    font-size: 11px;
    border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border, #555));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.8;
    line-height: 1.4;
  }
  .stop-button:hover { opacity: 1; }

  @keyframes thinking-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30%            { transform: translateY(-5px); opacity: 1; }
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

  /* ── Prompt cards (question / permission) ─────────────────────────────── */

  .prompt-card {
    flex-shrink: 0;
    margin: 0 12px 8px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    background: var(--vscode-input-background);
    overflow: hidden;
  }

  .question-card {
    border-left: 3px solid var(--vscode-charts-blue, #4fc1ff);
  }

  .permission-card {
    border-left: 3px solid var(--vscode-charts-yellow, #e5c07b);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }

  .card-icon {
    font-size: 13px;
    opacity: 0.8;
  }

  .card-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }

  .card-question {
    padding: 8px 12px 4px;
  }

  .card-question + .card-question {
    border-top: 1px solid var(--vscode-panel-border, #333);
  }

  .card-question-header {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.6;
    margin-bottom: 2px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .card-question-body {
    font-size: 13px;
    line-height: 1.5;
    margin-bottom: 8px;
  }

  .card-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .card-option-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.1s, background 0.1s;
  }

  .card-option-btn:hover {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground, var(--vscode-input-background));
  }

  .card-option-btn.selected {
    border-color: var(--vscode-charts-blue, #4fc1ff);
    background: color-mix(in srgb, var(--vscode-charts-blue, #4fc1ff) 15%, transparent);
    color: var(--vscode-foreground);
  }

  .card-custom-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-editor-background);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 12px;
    margin-bottom: 4px;
    outline: none;
  }

  .card-custom-input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .card-permission-body {
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.5;
  }

  .card-permission-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border-radius: 3px;
    padding: 1px 6px;
  }

  .card-permission-patterns {
    margin: 6px 0 0 0;
    padding-left: 1.2em;
    font-size: 12px;
    opacity: 0.8;
  }

  .card-permission-patterns li {
    margin: 2px 0;
  }

  .card-permission-patterns code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .card-actions {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-panel-border, #333);
  }

  .card-action-primary {
    padding: 4px 12px;
    border-radius: 4px;
    border: none;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 12px;
    cursor: pointer;
  }

  .card-action-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    filter: brightness(1.1);
  }

  .card-action-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .card-action-always {
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-charts-yellow, #e5c07b);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #e5c07b) 12%, transparent);
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
  }

  .card-action-always:hover {
    background: color-mix(in srgb, var(--vscode-charts-yellow, #e5c07b) 22%, transparent);
  }

  .card-action-secondary {
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
    opacity: 0.8;
  }

  .card-action-secondary:hover {
    border-color: var(--vscode-focusBorder);
    opacity: 1;
  }

  /* Dim the textarea when a card is blocking input */
  .chat-input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Session chip ─────────────────────────────────────────────────────── */
  .session-chip {
    margin-left: auto; /* push to the right end of the context bar */
  }
  .session-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .new-session-btn {
    flex-shrink: 0;
    font-weight: 700;
    font-size: 14px;
    padding: 1px 6px;
  }

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
    border-bottom: 1px solid var(--vscode-panel-border, #444);
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
    border-bottom: 1px solid var(--vscode-panel-border, #444);
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
    gap: 1px;
    padding: 4px 2px;
    color: inherit;
    min-width: 0;
  }

  .session-title {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-time {
    font-size: 10px;
    opacity: 0.5;
  }

  .session-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
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

  /* ── Loading / error screen ───────────────────────────────────────────── */
  .loading-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--vscode-panel-border, #444);
    border-top-color: var(--vscode-foreground);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-text {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    margin: 0;
    opacity: 0.7;
  }

  .loading-subtext {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    margin: 0;
    opacity: 0.5;
    text-align: center;
    max-width: 220px;
  }

  .loading-error-icon {
    font-size: 24px;
    color: var(--vscode-charts-red, #e06c75);
  }

  .loading-retry-btn {
    padding: 4px 14px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    font-size: 12px;
    cursor: pointer;
  }

  .loading-retry-btn:hover {
    border-color: var(--vscode-focusBorder);
  }
</style>
