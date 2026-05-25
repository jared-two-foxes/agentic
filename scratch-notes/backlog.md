# opencode-vscode Extension — Development Backlog

Minimal proof-of-concept VSCode extension with a Svelte+Vite chat panel backed by `opencode serve`.

---

## Task 1 — Project scaffolding

Set up the monorepo skeleton.

- [x] Create `opencode-vscode/` directory with `package.json` (extension manifest), `tsconfig.json`, `.vscodeignore`, `.gitignore`
- [x] Add dev dependencies: `@types/vscode`, `typescript`, `esbuild`, `@sveltejs/vite-plugin-svelte`, `svelte`, `vite`
- [x] Write `esbuild.mjs` to bundle `src/extension.ts` → `dist/extension.js` (CJS, external `vscode`)
- [x] Write `vite.config.mts` to bundle `webview/` → `dist/webview/` (ESM, Svelte plugin, `base: './'`)
- [x] Add `package.json` scripts: `build:ext`, `build:webview`, `build`, `watch`, `package`
- [x] Verify the project compiles cleanly with no errors

**Acceptance:** `npm run build` produces `dist/extension.js` and `dist/webview/index.html` without errors.

---

## Task 2 — WebviewViewProvider skeleton

Wire up the extension host and serve the Svelte app inside a sidebar panel.

- [x] Create `src/extension.ts` with `activate` / `deactivate` exports
- [x] Create `src/panel/ChatPanel.ts` implementing `vscode.WebviewViewProvider`
  - Resolve compiled webview assets via `webview.asWebviewUri`
  - Apply strict CSP with a random nonce
  - Load `dist/webview/index.html`, inject nonce into script tags at serve time
- [x] Register the provider in `activate` against the view ID `opencode.chatView`
- [x] Declare the view in `package.json` under `contributes.views.activitybar`
- [x] Verify the panel opens and shows "Hello from Svelte" in the sidebar

**Acceptance:** Running the extension in the Extension Development Host shows the sidebar panel with a Svelte-rendered placeholder.

---

## Task 3 — Server lifecycle manager

Auto-start `opencode serve` and manage its lifetime.

- [x] Create `src/server.ts` with a `ServerManager` class
  - Resolve binary path from user setting `opencode.binaryPath` or `PATH`
  - Read port from user setting `opencode.port` (default `4096`)
  - Spawn `opencode serve --port <port>` as a child process
  - Pipe stdout/stderr to a dedicated VSCode Output Channel (`opencode server`)
  - Poll `GET http://localhost:<port>/` with exponential backoff (max 10 s) to detect readiness
  - Emit a `serverReady` event / resolve a promise when ready
  - On `deactivate`, send `SIGTERM`; after 2 s force `SIGKILL`
- [x] Surface a clear error notification (with install docs link) if the binary is not found
- [x] Add VSCode settings contributions to `package.json`: `opencode.port`, `opencode.binaryPath`
- [x] Call `ServerManager.start()` from `activate`; call `stop()` from `deactivate`

**Acceptance:** Activating the extension starts the server process; the Output Channel shows server logs; deactivating kills it cleanly.

---

## Task 4 — Typed API client (code-gen)

Generate a typed TypeScript client from the OpenAPI spec exposed by `opencode serve`.

- [x] Add `openapi-typescript` as a dev dependency
- [x] Write `scripts/gen-api.ts` (or an npm script) that:
  - Fetches `http://localhost:4096/doc`
  - Runs `openapi-typescript` to emit `src/client/generated/api.ts`
- [x] Add `npm run gen:api` script; add `src/client/generated/` to `.gitignore`
- [x] Create `src/client/api.ts` wrapping the generated types with helpers:
  - `createSession(): Promise<string>` — `POST /session`, returns session ID
  - `sendMessage(sessionId: string, prompt: string): Promise<void>` — `POST /session/:id/message`
  - `subscribeEvents(sessionId: string, onEvent: (e: OpenCodeEvent) => void): () => void` — `GET /session/:id/event` SSE, returns unsubscribe fn
- [x] Define a discriminated union type `OpenCodeEvent` covering text delta, tool-call start, tool-call result, and error variants

**Acceptance:** `npm run gen:api` succeeds against a running server; `api.ts` compiles with no type errors.

---

## Task 5 — Svelte chat UI

Build the webview frontend.

- [x] Create `webview/App.svelte` with:
  - Scrollable message list (user bubbles, streamed assistant text, collapsed tool-call cards)
  - Text input + "Send" button pinned to the bottom
  - Status indicator: `connecting | ready | error`
- [x] Create `webview/main.ts` as the Svelte entry point
- [x] Create `webview/index.html` as the Vite entry HTML
- [x] Implement the webview message bridge:
  - `acquireVsCodeApi().postMessage({ type: 'send', text })` on submit
  - `window.addEventListener('message', handler)` to receive streamed events from the extension host
  - Append text deltas to the in-progress assistant message reactively
  - Show tool-call events as collapsed `<details>` cards with tool name + JSON summary
- [x] Style with minimal CSS (VSCode CSS variables for theming: `--vscode-editor-background`, `--vscode-foreground`, etc.)

**Acceptance:** Chat UI renders, input is functional, messages display correctly for both user and assistant turns.

---

## Task 6 — Message bridge (extension host ↔ webview)

Connect the API client to the Svelte UI via `postMessage`.

- [x] In `ChatPanel.ts`, listen for `{ type: 'send', text }` messages from the webview
- [x] On receive: call `api.sendMessage(sessionId, text)` then `api.subscribeEvents(...)`
- [x] Forward each `OpenCodeEvent` to the webview via `panel.webview.postMessage(event)`
- [x] Handle session creation on first message (lazy init): call `api.createSession()` and cache the ID
- [x] Forward server-ready / server-error status changes to the webview so the status indicator updates
- [x] Ensure the SSE subscription is torn down when the webview is disposed

**Acceptance:** Typing a prompt and pressing Send streams a response into the chat UI end-to-end.

---

## Task 7 — Extension commands & packaging

Polish and distribute.

- [x] Register commands in `package.json` under `contributes.commands`:
  - `opencode.startChat` — reveal/focus the sidebar panel
  - `opencode.newSession` — create a new session and reset the chat UI
- [x] Add a keyboard shortcut for `opencode.startChat` (e.g., `Ctrl+Shift+O`)
- [x] Wire `opencode.newSession` command handler in `extension.ts`
- [x] Fill in `package.json` metadata: `displayName`, `description`, `icon`, `categories`, `repository`
- [x] Add `.vscodeignore` to exclude `node_modules`, `src/`, `webview/`, `scripts/`, `scratch-notes/`
- [x] Run `vsce package` and confirm a `.vsix` installs and activates cleanly

**Acceptance:** `opencode-vscode-0.0.1.vsix` installs via "Install from VSIX" and the full chat flow works.

---

## Task 8 — Agent / Model / Variant selector

Surface the active agent, model, and variant in the chat UI and allow the user to change them per-session.

- [x] Add `Agent`, `Model`, `Config`, `CurrentSelection` types to `src/client/api.ts`
- [x] Add `listAgents()`, `listModels()`, `getConfig()` methods to `OpenCodeClient`
- [x] Update `createSession()` to accept an optional `CurrentSelection` and pass agent/model overrides in the POST body
- [x] Add `_agents`, `_models`, `_selection`, `_api` private fields to `ChatPanel`
- [x] Fetch agents/models/config when server becomes ready; post a `context` message to the webview
- [x] Handle `pickAgent`, `pickModel`, `pickVariant` messages via VSCode QuickPick
- [x] Reset the session (clear `_sessionPromise`) when the user changes agent/model/variant so the next send uses the new selection
- [x] Add context bar to `webview/App.svelte` with agent/model/variant chips
- [x] Variant chip hidden when the selected model has no variants
- [x] Context bar uses composite `providerID + modelId` for model identity to avoid collisions across providers

**Acceptance:** Context bar shows current agent/model/variant; clicking a chip opens a QuickPick; selecting a new value resets the session so the next message uses the new selection.


---

## Task 9 — Abort (Stop Generation)

Allow the user to cancel an in-progress model generation.

**Endpoints confirmed:** `POST /session/{sessionID}/abort` — no body, returns `boolean`.

### Step 9.1 — `src/client/api.ts`: add `abort` method
- Add `abort(sessionId: string): Promise<void>` that calls `this.request("POST", `/session/${sessionId}/abort`)`.
- No request body required.
- [x] Implement and verify it compiles.

### Step 9.2 — `src/panel/ChatPanel.ts`: add `abort` message handler
- Extend the `msg` type union on `webviewView.webview.onDidReceiveMessage` to include `type: 'abort'`.
- Add an `if (msg.type === 'abort')` block:
  - Read current session ID from `await this._sessionPromise?.catch(() => undefined)`.
  - If a session ID exists, call `this._api.abort(sessionId)` (fire-and-forget, swallow errors).
- [x] Implement and verify it compiles.

### Step 9.3 — `webview/App.svelte`: add Stop button UI
- When `isThinking === true`, render a "Stop" button alongside the thinking dots.
- `handleAbort()`: posts `{ type: 'abort' }` and optimistically sets `isThinking = false`.
- Style `.stop-button` to be small, muted, inline with the dots (use `--vscode-button-secondaryBackground`).
- [x] Implement, build, and smoke-test in Extension Development Host.

**Acceptance:** While the model is generating, clicking "Stop" sends the abort request and the thinking indicator disappears immediately.

---

## Task 10 — Server-side Session Filtering

Pass `?directory=<workspaceRoot>` to `GET /session` instead of filtering client-side.

**Endpoints confirmed:** `GET /session` supports `?directory=<string>` query param.

### Step 10.1 — `src/client/api.ts`: add `directory` param to `listSessions`
- Change signature to `listSessions(directory?: string): Promise<SessionInfo[]>`.
- When `directory` is provided, append `?directory=${encodeURIComponent(directory)}` to the request URL.
- [x] Implement and verify it compiles.

### Step 10.2 — `src/panel/ChatPanel.ts`: use server-side filtering
- In `_pushSessionList` (currently line ~92): pass `workspaceRoot` to `this._api.listSessions(workspaceRoot)`.
- Remove the client-side `.filter(s => this._normPath(s.directory) === ...)` line (server handles it now).
- Keep the "always include active session" guard (in case it's from another workspace and the server omits it).
- In `_tryRestoreSession` (currently line ~218): pass `workspaceRoot` to `this._api.listSessions(workspaceRoot)`.
- Remove the client-side `candidates` filter there too.
- [x] Implement and verify it compiles.

**Acceptance:** Session list only shows sessions for the current workspace directory without any client-side filtering.

---

## Task 11 — Message Edit / Resend

Allow the user to edit a previous user message and resubmit from that point, discarding subsequent history.

**Endpoints confirmed:**
- `POST /session/{sessionID}/revert` — body `{ messageID: string, partID?: string }` — truncates history to before that message.
- Server message IDs must flow from `ChatPanel._mapToWebviewMessages` through to the webview (currently only local monotonic IDs are sent).

### Step 11.1 — `src/client/api.ts`: add `revertSession` method
- Add `revertSession(sessionId: string, messageId: string): Promise<void>` that calls `this.request("POST", `/session/${sessionId}/revert`, { messageID: messageId })`.
- [x] Implement and verify it compiles.

### Step 11.2 — `src/panel/ChatPanel.ts`: thread server message ID through history mapping
- In `_mapToWebviewMessages`, add `serverId: info.id` to each user message object (alongside `kind`, `id`, `text`).
- This is needed so the webview can send the correct server-side `messageID` in the `editMessage` request.
- [x] Implement and verify it compiles.

### Step 11.3 — `src/panel/ChatPanel.ts`: add `editMessage` handler
- Extend `msg` type to include `editMessageId?: string`.
- Add `if (msg.type === 'editMessage')` block:
  1. Get `sessionId` from `await this._getOrCreateSession(api)`.
  2. Subscribe to SSE (same pattern as the existing `send` handler — subscribe-then-send).
  3. Call `this._api.revertSession(sessionId, msg.editMessageId)` to truncate history server-side.
  4. Call `this._api.sendMessage(sessionId, msg.text, this._selection.agent)` with the replacement text.
- [x] Implement and verify it compiles.

### Step 11.4 — `webview/App.svelte`: add `serverId` to `UserMessage` type and message state
- Add `serverId?: string` to the `UserMessage` type.
- In the `sessionRestored` and incoming message handlers, propagate `serverId` from data into the message objects.
- [x] Implement.

### Step 11.5 — `webview/App.svelte`: add edit state variables
- Add `let editingMessageId: string | null = null` — local message `id` of the bubble being edited.
- Add `let editingServerId: string | null = null` — server-side `messageID` to pass in `editMessage`.
- Add `let editOriginalText = ''` — to restore on cancel.
- [x] Implement.

### Step 11.6 — `webview/App.svelte`: add pencil hover button on user message bubbles
- Wrap the `.user-bubble` content in a relative-positioned container.
- Add an absolutely-positioned pencil button (`✎`) that appears on hover.
- On click:
  1. Set `inputText = msg.text`.
  2. Set `editingMessageId = msg.id`, `editingServerId = msg.serverId ?? null`.
  3. Set `editOriginalText = msg.text`.
- [x] Implement.

### Step 11.7 — `webview/App.svelte`: edit mode indicator + cancel
- When `editingMessageId !== null`, show a small banner above the input area: `"Editing message — "` with a cancel link.
- On cancel: clear `editingMessageId`, `editingServerId`, restore `inputText = editOriginalText` (or clear it).
- [x] Implement.

### Step 11.8 — `webview/App.svelte`: wire `handleSend` to dispatch `editMessage`
- In `handleSend()`: if `editingMessageId !== null`:
  1. Post `{ type: 'editMessage', text, editMessageId: editingServerId }`.
  2. Trim `messages` array: remove all messages after the one with `id === editingMessageId` (inclusive), then add the new user message locally.
  3. Set `isThinking = true`.
  4. Clear edit state.
- Otherwise, post `{ type: 'send', text }` as before.
- [x] Implement, build, and smoke-test end-to-end in Extension Development Host.

**Acceptance:** Hovering a user bubble shows a pencil icon; clicking it loads the text into the input with an "Editing" banner; pressing Send reverts history server-side, resends the edited text, and the conversation continues from that point.

---

## Task 12 — Install and Configure Recallium Server

Recallium is a self-hosted persistent memory server for AI coding assistants. It stores decisions, patterns, API facts, failures, and completed work — and makes them available across sessions via MCP tools (`store_memory`, `search_memories`, `session_recap`, etc.).

This task is **manual / infrastructure** — no code changes to the extension.

### Step 12.1 — Clone and start the Recallium Docker container
- Clone the repo: `git clone https://github.com/recallium-ai/recallium.git`
- Navigate to `recallium/install/`
- Run `start-recallium.bat` (Windows) — this pulls the Docker image and starts the server on `http://localhost:8001`
- Verify by visiting `http://localhost:8001` in a browser
- [ ] Done

### Step 12.2 — Create a per-repo project in the Recallium UI
- Open `http://localhost:8001` → Projects → New Project
- Name it **`opencode-vscode`** — all repo-specific memories will be scoped here
- Global/cross-repo memories (patterns, rules that apply everywhere) go in the default project
- [ ] Done

### Step 12.3 — Verify MCP endpoint is reachable
- Confirm `http://localhost:8001/mcp` responds (can curl or browser-check)
- This is the URL the `recallium` npm package will point to
- [ ] Done

**Acceptance:** `http://localhost:8001` loads the Recallium UI, the `opencode-vscode` project exists, and `/mcp` is reachable.

---

## Task 13 — Recallium MCP + Agent Integration

Wire Recallium into opencode's MCP config and update agent prompts so the AI automatically loads and stores context across sessions.

**Memory categories in scope:**
- Architecture & API facts (endpoint details, structural decisions, naming conventions)
- Failures & rejected approaches (what was tried and why it was dropped)
- Completed features (what shipped, acceptance criteria met)
- Agent / workflow rules (conventions all agents must follow in this repo)

**Memory scoping:** per-repo memories tagged `opencode-vscode`; cross-repo patterns additionally tagged `global`.

**Files affected:** `~/.config/opencode/opencode.json`, `~/.config/opencode/agents/orchestrator.md`, `~/.config/opencode/agents/linear-orchestrator.md`, `~/.config/opencode/agents/summarizer.md`, `~/.config/opencode/agents/planner.md`

---

### Step 13.1 — Add `recallium` to opencode MCP config

**File:** `~/.config/opencode/opencode.json`

Add to the `mcp` block:

```json
"recallium": {
  "type": "local",
  "enabled": true,
  "command": ["npx", "-y", "recallium"],
  "environment": {
    "RECALLIUM_SERVER_URL": "http://localhost:8001/mcp"
  }
}
```

This makes `store_memory`, `search_memories`, `session_recap`, `projects`, `tasks`, and `get_rules` available to all agents in every session.

- [x] Implement and verify opencode picks up the MCP server (restart opencode after editing)

---

### Step 13.2 — Update `orchestrator.md` — session-start context loading

**File:** `~/.config/opencode/agents/orchestrator.md`

Add a **Recallium Context Loading** section near the top (after Toolchain Detection, before planning begins):

```markdown
## Recallium Context Loading

At the start of every session, before planning or implementation:
1. Call `search_memories` with the current repo name (`opencode-vscode`) and the task topic
2. Call `session_recap` to surface what was recently worked on in this repo
3. Read any returned architecture facts, API patterns, failure notes, or rules and incorporate them into your plan

Do not skip this step even if the task seems straightforward — past decisions and known failures are often highly relevant.
```

- [x] Implement

---

### Step 13.3 — Update `orchestrator.md` — during-work memory storage

**File:** `~/.config/opencode/agents/orchestrator.md`

Add a **Recallium Memory Storage** section (after the planning/implementation workflow, before the summary):

```markdown
## Recallium Memory Storage

Store a memory via `store_memory` when any of the following occur:

| Trigger | `type` | Required fields |
|---|---|---|
| A non-obvious architectural decision is made | `decision` | rationale, alternatives considered |
| An API endpoint or schema detail is confirmed | `code-snippet` | tag: `api-fact`, exact path/method/body |
| A reusable pattern is established | `pattern` | file paths, usage guidance |
| An approach is tried and rejected | `failure` | what was tried, why it failed |
| A backlog task or feature is completed | `completed-feature` | acceptance criteria met, files changed |
| A repo-wide convention is established | `rule` | when it applies, why |

Always include:
- `project`: `opencode-vscode` for repo-specific; add tag `global` for cross-repo patterns
- File paths affected
- Sufficient rationale that a future session can act on it without context
```

- [x] Implement

---

### Step 13.4 — Update `linear-orchestrator.md` — add same Recallium sections

**File:** `~/.config/opencode/agents/linear-orchestrator.md`

Apply identical **Recallium Context Loading** and **Recallium Memory Storage** sections as Steps 13.2 and 13.3.

The Linear orchestrator runs the same TDD pipeline but with issue-tracker sync — it needs the same memory behaviour so Linear-driven work is also persisted.

- [x] Implement

---

### Step 13.5 — Update `summarizer.md` — session-end recap storage

**File:** `~/.config/opencode/agents/summarizer.md`

Add a **Recallium Session Summary** section at the end of the agent instructions:

```markdown
## Recallium Session Summary

After producing the execution summary, call `store_memory` with:
- `type`: `session-recap`
- `content`: a concise summary of what was completed this session, what was attempted but not finished, and what the recommended next step is
- `project`: `opencode-vscode`
- `tags`: `opencode-vscode`, `session-recap`
- Include any key decisions or API facts discovered during the session that haven't already been stored

This ensures the next session can orient itself without re-reading the full conversation history.
```

- [x] Implement

---

### Step 13.6 — Update `planner.md` — context loading at plan time

**File:** `~/.config/opencode/agents/planner.md`

Add a **Recallium Context** section at the top of the agent instructions (before acceptance criteria and plan generation):

```markdown
## Recallium Context

Before writing acceptance criteria or an implementation plan:
1. Call `search_memories` for the task topic in the `opencode-vscode` project
2. Check for any stored failures or rejected approaches that would affect the plan
3. Check for stored architecture decisions or API facts relevant to the task
4. Incorporate findings — do not re-plan work that has already been tried and failed; do not contradict established decisions without explicit justification
```

- [x] Implement

---

### Step 13.7 — Smoke test end-to-end

Run a real session and verify the memory flow works:

1. Start a new opencode session in this repo
2. Ask the orchestrator to work on something small (e.g. a minor UI tweak)
3. Confirm `search_memories` is called at session start
4. Confirm at least one `store_memory` call is made during the session
5. Confirm the summarizer calls `store_memory` with type `session-recap` at the end
6. Open `http://localhost:8001` and verify the memories appear in the `opencode-vscode` project

- [ ] Done

**Acceptance:** Memories from the session appear in the Recallium UI under the `opencode-vscode` project; a new session in the same repo surfaces them via `search_memories` at the start.

---

## Future / Unstarted

- Diff viewer / approve-reject for file edits
- Code actions ("Fix with opencode", "Explain with opencode")
- Multi-session tabs
- Server authentication (`OPENCODE_SERVER_PASSWORD`)
- JetBrains / other IDE support
