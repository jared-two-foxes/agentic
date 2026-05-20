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

- [ ] Add `openapi-typescript` as a dev dependency
- [ ] Write `scripts/gen-api.ts` (or an npm script) that:
  - Fetches `http://localhost:4096/doc`
  - Runs `openapi-typescript` to emit `src/client/generated/api.ts`
- [ ] Add `npm run gen:api` script; add `src/client/generated/` to `.gitignore`
- [ ] Create `src/client/api.ts` wrapping the generated types with helpers:
  - `createSession(): Promise<string>` — `POST /session`, returns session ID
  - `sendMessage(sessionId: string, prompt: string): Promise<void>` — `POST /session/:id/message`
  - `subscribeEvents(sessionId: string, onEvent: (e: OpenCodeEvent) => void): () => void` — `GET /session/:id/event` SSE, returns unsubscribe fn
- [ ] Define a discriminated union type `OpenCodeEvent` covering text delta, tool-call start, tool-call result, and error variants

**Acceptance:** `npm run gen:api` succeeds against a running server; `api.ts` compiles with no type errors.

---

## Task 5 — Svelte chat UI

Build the webview frontend.

- [ ] Create `webview/App.svelte` with:
  - Scrollable message list (user bubbles, streamed assistant text, collapsed tool-call cards)
  - Text input + "Send" button pinned to the bottom
  - Status indicator: `connecting | ready | error`
- [ ] Create `webview/main.ts` as the Svelte entry point
- [ ] Create `webview/index.html` as the Vite entry HTML
- [ ] Implement the webview message bridge:
  - `acquireVsCodeApi().postMessage({ type: 'send', text })` on submit
  - `window.addEventListener('message', handler)` to receive streamed events from the extension host
  - Append text deltas to the in-progress assistant message reactively
  - Show tool-call events as collapsed `<details>` cards with tool name + JSON summary
- [ ] Style with minimal CSS (VSCode CSS variables for theming: `--vscode-editor-background`, `--vscode-foreground`, etc.)

**Acceptance:** Chat UI renders, input is functional, messages display correctly for both user and assistant turns.

---

## Task 6 — Message bridge (extension host ↔ webview)

Connect the API client to the Svelte UI via `postMessage`.

- [ ] In `ChatPanel.ts`, listen for `{ type: 'send', text }` messages from the webview
- [ ] On receive: call `api.sendMessage(sessionId, text)` then `api.subscribeEvents(...)` 
- [ ] Forward each `OpenCodeEvent` to the webview via `panel.webview.postMessage(event)`
- [ ] Handle session creation on first message (lazy init): call `api.createSession()` and cache the ID
- [ ] Forward server-ready / server-error status changes to the webview so the status indicator updates
- [ ] Ensure the SSE subscription is torn down when the webview is disposed

**Acceptance:** Typing a prompt and pressing Send streams a response into the chat UI end-to-end.

---

## Task 7 — Extension commands & packaging

Polish and distribute.

- [ ] Register commands in `package.json` under `contributes.commands`:
  - `opencode.startChat` — reveal/focus the sidebar panel
  - `opencode.newSession` — create a new session and reset the chat UI
- [ ] Add a keyboard shortcut for `opencode.startChat` (e.g., `Ctrl+Shift+O`)
- [ ] Wire `opencode.newSession` command handler in `extension.ts`
- [ ] Fill in `package.json` metadata: `displayName`, `description`, `icon`, `categories`, `repository`
- [ ] Add `.vscodeignore` to exclude `node_modules`, `src/`, `webview/`, `scripts/`, `scratch-notes/`
- [ ] Run `vsce package` and confirm a `.vsix` installs and activates cleanly

**Acceptance:** `opencode-vscode-0.0.1.vsix` installs via "Install from VSIX" and the full chat flow works.

---

## Out of scope (v1)

- Diff viewer / approve-reject for file edits
- Code actions ("Fix with opencode", "Explain with opencode")
- Multi-session tabs
- Server authentication (`OPENCODE_SERVER_PASSWORD`)
- JetBrains / other IDE support
