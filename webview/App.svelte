<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import { marked, Renderer } from 'marked';
  import { diffLines } from 'diff';
  import type { Change } from 'diff';
  import Header from './Header.svelte';
  import FilePicker from './FilePicker.svelte';
  import ImagePreview from './ImagePreview.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import ToolCallCard from './ToolCallCard.svelte';
  import ContextLimitCard from './ContextLimitCard.svelte';
  import DOMPurify from 'dompurify';
  import { isWriteTool, isCommandTool } from './toolMeta';
  import '@vscode/codicons/dist/codicon.css';
  import './codicons.css';

  // Configure marked: enable GitHub-flavoured markdown, disable mangling of emails
  marked.setOptions({ gfm: true, breaks: false });

  // ── Shiki syntax highlighting ─────────────────────────────────────────────
  let highlighter: { codeToHtml(code: string, opts: { lang: string; theme: string }): string } | null = null;

  const SHIKI_LANGS = ['typescript', 'javascript', 'python', 'json', 'bash', 'markdown', 'css', 'html'] as const;

  function getVscodeTheme(): string {
    const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
    if (kind === 'vscode-dark' || kind === 'vscode-high-contrast') return 'dark-plus';
    if (kind === 'vscode-light' || kind === 'vscode-high-contrast-light') return 'light-plus';
    return 'dark-plus';
  }

  // Custom marked renderer — reads `highlighter` at call time (closure over module var)
  const _renderer = new Renderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_renderer as any).code = ({ text, lang }: { text: string; lang?: string }) => {
    const rawCode = text;
    const escapedCode = rawCode.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const encodedCode = encodeURIComponent(rawCode);
    const copyBtn = `<button class="copy-btn" data-code="${encodedCode}" title="Copy code">Copy</button>`;
    if (highlighter && lang && (SHIKI_LANGS as readonly string[]).includes(lang)) {
      try {
        const highlighted = highlighter.codeToHtml(rawCode, { lang, theme: getVscodeTheme() });
        return `<div class="code-block-wrap">${highlighted}${copyBtn}</div>`;
      } catch (_e) {
        // fall through to plain
      }
    }
    const safeLang = lang ? lang.replace(/[^a-zA-Z0-9-_]/g, '') : '';
    return `<div class="code-block-wrap"><pre><code class="language-${safeLang}">${escapedCode}</code></pre>${copyBtn}</div>`;
  };
  marked.use({ renderer: _renderer });

  // Reactive renderMarkdown — re-evaluated when highlighter loads so existing blocks re-render
  $: renderMarkdown = (text: string): string => {
    // Reference highlighter so Svelte re-runs this when it changes
    void highlighter;
    return DOMPurify.sanitize(marked.parse(text) as string, { ADD_ATTR: ['data-code'] });
  };

  // Types
  type TextPart = { type: 'text'; partID: string; text: string };
  type ReasoningPart = { type: 'reasoning'; partID: string; text: string; done: boolean };
  type SubtaskPart = { type: 'subtask'; childSessionID: string; agentName?: string; parts: TextPart[] };
  type ToolCallPart = { type: 'tool_call'; partID: string; toolName: string; status: 'pending' | 'running' | 'completed' | 'error' | 'pending-approval'; inputText: string; result?: unknown; diffHunks?: Change[] | null; filePath?: string; originalContent?: string; newContent?: string; pendingApprovalID?: string; commandString?: string };
  type AssistantPart = TextPart | ReasoningPart | SubtaskPart | ToolCallPart;
  type UserMessage = { kind: 'user'; id: string; serverId?: string; text: string };
  type AssistantMessage = { kind: 'assistant'; id: string; parts: AssistantPart[]; usage?: { input: number; output: number; cost: number }; error?: { kind: 'network' | 'model' | 'unknown'; message: string } | null };
  type ErrorMessage = { kind: 'error'; id: string; text: string };
  type Message = UserMessage | AssistantMessage | ErrorMessage;

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
  let chatInputEl: HTMLTextAreaElement;

  // @mention file picker state
  let mentionQuery = '';
  let showMention = false;
  let mentionFiles: string[] = [];
  let filePickerEl: FilePicker;
  let mentionStartIndex = -1;

  // Pending images (clipboard paste)
  let pendingImages: { dataUrl: string; mimeType: string }[] = [];
  let pasteToastMsg: string = '';
  let _pasteToastTimer: ReturnType<typeof setTimeout> | null = null;

  function showPasteToast(msg: string) {
    pasteToastMsg = msg;
    if (_pasteToastTimer !== null) clearTimeout(_pasteToastTimer);
    _pasteToastTimer = setTimeout(() => { pasteToastMsg = ''; _pasteToastTimer = null; }, 3000);
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      if (pendingImages.length >= 5) {
        showPasteToast('Maximum 5 images per message.');
        return;
      }
      const file = item.getAsFile();
      if (!file) continue;
      const mimeType = item.type;
      const reader = new FileReader();
      reader.onload = () => {
        if (pendingImages.length >= 5) {
          showPasteToast('Maximum 5 images per message.');
          return;
        }
        pendingImages = [...pendingImages, { dataUrl: reader.result as string, mimeType }];
      };
      reader.readAsDataURL(file);
      // Only handle the first image item found per paste event
      return;
    }
  }

  function removeImage(index: number) {
    pendingImages = pendingImages.filter((_, i) => i !== index);
  }

  // Pending question / permission state
  let pendingQuestion: QuestionRequest | null = null;
  let questionAnswers: string[][] = [];   // one entry per QuestionInfo; each is array of selected labels
  let customAnswers: string[] = [];       // free-text per QuestionInfo when custom: true
  let currentQuestionIndex = 0;
  let pendingPermission: PermissionRequest | null = null;

  // Session management state
  let showSessionPanel = false;
  let sessionList: SessionInfo[] = [];
  let sessionListLoading = false;
  let activeSessionId: string | null = null;
  let currentSessionTitle: string | undefined = undefined;

  // New task confirmation state
  let showNewTaskConfirm = false;

  function handleNewSessionClick() {
    if (messages.length === 0) {
      vscode.postMessage({ type: 'newSession' });
    } else {
      showNewTaskConfirm = true;
    }
  }

  function confirmNewTask() {
    showNewTaskConfirm = false;
    vscode.postMessage({ type: 'newSession' });
  }

  function cancelNewTask() {
    showNewTaskConfirm = false;
  }

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
  $: canSend = (inputText.trim().length > 0 || pendingImages.length > 0) && status === 'ready' && !pendingQuestion && !pendingPermission && !isThinking && !showNewTaskConfirm;

  // Whether the model is currently generating a response
  let isThinking = false;

  // Known child session IDs (for routing sub-agent stream deltas)
  const childSessionIds = new Set<string>();

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
    if (!messageListEl) return;
    requestAnimationFrame(() => {
      if (messageListEl && _shouldStick) {
        messageListEl.scrollTop = messageListEl.scrollHeight;
      }
    });
  }

  // VSCode sidebar webviews don't forward wheel events until the webview has
  // received a user interaction (click / drag).  Focusing the scroll container
  // on mouseenter means a hover is enough to unblock wheel scrolling, without
  // stealing keyboard focus from the chat input.
  function handleMessageListMouseEnter() {
    if (document.activeElement !== chatInputEl) {
      messageListEl?.focus({ preventScroll: true });
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
    const existing = assistantMsg.parts.find(p => p.type !== 'subtask' && p.partID === partID) as TextPart | undefined;
    if (existing) {
      existing.text += delta;
    } else {
      assistantMsg.parts = [...assistantMsg.parts, { type: 'text', partID, text: delta }];
    }
    messages = [...messages];
    scrollToBottom();
  }

  /** Append a reasoning delta to the part identified by partID, creating it if needed */
  function applyReasoningDelta(partID: string, delta: string) {
    const assistantMsg = getOrCreateAssistantMessage();
    const existing = assistantMsg.parts.find(p => p.type === 'reasoning' && p.partID === partID) as ReasoningPart | undefined;
    if (existing && existing.type === 'reasoning') {
      existing.text += delta;
    } else {
      assistantMsg.parts = [...assistantMsg.parts, { type: 'reasoning', partID, text: delta, done: false }];
    }
    messages = [...messages];
    scrollToBottom();
  }

  /** Append a text delta into the SubtaskPart for the given child session */
  function applySubtaskDelta(childSessionID: string, partID: string, delta: string) {
    // Child deltas before SubtaskPart placeholder is created are dropped intentionally
    const assistantMsg = messages[messages.length - 1];
    if (!assistantMsg || assistantMsg.kind !== 'assistant') return;
    const subtask = assistantMsg.parts.find(
      p => p.type === 'subtask' && (p as SubtaskPart).childSessionID === childSessionID
    ) as SubtaskPart | undefined;
    if (!subtask) return; // placeholder not yet created — intentionally dropped
    const existingPart = subtask.parts.find(p => p.partID === partID);
    if (existingPart) {
      existingPart.text += delta;
    } else {
      subtask.parts = [...subtask.parts, { type: 'text', partID, text: delta }];
    }
    messages = [...messages];
    scrollToBottom();
  }

  /** Get an existing ToolCallPart by callID, or create one and append it to the current assistant message */
  function getOrCreateToolCallPart(callID: string, toolName?: string): ToolCallPart {
    const assistantMsg = getOrCreateAssistantMessage();
    const existing = assistantMsg.parts.find(
      p => p.type === 'tool_call' && (p as ToolCallPart).partID === callID
    ) as ToolCallPart | undefined;
    if (existing) {
      if (toolName) existing.toolName = toolName;
      return existing;
    }
    const part: ToolCallPart = { type: 'tool_call', partID: callID, toolName: toolName ?? '', status: 'pending', inputText: '' };
    assistantMsg.parts = [...assistantMsg.parts, part];
    messages = [...messages];
    return part;
  }

  function tryParseJSON(s: string): unknown {
    try { return JSON.parse(s); } catch { return s; }
  }

  function getToolSummary(toolName: string, inputText: string): string {
    try {
      const inp = JSON.parse(inputText) as Record<string, unknown>;
      for (const key of ['filePath', 'path', 'command', 'pattern', 'query', 'url']) {
        if (typeof inp[key] === 'string') return (inp[key] as string).slice(0, 80);
      }
      const keys = Object.keys(inp);
      if (keys.length > 0) return JSON.stringify(inp[keys[0]]).slice(0, 80);
    } catch { /* no-op */ }
    return toolName;
  }

  // ── Session management helpers ───────────────────────────────────────────

  function toggleSessionPanel() {
    showSessionPanel = !showSessionPanel;
    if (showSessionPanel) {
      sessionListLoading = true;
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

  function forkSession(id: string) {
    showSessionPanel = false;
    vscode.postMessage({ type: 'forkSession', sessionId: id });
  }

  function handleRenameConfirm(id: string, title: string) {
    if (title) {
      vscode.postMessage({ type: 'renameSession', sessionId: id, title });
      sessionList = sessionList.map(s => s.id === id ? { ...s, title } : s);
      if (id === activeSessionId) currentSessionTitle = title;
    }
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

  $: currentQuestionReady = pendingQuestion
    ? (questionAnswers[currentQuestionIndex]?.length > 0 ||
       (pendingQuestion.questions[currentQuestionIndex]?.custom
         ? customAnswers[currentQuestionIndex]?.trim().length > 0
         : false))
    : false;
  $: isLastQuestion = pendingQuestion
    ? currentQuestionIndex === pendingQuestion.questions.length - 1
    : true;

  function submitQuestion() {
    if (!pendingQuestion || !currentQuestionReady) return;
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
    currentQuestionIndex = 0;
  }

  function rejectQuestion() {
    if (!pendingQuestion) return;
    vscode.postMessage({ type: 'questionReject', requestID: pendingQuestion.id });
    pendingQuestion = null;
    questionAnswers = [];
    customAnswers   = [];
    currentQuestionIndex = 0;
  }

  function advanceQuestion() {
    if (!pendingQuestion) return;
    if (currentQuestionIndex < pendingQuestion.questions.length - 1) {
      currentQuestionIndex++;
    }
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
    if (!text && pendingImages.length === 0) return;

    const imagesToSend = [...pendingImages];

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
      vscode.postMessage({ type: 'send', text, images: imagesToSend });
    }

    // Push to history; drop duplicate if same as last entry
    if (text && (historyStack.length === 0 || historyStack[historyStack.length - 1] !== text)) {
      historyStack = [...historyStack, text];
    }
    historyCursor = historyStack.length;
    historySaved = '';
    inputText = '';
    pendingImages = [];
    requestAnimationFrame(() => {
      if (chatInputEl) resizeTextarea(chatInputEl);
    });
  }

  function handleRetry(failedMsg: AssistantMessage) {
    const idx = messages.findIndex(m => m.id === failedMsg.id);
    if (idx < 1) return;
    const preceding = messages[idx - 1];
    if (preceding.kind !== 'user') return;
    const text = preceding.text;
    messages = messages.slice(0, idx);
    isThinking = true;
    vscode.postMessage({ type: 'send', text });
  }

  function isContextLimitError(message: string): boolean {
    return /context.length.exceeded|context length|too long|maximum context/i.test(message);
  }

  function handleNewTask() {
    // newSession is the correct IPC type handled by ChatPanel.ts;
    // skip the confirmation dialog since the user is already in a broken context-limit state
    vscode.postMessage({ type: 'newSession' });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (showMention && mentionFiles.length > 0) {
      if (e.key === 'ArrowUp') { e.preventDefault(); filePickerEl?.moveUp(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); filePickerEl?.moveDown(); return; }
      if (e.key === 'Enter') { e.preventDefault(); filePickerEl?.selectActive(); return; }
      if (e.key === 'Escape') { e.preventDefault(); showMention = false; return; }
    }
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

  function insertMention(path: string) {
    const before = inputText.slice(0, mentionStartIndex);
    const after = inputText.slice(mentionStartIndex + 1 + mentionQuery.length);
    inputText = `${before}@${path}${after}`;
    showMention = false;
    mentionFiles = [];
    // restore focus + cursor after the inserted token
    setTimeout(() => {
      chatInputEl?.focus();
      const pos = before.length + 1 + path.length;
      chatInputEl?.setSelectionRange(pos, pos);
    }, 0);
  }

  function resizeTextarea(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  let fetchFilesTimer: ReturnType<typeof setTimeout>;
  function debouncedFetchFiles(query: string) {
    clearTimeout(fetchFilesTimer);
    fetchFilesTimer = setTimeout(() => {
      vscode.postMessage({ type: 'fetchFiles', query });
    }, 150);
  }

  function handleInput(e: Event): void {
    const el = e.currentTarget as HTMLTextAreaElement;
    resizeTextarea(el);
    // Detect @mention
    const val = inputText;
    const cursor = el.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx !== -1) {
      const fragment = before.slice(atIdx + 1);
      if (!fragment.includes(' ') && !fragment.includes('\n')) {
        mentionQuery = fragment;
        mentionStartIndex = atIdx;
        showMention = true;
        debouncedFetchFiles(fragment);
        return;
      }
    }
    showMention = false;
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
          if (val === 'error' && isContextLoaded) {
            isThinking = false;
            const lastAsst = [...messages].reverse().find(m => m.kind === 'assistant') as AssistantMessage | undefined;
            if (lastAsst) {
              lastAsst.error = { kind: 'network', message: statusMessage || 'Connection lost' };
              messages = [...messages];
            } else {
              messages = [...messages, { kind: 'error', id: nextId(), text: statusMessage || 'An error occurred' }];
            }
          }
          scrollToBottom();
          break;
        }
        case 'message.part.delta': {
          const props = data.properties ?? {};
          if (typeof props.delta !== 'string' || typeof props.partID !== 'string') break;
          const sessionID = props.sessionID as string | undefined;
          const isChild = sessionID != null && childSessionIds.has(sessionID);
          if (isChild) {
            // Route ALL child deltas (text or reasoning) into the subtask card
            applySubtaskDelta(sessionID!, props.partID, props.delta);
          } else if (props.field === 'reasoning') {
            applyReasoningDelta(props.partID, props.delta);
          } else if (props.field === 'text') {
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
            const errText = st.error ? String(st.error) : 'Session error';
            statusMessage = errText;
            const lastAsst = [...messages].reverse().find(m => m.kind === 'assistant') as AssistantMessage | undefined;
            if (lastAsst) {
              lastAsst.error = { kind: 'model', message: errText };
              messages = [...messages];
            } else {
              messages = [...messages, { kind: 'error', id: nextId(), text: errText }];
            }
            scrollToBottom();
          }
          break;
        }
        case 'question.asked': {
          const props = data.properties as QuestionRequest | undefined;
          if (props && Array.isArray(props.questions)) {
            pendingQuestion = props;
            questionAnswers = props.questions.map(() => []);
            customAnswers   = props.questions.map(() => '');
            currentQuestionIndex = 0;
            scrollToBottom();
          }
          break;
        }
        case 'question.replied':
        case 'question.rejected': {
          pendingQuestion = null;
          questionAnswers = [];
          customAnswers   = [];
          currentQuestionIndex = 0;
          break;
        }
        case 'permission.asked': {
          const props = data.properties as PermissionRequest | undefined;
          if (props && props.id) {
            if (isWriteTool(props.permission)) {
              // Route write-tool permissions inline to the matching ToolCallPart
              const assistantMsg = messages.slice().reverse().find(m => m.kind === 'assistant') as AssistantMessage | undefined;
              if (assistantMsg) {
                const tcPart = assistantMsg.parts.slice().reverse().find(
                  p => p.type === 'tool_call' && isWriteTool((p as ToolCallPart).toolName) && (p as ToolCallPart).status === 'running'
                ) as ToolCallPart | undefined;
                if (tcPart) {
                  tcPart.status = 'pending-approval';
                  tcPart.pendingApprovalID = props.id;
                  messages = [...messages];
                  scrollToBottom();
                  break;
                }
              }
              // Fallback: no running write tool found — use bottom card
            } else if (isCommandTool(props.permission)) {
              const assistantMsg = messages.slice().reverse().find(m => m.kind === 'assistant') as AssistantMessage | undefined;
              if (assistantMsg) {
                const tcPart = assistantMsg.parts.slice().reverse().find(
                  p => p.type === 'tool_call' && isCommandTool((p as ToolCallPart).toolName) && (p as ToolCallPart).status === 'running'
                ) as ToolCallPart | undefined;
                if (tcPart) {
                  tcPart.status = 'pending-approval';
                  tcPart.pendingApprovalID = props.id;
                  // Extract command string from inputText JSON
                  try {
                    const parsed = JSON.parse(tcPart.inputText) as Record<string, unknown>;
                    tcPart.commandString = typeof parsed.command === 'string' ? parsed.command : undefined;
                  } catch { /* ignore */ }
                  messages = [...messages];
                  scrollToBottom();
                  break;
                }
              }
            }
            pendingPermission = props;
            scrollToBottom();
          }
          break;
        }
        case 'permission.replied':
        case 'permission.rejected': {
          pendingPermission = null;
          // Also clear any pending-approval ToolCallPart
          for (const msg of messages) {
            if (msg.kind !== 'assistant') continue;
            for (const p of msg.parts) {
              if (p.type === 'tool_call' && (p as ToolCallPart).status === 'pending-approval') {
                const tc = p as ToolCallPart;
                if (data.type === 'permission.replied') {
                  tc.status = 'running';
                } else {
                  tc.status = 'error';
                  tc.result = 'Rejected by user';
                }
                tc.pendingApprovalID = undefined;
              }
            }
          }
          messages = [...messages];
          break;
        }
        case 'session.idle': {
          isThinking = false;
          break;
        }
        case 'session.created': {
          // A child (sub-agent) session was spawned; create a SubtaskPart placeholder
          const childId = data.properties?.sessionID as string | undefined;
          const agentName = data.properties?.info?.title as string | undefined;
          if (!childId) break;
          childSessionIds.add(childId);
          const assistantMsg = getOrCreateAssistantMessage();
          assistantMsg.parts = [
            ...assistantMsg.parts,
            { type: 'subtask', childSessionID: childId, agentName, parts: [] } as SubtaskPart,
          ];
          messages = [...messages];
          scrollToBottom();
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
          currentQuestionIndex = 0;
          pendingPermission = null;
          // Clear child session tracking
          childSessionIds.clear();
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
          childSessionIds.clear();
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
        case 'step-finish': {
          const props = data.properties ?? {};
          const tokens = props.tokens as { input?: number; output?: number } | undefined;
          const cost = typeof props.cost === 'number' ? props.cost : 0;
          const inputTok = typeof tokens?.input === 'number' ? tokens.input : 0;
          const outputTok = typeof tokens?.output === 'number' ? tokens.output : 0;
          const lastAsst = [...messages].reverse().find(m => m.kind === 'assistant') as AssistantMessage | undefined;
          if (lastAsst) {
            const prev = lastAsst.usage ?? { input: 0, output: 0, cost: 0 };
            lastAsst.usage = {
              input: prev.input + inputTok,
              output: prev.output + outputTok,
              cost: prev.cost + cost,
            };
            messages = messages;
          }
          break;
        }
        case 'session.next.tool.input.started': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const toolName = props.name as string | undefined;
          if (!callID) break;
          getOrCreateToolCallPart(callID, toolName);
          scrollToBottom();
          break;
        }
        case 'session.next.tool.input.delta': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const delta = props.delta as string | undefined;
          if (!callID || !delta) break;
          const tcPart = getOrCreateToolCallPart(callID);
          tcPart.inputText += delta;
          messages = messages;
          break;
        }
        case 'session.next.tool.input.ended': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const text = props.text as string | undefined;
          if (!callID || text === undefined) break;
          const tcPart = getOrCreateToolCallPart(callID);
          tcPart.inputText = text;
          messages = messages;
          break;
        }
        case 'session.next.tool.called': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const toolName = props.tool as string | undefined;
          if (!callID) break;
          const tcPart = getOrCreateToolCallPart(callID, toolName);
          tcPart.status = 'running';
          messages = messages;
          scrollToBottom();
          break;
        }
        case 'session.next.tool.success': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const content = props.content as Array<{ type: string; text?: string }> | undefined;
          const originalContent = props.originalContent as string | undefined;
          const newContent = props.newContent as string | undefined;
          const filePath = props.filePath as string | undefined;
          if (!callID) break;
          const tcPart = getOrCreateToolCallPart(callID);
          tcPart.status = 'completed';
          if (Array.isArray(content)) {
            tcPart.result = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
          }
          // Compute diff when extension host injected original + new file content
          if (originalContent !== undefined && newContent !== undefined && isWriteTool(tcPart.toolName)) {
            tcPart.diffHunks = diffLines(originalContent, newContent);
            tcPart.originalContent = originalContent;
            tcPart.newContent = newContent;
          }
          if (filePath !== undefined) {
            tcPart.filePath = filePath;
          }
          messages = messages;
          break;
        }
        case 'session.next.tool.failed': {
          const props = data.properties ?? {};
          const callID = props.callID as string | undefined;
          const error = props.error as { message?: string } | string | undefined;
          if (!callID) break;
          const tcPart = getOrCreateToolCallPart(callID);
          tcPart.status = 'error';
          tcPart.result = typeof error === 'string' ? error : (error?.message ?? 'Tool failed');
          messages = messages;
          break;
        }
        case 'fileList':
          mentionFiles = Array.isArray(data.files) ? data.files : [];
          break;
        default:
          // unknown message type — ignore
          break;
      }
    };

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getStatus' });

    // Delegated click handler for copy buttons (event delegation — one listener for all blocks)
    function onCopyClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('copy-btn')) return;
      const encoded = target.dataset.code ?? '';
      const code = decodeURIComponent(encoded);
      navigator.clipboard.writeText(code).then(() => {
        const prev = target.textContent;
        target.textContent = 'Copied!';
        setTimeout(() => { target.textContent = prev; }, 1500);
      }).catch(() => {});
    }
    messageListEl.addEventListener('click', onCopyClick);

    // Lazy-load shiki (non-blocking)
    import('shiki').then(({ createHighlighter }) => {
      return createHighlighter({
        langs: [...SHIKI_LANGS],
        themes: ['dark-plus', 'light-plus'],
      });
    }).then((hl) => {
      highlighter = hl;
    }).catch(() => {
      // shiki failed to load — plain code blocks remain
    });

    // Return cleanup
    return () => {
      window.removeEventListener('message', handler);
      messageListEl?.removeEventListener('click', onCopyClick);
    };
  });

  afterUpdate(() => {
    scrollToBottom();
  });
</script>

<div class="chat-container">
  {#if isContextLoaded}
  <Header
    modelLabel={currentModelName ?? currentModelId ?? ''}
    onModelClick={() => vscode.postMessage({ type: 'pickModel' })}
    onHistoryClick={toggleSessionPanel}
    onSettingsClick={() => vscode.postMessage({ type: 'openSettings' })}
    onNewSessionClick={handleNewSessionClick}
  />
  <!-- Context bar -->
  {#if contextError || currentAgent !== undefined || agents.length > 0 || showVariantChip}
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
        {#if showVariantChip}
          <button class="context-chip" on:click={() => vscode.postMessage({ type: 'pickVariant' })} title="Select variant">
            <span class="chip-icon">◇</span>
            <span class="chip-label">{currentVariant ?? 'default'}</span>
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Session panel overlay -->
  {#if showSessionPanel}
    <HistoryPanel
      {sessionList}
      {sessionListLoading}
      {activeSessionId}
      onClose={() => { showSessionPanel = false; }}
      onSwitch={switchSession}
      onRenameConfirm={handleRenameConfirm}
      onFork={forkSession}
      onDelete={deleteSession}
    />
  {/if}

  <!-- Message list -->
  <div class="message-list" bind:this={messageListEl} on:scroll={onScroll}
       role="log" aria-label="Chat messages" aria-live="polite"
       tabindex="-1" on:mouseenter={handleMessageListMouseEnter}>
    {#if messages.length === 0 && !isThinking}
      <div class="empty-state">
        <svg class="empty-state-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M10 4 H38 A4 4 0 0 1 42 8 V30 A4 4 0 0 1 38 34 H18 L6 44 L10 34 A4 4 0 0 1 6 30 V8 A4 4 0 0 1 10 4 Z"
                stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>
          <path d="M14 13 L22 18 L14 23"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          <path d="M24 23 H36"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p class="empty-state-headline">What can I help you with?</p>
        <p class="empty-state-sub">Ask a question, request a change, or describe a task.</p>
      </div>
    {/if}
    {#each messages as msg (msg.id)}
      {#if msg.kind === 'user'}
        <div class="message user-message">
          <div class="user-bubble-wrap" class:editing={msg.id === editingMessageId}>
            <div class="bubble user-bubble">{msg.text}</div>
            <button class="edit-btn" title="Edit message" on:click={() => startEdit(msg)}><i class="codicon codicon-edit"></i></button>
          </div>
        </div>
      {:else if msg.kind === 'assistant'}
        <div class="message assistant-message">
          {#each msg.parts as part (part.type === 'subtask' ? part.childSessionID : part.partID)}
            {#if part.type === 'text'}
              <div class="assistant-text">{@html renderMarkdown(part.text)}</div>
            {:else if part.type === 'reasoning'}
              <details class="reasoning-block">
                <summary class="reasoning-summary">Thinking…</summary>
                <div class="reasoning-body">{part.text}</div>
              </details>
            {:else if part.type === 'subtask'}
              <div class="subtask-card">
                <div class="subtask-header">
                  <span class="subtask-icon" class:subtask-icon--spinning={isThinking}><i class="codicon codicon-sync codicon-modifier-spin"></i></span>
                  <span class="subtask-prefix">Sub-agent</span>
                  {#if part.agentName}
                    <span class="subtask-sep">·</span>
                    <span class="subtask-label">{part.agentName}</span>
                  {/if}
                </div>
                <div class="subtask-body">
                  {#each part.parts as sp (sp.partID)}
                    <div class="subtask-text">{sp.text}</div>
                  {/each}
                </div>
              </div>
            {:else if part.type === 'tool_call'}
              <ToolCallCard
                toolName={part.toolName}
                summary={getToolSummary(part.toolName, part.inputText)}
                status={part.status}
                params={part.inputText ? tryParseJSON(part.inputText) : undefined}
                result={part.result}
                diffHunks={part.diffHunks ?? null}
                filePath={part.filePath}
                originalContent={part.originalContent}
                newContent={part.newContent}
                pendingApprovalID={part.pendingApprovalID}
                commandString={part.commandString}
                onApprove={part.pendingApprovalID ? () => { vscode.postMessage({ type: 'permissionReply', requestID: part.pendingApprovalID, reply: 'once' }); part.status = 'running'; part.pendingApprovalID = undefined; messages = [...messages]; } : undefined}
                onReject={part.pendingApprovalID ? () => { vscode.postMessage({ type: 'permissionReply', requestID: part.pendingApprovalID, reply: 'reject' }); part.status = 'error'; part.result = 'Rejected by user'; part.pendingApprovalID = undefined; messages = [...messages]; } : undefined}
                onOpenSettings={() => vscode.postMessage({ type: 'openSettings' })}
                onOpenDiff={(fp, orig, mod) => vscode.postMessage({ type: 'openDiff', filePath: fp, original: orig, modified: mod })}
              />
            {/if}
          {/each}
          {#if msg.usage}
            <div class="usage-line">↓ {msg.usage.input.toLocaleString()} · ↑ {msg.usage.output.toLocaleString()}{msg.usage.cost > 0 ? ` · $${msg.usage.cost.toPrecision(4)}` : ''}</div>
          {/if}
          {#if msg.error}
            {#if isContextLimitError(msg.error.message ?? '')}
              <ContextLimitCard onNewTask={handleNewTask} />
            {:else}
              <div class="msg-error-banner">
                <span class="msg-error-text">
                  {#if msg.error.kind === 'network'}
                    Connection lost — check that opencode is running
                  {:else if msg.error.kind === 'model'}
                    {msg.error.message}
                  {:else}
                    Something went wrong
                  {/if}
                </span>
                <button class="msg-error-retry" on:click={() => handleRetry(msg)}><i class="codicon codicon-debug-restart"></i> Retry</button>
              </div>
            {/if}
          {/if}
        </div>
      {:else if msg.kind === 'error'}
        <div class="message error-message">
          <span class="error-bubble">{msg.text}</span>
        </div>
      {/if}
    {/each}

    {#if isThinking}
      <div class="message assistant-message thinking-indicator">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <button class="stop-button" on:click={handleAbort} title="Stop generation"><i class="codicon codicon-stop-circle"></i> Stop</button>
      </div>
    {/if}
  </div>

  <!-- Question card -->
  {#if pendingQuestion}
    {#if pendingQuestion.questions[currentQuestionIndex]}
      {@const qi = pendingQuestion.questions[currentQuestionIndex]}
      <div class="prompt-card question-card">
        <div class="card-header">
          <span class="card-icon">?</span>
          <span class="card-title">
            {#if pendingQuestion.questions.length > 1}
              Question {currentQuestionIndex + 1} of {pendingQuestion.questions.length}
            {:else}
              Question
            {/if}
          </span>
        </div>
        <div class="card-question">
          {#if qi.header}
            <div class="card-question-header">{qi.header}</div>
          {/if}
          <div class="card-question-body">{qi.question}</div>
          <div class="card-options">
            {#each qi.options as opt}
              <button
                class="card-option-btn"
                class:selected={questionAnswers[currentQuestionIndex]?.includes(opt.label)}
                title={opt.description}
                on:click={() => toggleQuestionOption(currentQuestionIndex, opt.label, qi.multiple ?? false)}
              >{opt.label}</button>
            {/each}
          </div>
          {#if qi.custom}
            <input
              class="card-custom-input"
              type="text"
              placeholder="Or type a custom answer…"
              bind:value={customAnswers[currentQuestionIndex]}
            />
          {/if}
        </div>
        <div class="card-actions">
          {#if isLastQuestion}
            <button class="card-action-primary" disabled={!currentQuestionReady} on:click={submitQuestion}>Submit</button>
          {:else}
            <button class="card-action-primary" disabled={!currentQuestionReady} on:click={advanceQuestion}>Next</button>
          {/if}
          <button class="card-action-secondary" on:click={rejectQuestion}>Cancel</button>
        </div>
      </div>
    {/if}
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
      <button class="edit-cancel-btn" on:click={cancelEdit}><i class="codicon codicon-close"></i> Cancel</button>
    </div>
  {/if}

  <!-- New task confirmation banner -->
  {#if showNewTaskConfirm}
    <div class="new-task-confirm">
      <span class="new-task-msg">Start a new task? The current conversation will remain in history.</span>
      <div class="new-task-actions">
        <button class="card-action-primary" on:click={confirmNewTask}>Confirm</button>
        <button class="card-action-secondary" on:click={cancelNewTask}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Input area -->
  <div class="input-wrapper">
    {#if showMention}
      <FilePicker
        bind:this={filePickerEl}
        files={mentionFiles}
        query={mentionQuery}
        onSelect={insertMention}
        onDismiss={() => (showMention = false)}
      />
    {/if}
    <div class="input-area">
      <ImagePreview images={pendingImages} onRemove={removeImage} />
      {#if pasteToastMsg}
        <div class="paste-toast">{pasteToastMsg}</div>
      {/if}
      <div class="input-row">
        <textarea
          class="chat-input"
          placeholder="Type a message…"
          bind:value={inputText}
          bind:this={chatInputEl}
          on:keydown={handleKeydown}
          on:input={handleInput}
          on:paste={handlePaste}
          rows="1"
          disabled={!!pendingQuestion || !!pendingPermission}
        ></textarea>
        <button
          class="send-button"
          on:click={handleSend}
          disabled={!canSend}
        ><i class="codicon codicon-send"></i></button>
      </div>
      <div class="input-hint" aria-hidden="true">
        Type <kbd>@</kbd> to attach files · paste an image · <kbd>⇧⏎</kbd> for a new line
      </div>
    </div>
  </div>
  {:else if status === 'error'}
    <div class="loading-screen">
      <span class="loading-error-icon"><i class="codicon codicon-warning"></i></span>
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

  /* Message list */
  .message-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    outline: none; /* suppress focus ring — element only receives focus for wheel events */
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

  /* New task confirmation banner */
  .new-task-confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 12px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border, #444));
    flex-shrink: 0;
    font-size: 12px;
    color: var(--vscode-foreground);
    flex-wrap: wrap;
  }
  .new-task-msg {
    flex: 1;
    min-width: 0;
  }
  .new-task-actions {
    display: flex;
    gap: 6px;
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

  .error-message {
    align-items: flex-start;
  }

  .error-bubble {
    font-size: 12px;
    color: var(--vscode-charts-red, #e06c75);
    opacity: 0.85;
    font-style: italic;
    padding: 2px 0;
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

  .usage-line {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    margin-top: 4px;
    opacity: 0.8;
    user-select: text;
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
  .input-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .input-area {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
  }

  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 12px;
  }

  .paste-toast {
    font-size: 11px;
    color: var(--vscode-inputValidation-warningForeground, #fff);
    background: var(--vscode-inputValidation-warningBackground, #6c4a00);
    border-top: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    padding: 4px 10px;
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

  /* ── Reasoning block ──────────────────────────────────────────────────── */
  .reasoning-block {
    margin: 4px 0;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
    font-size: 12px;
    overflow: hidden;
  }

  .reasoning-summary {
    padding: 4px 10px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    list-style: none;
    user-select: none;
  }
  .reasoning-summary::-webkit-details-marker { display: none; }
  .reasoning-summary::before { content: '▶ '; font-size: 8px; }
  details[open] .reasoning-summary::before { content: '▼ '; }

  .reasoning-body {
    padding: 6px 10px;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.75;
    font-size: 12px;
    line-height: 1.5;
    border-top: 1px solid var(--vscode-panel-border, #444);
  }

  /* ── Subtask card ─────────────────────────────────────────────────────── */
  .subtask-card {
    margin: 6px 0;
    margin-left: 12px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-left: 3px solid var(--vscode-charts-blue, #4fc1ff);
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
    overflow: hidden;
  }

  .subtask-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: color-mix(in srgb, var(--vscode-charts-blue, #4fc1ff) 10%, transparent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .subtask-icon {
    font-size: 14px;
    line-height: 1;
    display: inline-block;
    flex-shrink: 0;
    color: var(--vscode-charts-blue, #4fc1ff);
  }

  .subtask-icon--spinning {
    animation: subtask-spin 1.4s linear infinite;
  }

  @keyframes subtask-spin {
    to { transform: rotate(360deg); }
  }

  .subtask-prefix {
    color: var(--vscode-charts-blue, #4fc1ff);
    text-transform: uppercase;
  }

  .subtask-sep {
    opacity: 0.35;
  }

  .subtask-label {
    opacity: 0.65;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .subtask-body {
    padding: 6px 10px;
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
  }

  .subtask-text {
    white-space: pre-wrap;
    opacity: 0.85;
  }

  /* ── Shiki code blocks & copy button ─────────────────────────────────── */
  :global(.code-block-wrap) {
    position: relative;
    margin: 0 0 0.6em;
  }

  :global(.code-block-wrap pre) {
    margin: 0 !important;
    border-radius: 5px;
    overflow-x: auto;
    padding: 10px 12px !important;
    font-family: var(--vscode-editor-font-family, monospace) !important;
    font-size: 0.88em;
    line-height: 1.5;
  }

  :global(.code-block-wrap pre code) {
    background: none !important;
    padding: 0 !important;
    font-size: inherit;
    line-height: inherit;
    font-family: inherit;
  }

  :global(.code-block-wrap .shiki) {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)) !important;
  }

  :global(.copy-btn) {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    font-size: 11px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 1;
    line-height: 1.4;
  }

  :global(.code-block-wrap:hover .copy-btn) {
    opacity: 1;
  }

  /* ── Per-message error banner ─────────────────────────────────────────── */
  .msg-error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 6px 10px;
    background: var(--vscode-inputValidation-errorBackground, rgba(244, 71, 71, 0.1));
    border-left: 3px solid var(--vscode-editorError-foreground, #f44747);
    border-radius: 0 4px 4px 0;
    font-size: 0.85em;
  }
  .msg-error-text {
    flex: 1;
    color: var(--vscode-editorError-foreground, #f44747);
  }
  .msg-error-retry {
    background: none;
    border: 1px solid var(--vscode-editorError-foreground, #f44747);
    color: var(--vscode-editorError-foreground, #f44747);
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 0.8em;
    white-space: nowrap;
  }
  .msg-error-retry:hover {
    background: var(--vscode-editorError-foreground, #f44747);
    color: var(--vscode-editor-background, #1e1e1e);
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
    padding: 32px 16px;
    pointer-events: none;
    user-select: none;
  }
  .empty-state-icon {
    width: 48px;
    height: 48px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    opacity: 0.3;
    margin-bottom: 4px;
  }
  .empty-state-headline {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    color: var(--vscode-foreground);
    opacity: 0.7;
  }
  .empty-state-sub {
    font-size: 12px;
    margin: 0;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    opacity: 0.5;
  }
  .input-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    opacity: 0.45;
    padding: 0 12px 6px;
    user-select: none;
    line-height: 1.4;
  }
  .input-hint kbd {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    padding: 0 3px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.5));
    border-radius: 2px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
  }
</style>
