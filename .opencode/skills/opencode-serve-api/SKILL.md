---
name: opencode-serve-api
description: Use when building or debugging features that call the opencode serve HTTP API (localhost:4096). Covers common workflows — health check, session management, streaming prompts, file reads, git status/diff, event subscriptions, agents, skills, config, PTY, MCP, questions, and permissions — with fetch examples for the webview/extension host context.
---

# opencode Serve API — `http://localhost:4096`

## Transport basics

| Transport | When used |
|---|---|
| HTTP REST | All endpoints |
| SSE (`text/event-stream`) | `/event`, `/global/event`, `/session/{id}/message` (streaming prompt response) |
| WebSocket | `/pty/{id}/connect` (terminal I/O) |

The server listens on `localhost:4096` by default. The port is configurable; read it from the VS Code extension's config rather than hardcoding.

---

## Workflow 1 — Health check

Confirm `opencode serve` is reachable before making other calls.

```ts
const res = await fetch("http://localhost:4096/global/health");
// 200 OK → { ok: true, version: "x.y.z" }
```

---

## Workflow 2 — List and create sessions

```ts
// List all sessions
const sessions = await fetch("http://localhost:4096/session").then(r => r.json());

// Create a new session (projectID is optional)
const session = await fetch("http://localhost:4096/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ projectID: "my-project" }),
}).then(r => r.json());
// → { id: "sess_...", ... }
```

---

## Workflow 3 — Send a prompt and stream the response

The message endpoint returns a **Server-Sent Events** stream. Each event is a
JSON object; the `type` field discriminates between content chunks, tool calls,
and completion signals.

```ts
async function streamPrompt(sessionID: string, text: string) {
  const res = await fetch(`http://localhost:4096/session/${sessionID}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are separated by "\n\n"
    const frames = buf.split("\n\n");
    buf = frames.pop()!; // keep incomplete frame

    for (const frame of frames) {
      const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());
      handleEvent(event);
    }
  }
}

function handleEvent(event: { type: string; [k: string]: unknown }) {
  switch (event.type) {
    case "assistant":   // text content chunk
    case "tool":        // tool call / result
    case "step":        // step boundary
    case "message.completed":  // message fully done
    case "session.idle":       // agent loop returned to idle
      break;
  }
}
```

### Async variant (fire-and-forget)

```ts
await fetch(`http://localhost:4096/session/${sessionID}/prompt_async`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "..." }] }),
});
// Poll /event or /session/{id} for completion
```

---

## Workflow 4 — Subscribe to session or global events (SSE)

Use this to reactively update the UI without polling.

```ts
// Session-scoped events
const es = new EventSource(`http://localhost:4096/event`);
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  // event.type: "session.updated" | "session.idle" | "message.updated" | ...
};

// Global events (config changes, upgrades, dispose)
const globalEs = new EventSource("http://localhost:4096/global/event");
```

---

## Workflow 5 — Read a file / list a directory

```ts
// List directory entries
const entries = await fetch(
  `http://localhost:4096/file?path=${encodeURIComponent("/abs/path/to/dir")}`
).then(r => r.json());
// → [{ name: "foo.ts", type: "file" | "directory" }, ...]

// Read file content
const { content } = await fetch(
  `http://localhost:4096/file/content?path=${encodeURIComponent("/abs/path/to/file.ts")}`
).then(r => r.json());
```

---

## Workflow 6 — Git status and diff

```ts
// Branch + uncommitted file list
const status = await fetch("http://localhost:4096/vcs/status").then(r => r.json());
// → { branch: "main", files: [{ path: "src/foo.ts", status: "M" }, ...] }

// Structured diff
const diff = await fetch("http://localhost:4096/vcs/diff").then(r => r.json());

// Raw patch string
const { patch } = await fetch("http://localhost:4096/vcs/diff/raw").then(r => r.json());

// Apply a patch
await fetch("http://localhost:4096/vcs/apply", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ patch }),
});
```

---

## Workflow 7 — Get config, list agents and skills

```ts
// Instance config
const config = await fetch("http://localhost:4096/config").then(r => r.json());

// Available AI providers + default models
const providers = await fetch("http://localhost:4096/config/providers").then(r => r.json());

// Available agents
const agents = await fetch("http://localhost:4096/agent").then(r => r.json());

// Available skills
const skills = await fetch("http://localhost:4096/skill").then(r => r.json());
```

---

## Workflow 8 — Abort a running session

```ts
await fetch(`http://localhost:4096/session/${sessionID}/abort`, { method: "POST" });
```

---

## Workflow 9 — Answer a pending question / approve a permission

The AI can pause and ask the user a question or request permission to run a tool.
Poll or subscribe via SSE, then reply:

```ts
// List pending questions
const questions = await fetch("http://localhost:4096/question").then(r => r.json());

// Reply to a question
await fetch(`http://localhost:4096/question/${requestID}/reply`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ answer: "yes" }),
});

// List pending permission requests
const permissions = await fetch("http://localhost:4096/permission").then(r => r.json());

// Approve / deny a permission
await fetch(`http://localhost:4096/permission/${requestID}/reply`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "allow" }), // or "deny"
});
```

---

## Workflow 10 — PTY (embedded terminal)

```ts
// List available shells
const shells = await fetch("http://localhost:4096/pty/shells").then(r => r.json());

// Create a PTY session
const pty = await fetch("http://localhost:4096/pty", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ shell: "/bin/zsh", cols: 120, rows: 40 }),
}).then(r => r.json());

// Get a short-lived WebSocket connect token
const { token } = await fetch(`http://localhost:4096/pty/${pty.id}/connect-token`, {
  method: "POST",
}).then(r => r.json());

// Connect via WebSocket (upgrade endpoint)
const ws = new WebSocket(`ws://localhost:4096/pty/${pty.id}/connect?token=${token}`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => { /* raw terminal output bytes */ };
ws.send(new TextEncoder().encode("ls\r")); // send keystrokes
```

---

## Condensed endpoint reference

### System

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/global/health` | Health check + version |
| `GET` | `/global/event` | SSE: global system events |
| `GET` | `/global/config` | Read global config |
| `PATCH` | `/global/config` | Update global config |
| `POST` | `/global/dispose` | Dispose all instances |
| `POST` | `/global/upgrade` | Upgrade opencode |
| `GET` | `/event` | SSE: instance-scoped events |
| `GET` | `/config` | Read instance config |
| `PATCH` | `/config` | Update instance config |
| `GET` | `/config/providers` | List providers + default models |
| `GET` | `/path` | Working directory + paths |

### Files & search

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/file` | List directory entries (`?path=`) |
| `GET` | `/file/content` | Read file content (`?path=`) |
| `GET` | `/file/status` | Git status of a file |
| `GET` | `/find` | Ripgrep text search |
| `GET` | `/find/file` | Find files by name/pattern |
| `GET` | `/find/symbol` | LSP symbol search |

### VCS

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/vcs` | Branch info |
| `GET` | `/vcs/status` | Branch + uncommitted files |
| `GET` | `/vcs/diff` | Structured diff |
| `GET` | `/vcs/diff/raw` | Raw patch |
| `POST` | `/vcs/apply` | Apply a raw patch |

### Sessions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/session` | List sessions |
| `POST` | `/session` | Create session |
| `GET` | `/session/status` | Active/idle status of all sessions |
| `GET` | `/session/{id}` | Get session detail |
| `PATCH` | `/session/{id}` | Update session metadata |
| `DELETE` | `/session/{id}` | Delete session |
| `GET` | `/session/{id}/children` | Forked child sessions |
| `GET` | `/session/{id}/todo` | Session tasks/todos |
| `GET` | `/session/{id}/diff` | File changes for a specific message |
| `POST` | `/session/{id}/fork` | Fork from a message point |
| `POST` | `/session/{id}/abort` | Stop ongoing processing |
| `POST` | `/session/{id}/init` | Generate AGENTS.md |
| `POST` | `/session/{id}/share` | Create shareable link |
| `DELETE` | `/session/{id}/share` | Remove shareable link |
| `POST` | `/session/{id}/summarize` | Compact session |
| `POST` | `/session/{id}/revert` | Revert message effects |
| `POST` | `/session/{id}/unrevert` | Undo a revert |

### Messages

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/session/{id}/message` | List messages |
| `POST` | `/session/{id}/message` | Send prompt (SSE stream) |
| `GET` | `/session/{id}/message/{msgID}` | Get single message |
| `DELETE` | `/session/{id}/message/{msgID}` | Delete message |
| `POST` | `/session/{id}/prompt_async` | Send prompt asynchronously |
| `POST` | `/session/{id}/command` | Execute a named command |
| `POST` | `/session/{id}/shell` | Run a shell command |
| `DELETE` | `/session/{id}/message/{msgID}/part/{partID}` | Remove message part |
| `PATCH` | `/session/{id}/message/{msgID}/part/{partID}` | Edit message part |
| `POST` | `/session/{id}/permissions/{permID}` | Approve/deny tool permission |

### Agents, skills, commands

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agent` | List agents |
| `GET` | `/skill` | List skills |
| `GET` | `/command` | List commands |

### Providers & auth

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/provider` | List all providers |
| `GET` | `/provider/auth` | Auth methods |
| `PUT` | `/auth/{providerID}` | Set auth credentials |
| `DELETE` | `/auth/{providerID}` | Remove auth credentials |
| `POST` | `/provider/{providerID}/oauth/authorize` | Start OAuth |
| `POST` | `/provider/{providerID}/oauth/callback` | OAuth callback |

### Questions & permissions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/question` | List pending questions |
| `POST` | `/question/{id}/reply` | Answer a question |
| `POST` | `/question/{id}/reject` | Reject a question |
| `GET` | `/permission` | List pending permissions |
| `POST` | `/permission/{id}/reply` | Approve/deny a permission |

### PTY

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/pty/shells` | List available shells |
| `GET` | `/pty` | List PTY sessions |
| `POST` | `/pty` | Create PTY session |
| `GET` | `/pty/{id}` | Get PTY detail |
| `PUT` | `/pty/{id}` | Resize PTY (cols/rows) |
| `DELETE` | `/pty/{id}` | Close PTY |
| `POST` | `/pty/{id}/connect-token` | Get short-lived WS ticket |
| `GET` | `/pty/{id}/connect` | WebSocket upgrade (terminal I/O) |

### MCP

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp` | MCP server status |
| `POST` | `/mcp` | Add MCP server dynamically |
| `POST` | `/mcp/{name}/connect` | Connect MCP server |
| `POST` | `/mcp/{name}/disconnect` | Disconnect MCP server |
| `POST` | `/mcp/{name}/auth` | Start MCP OAuth |
| `DELETE` | `/mcp/{name}/auth` | Remove MCP OAuth |

### V2 API (newer session/model format)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/session` | List sessions (paginated) |
| `POST` | `/api/session/{id}/prompt` | Queue prompt for agent loop |
| `POST` | `/api/session/{id}/compact` | Compact conversation |
| `POST` | `/api/session/{id}/wait` | Wait until agent loop is idle |
| `GET` | `/api/session/{id}/context` | Active messages since last compaction |
| `GET` | `/api/session/{id}/message` | Paginated messages |
| `GET` | `/api/model` | List models (ordered by release) |
| `GET` | `/api/provider` | List V2 providers |
| `GET` | `/api/provider/{id}` | Get V2 provider detail |

### Experimental

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/experimental/worktree` | Manage git worktrees (sandboxes) |
| `POST` | `/experimental/worktree/reset` | Reset a worktree branch |
| `GET/POST` | `/experimental/workspace` | Manage workspaces |
| `GET` | `/experimental/workspace/status` | Workspace connection status |
| `DELETE` | `/experimental/workspace/{id}` | Remove workspace |
| `POST` | `/experimental/workspace/warp` | Move session between workspaces |
| `GET` | `/experimental/tool` | List tools for a provider/model |
| `GET` | `/experimental/tool/ids` | List tool IDs |
| `GET` | `/experimental/console` | Console account info |

### TUI control

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tui/append-prompt` | Append text to TUI prompt |
| `POST` | `/tui/submit-prompt` | Submit current TUI prompt |
| `POST` | `/tui/clear-prompt` | Clear TUI prompt |
| `POST` | `/tui/execute-command` | Run a TUI command |
| `POST` | `/tui/show-toast` | Display a toast notification |
| `POST` | `/tui/open-help` | Open help dialogue |
| `POST` | `/tui/open-sessions` | Open sessions panel |
| `POST` | `/tui/open-themes` | Open themes panel |
| `POST` | `/tui/open-models` | Open models panel |
| `POST` | `/tui/select-session` | Switch active session |
| `POST` | `/tui/publish` | Publish an event to TUI |
| `GET` | `/tui/control/next` | Poll for next TUI control event |
| `POST` | `/tui/control/response` | Respond to a TUI control event |

### Project

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/project` | List projects |
| `GET` | `/project/current` | Active project |
| `POST` | `/project/git/init` | Init git for project |
| `PATCH` | `/project/{id}` | Update project (name, icon, startup) |

### LSP & formatter

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/lsp` | LSP server status |
| `GET` | `/formatter` | Formatter status |
