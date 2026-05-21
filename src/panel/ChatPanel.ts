import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { OpenCodeClient } from "../client/api";
import type { Agent, Model, CurrentSelection, SessionMessageItem } from "../client/api";
import { ServerManager, ServerStatus } from "../server";

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencode.chatView";

  private _unsubscribe: (() => void) | undefined;
  private _sessionPromise: Promise<string> | undefined;
  private _currentView: vscode.WebviewView | undefined;
  private _lastStatus: ServerStatus = { value: "connecting" };
  private _agents: Agent[] = [];
  private _models: Model[] = [];
  private _selection: CurrentSelection = {};
  private _api: OpenCodeClient | undefined;

  private static readonly SESSION_KEY = "opencode.sessionId";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly serverManager: ServerManager,
    private readonly secrets: vscode.SecretStorage,
    private readonly _context: vscode.ExtensionContext
  ) {}

  /** Called by extension.ts when server status changes */
  notifyStatus(status: ServerStatus): void {
    this._lastStatus = status;
    if (this._currentView) {
      this._currentView.webview.postMessage({ type: "status", ...status });
    }
    if (status.value === "ready" && this._currentView) {
      this._fetchAndPostContext(this._currentView.webview);
    }
  }

  private _getOrCreateSession(api: OpenCodeClient): Promise<string> {
    if (!this._sessionPromise) {
      this._sessionPromise = api.createSession(this._selection).then((id) => {
        this._context.workspaceState.update(ChatPanel.SESSION_KEY, id);
        return id;
      }).catch((err) => {
        this._sessionPromise = undefined;
        throw err;
      });
    }
    return this._sessionPromise;
  }

  private async _fetchAndPostContext(webview: vscode.Webview): Promise<void> {
    if (!this._api) return;
    try {
      const [agents, models, config] = await Promise.all([
        this._api.listAgents(),
        this._api.listModels(),
        this._api.getConfig(),
      ]);
      this._agents = agents.filter(a => a.mode !== "subagent" && !a.hidden);
      this._models = models;

      const current: CurrentSelection = {};
      if (config.default_agent) current.agent = config.default_agent;
      if (config.model) {
        const parts = config.model.split("/");
        if (parts.length >= 2) {
          current.providerID = parts[0];
          current.modelId = parts.slice(1).join("/");
        } else {
          current.modelId = config.model;
        }
      }
      if (!this._selection.agent) this._selection.agent = current.agent;
      if (!this._selection.modelId) {
        this._selection.modelId = current.modelId;
        this._selection.providerID = current.providerID;
      }

      webview.postMessage({
        type: "context",
        agents: this._agents.map(a => ({ name: a.name, description: a.description })),
        models: models.map(m => ({
          id: m.id,
          providerID: m.providerID,
          name: m.name,
          hasVariants: !!(m.variants && Object.keys(m.variants).length > 0),
          variants: m.variants ? Object.keys(m.variants) : [],
        })),
        current: { ...this._selection },
      });

      // Attempt to restore the previous session (only when no session is active yet)
      if (!this._sessionPromise) {
        await this._tryRestoreSession(webview);
      }
    } catch {
      webview.postMessage({ type: "contextError", message: "Could not load agents/models" });
    }
  }

  /** Convert raw server message history to the shape the webview expects */
  private _mapToWebviewMessages(history: SessionMessageItem[]): unknown[] {
    let idCounter = 0;
    const uid = () => `r${++idCounter}`;

    const result: unknown[] = [];
    for (const item of history) {
      const { info, parts } = item;
      const textParts = parts.filter(p => p.type === "text" && typeof p.text === "string");
      if (info.role === "user") {
        const text = textParts.map(p => p.text ?? "").join("").trim();
        if (!text) continue;
        result.push({ kind: "user", id: uid(), text });
      } else if (info.role === "assistant") {
        if (textParts.length === 0) continue;
        result.push({
          kind: "assistant",
          id: uid(),
          parts: textParts.map(p => ({ type: "text", partID: p.id, text: p.text ?? "" })),
        });
      }
    }
    return result;
  }

  /** Try to re-attach to the last session for this workspace. Returns true if restored. */
  private async _tryRestoreSession(webview: vscode.Webview): Promise<boolean> {
    if (!this._api) return false;
    const savedId = this._context.workspaceState.get<string>(ChatPanel.SESSION_KEY);
    if (!savedId) return false;

    try {
      // Confirm the session still exists on the server
      const sessions = await this._api.listSessions();
      const session = sessions.find(s => s.id === savedId);
      if (!session) {
        this._context.workspaceState.update(ChatPanel.SESSION_KEY, undefined);
        return false;
      }

      // Workspace guard — reject sessions from a different directory
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot && session.directory !== workspaceRoot) {
        return false;
      }

      // Re-attach session promise so the next send goes to the same session
      this._sessionPromise = Promise.resolve(savedId);

      // Fetch history (capped at 50 messages)
      const history = await this._api.getSessionMessages(savedId, 50);
      const messages = this._mapToWebviewMessages(history);

      webview.postMessage({
        type: "sessionRestored",
        messages,
        current: { ...this._selection },
      });

      return true;
    } catch {
      // Non-fatal — fall through to a blank session
      return false;
    }
  }

  /** Called by opencode.newSession command to clear state and reset the UI */
  resetSession(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._sessionPromise = undefined;
    this._selection = {};
    this._context.workspaceState.update(ChatPanel.SESSION_KEY, undefined);
    if (this._currentView) {
      this._currentView.webview.postMessage({ type: "newSession" });
      if (this._lastStatus.value === "ready") {
        this._fetchAndPostContext(this._currentView.webview);
      }
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Only tear down if this is a genuinely new webview instance replacing a previous one.
    // Re-reveals of the same panel must not clear the session.
    const isNewInstance = this._currentView !== webviewView;
    if (isNewInstance) {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      this._sessionPromise = undefined;
    }

    this._currentView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };

    // Only inject HTML on a new instance — re-injecting destroys webview state.
    if (isNewInstance) {
      webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    // Post current server status immediately
    webviewView.webview.postMessage({ type: "status", ...this._lastStatus });

    // Read settings fresh each time the view is resolved
    const config = vscode.workspace.getConfiguration("opencode");
    const port: number = config.get("port") ?? 4096;

    // Create an authenticated client for context fetching (same auth as send)
    // Password is read lazily so we recreate _api when the view resolves.
    // We store a reference so _fetchAndPostContext can use it.
    this.secrets.get("opencode.password").then((pw) => {
      this._api = new OpenCodeClient(`http://localhost:${port}`, pw ?? "");
      if (this._lastStatus.value === "ready" && this._currentView && !this._sessionPromise) {
        this._fetchAndPostContext(this._currentView.webview);
      }
    });

    // Re-post context on reveal
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      if (this._lastStatus.value !== "ready") return;
      // If no session is active yet, fetch context (which will attempt restore).
      // If a session is already live, just re-send status so the input stays enabled.
      if (!this._sessionPromise) {
        this._fetchAndPostContext(webviewView.webview);
      } else {
        webviewView.webview.postMessage({ type: "status", ...this._lastStatus });
      }
    });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; requestID?: string; answers?: unknown; reply?: string; message?: string }) => {
      if (msg.type === "getStatus") {
        webviewView.webview.postMessage({ type: "status", ...this._lastStatus });
        if (this._lastStatus.value === "ready" && !this._sessionPromise) {
          this._fetchAndPostContext(webviewView.webview);
        }
        return;
      }

      if (msg.type === "pickAgent") {
        const items = this._agents.map(a => ({
          label: a.name,
          description: a.description ?? "",
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: "Select Agent",
          placeHolder: "Choose an agent for this session",
        });
        if (picked && picked.label !== this._selection.agent) {
          this._selection.agent = picked.label;
          // Reset session so next send uses the new agent
          this._unsubscribe?.();
          this._unsubscribe = undefined;
          this._sessionPromise = undefined;
          webviewView.webview.postMessage({ type: "contextUpdate", agent: picked.label });
        }
        return;
      }

      if (msg.type === "pickModel") {
        // Show only models with an explicit "active" status (or no status field).
        const activeOnly = (models: Model[]): Model[] =>
          models.filter(m => !m.status || m.status === "active");

        // Group models by providerID, inserting separators between groups
        const grouped = new Map<string, Model[]>();
        for (const m of activeOnly(this._models)) {
          const g = grouped.get(m.providerID) ?? [];
          g.push(m);
          g.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
          grouped.set(m.providerID, g);
        }
        type ModelItem = vscode.QuickPickItem & { _model?: Model };
        const items: ModelItem[] = [];
        for (const [providerID, providerModels] of grouped) {
          items.push({ label: providerID, kind: vscode.QuickPickItemKind.Separator } as ModelItem);
          for (const m of providerModels) {
            items.push({ label: m.name || m.id, _model: m });
          }
        }
        const picked = await vscode.window.showQuickPick(items, {
          title: "Select Model",
          placeHolder: "Choose a model for this session",
        });
        if (picked && picked._model && (picked._model.id !== this._selection.modelId || picked._model.providerID !== this._selection.providerID)) {
          this._selection.modelId = picked._model.id;
          this._selection.providerID = picked._model.providerID;
          this._selection.variant = undefined;
          // Reset session so next send uses the new model
          this._unsubscribe?.();
          this._unsubscribe = undefined;
          this._sessionPromise = undefined;
          webviewView.webview.postMessage({
            type: "contextUpdate",
            modelId: picked._model.id,
            providerID: picked._model.providerID,
            modelName: picked.label,
            variants: picked._model.variants ? Object.keys(picked._model.variants) : [],
          });
        }
        return;
      }

      if (msg.type === "pickVariant") {
        const model = this._models.find(
          m => m.id === this._selection.modelId && m.providerID === this._selection.providerID
        );
        const variantKeys = model?.variants ? Object.keys(model.variants) : [];
        if (variantKeys.length === 0) return;
        const picked = await vscode.window.showQuickPick(variantKeys, {
          title: "Select Variant",
          placeHolder: "Choose a model variant",
        });
        if (picked && picked !== this._selection.variant) {
          this._selection.variant = picked;
          // Reset session so next send uses the new variant
          this._unsubscribe?.();
          this._unsubscribe = undefined;
          this._sessionPromise = undefined;
          webviewView.webview.postMessage({ type: "contextUpdate", variant: picked });
        }
        return;
      }

      if (msg.type === "questionReply") {
        if (this._api && msg.requestID && Array.isArray(msg.answers)) {
          this._api.questionReply(msg.requestID as string, msg.answers as string[][]).catch(() => {/* ignore */});
        }
        return;
      }

      if (msg.type === "questionReject") {
        if (this._api && msg.requestID) {
          this._api.questionReject(msg.requestID as string).catch(() => {/* ignore */});
        }
        return;
      }

      if (msg.type === "permissionReply") {
        if (this._api && msg.requestID && msg.reply) {
          this._api
            .permissionReply(
              msg.requestID as string,
              msg.reply as "once" | "always" | "reject",
              typeof msg.message === "string" ? msg.message : undefined
            )
            .catch(() => {/* ignore */});
        }
        return;
      }

      if (msg.type !== "send" || !msg.text) return;

      try {
        const password = await this.secrets.get("opencode.password") ?? "";
        const api = new OpenCodeClient(`http://localhost:${port}`, password);

        const sessionId = await this._getOrCreateSession(api);

        // Subscribe once per session, await stream open before sending
        if (!this._unsubscribe) {
          const { ready, unsubscribe } = api.subscribeEvents(
            sessionId,
            (event) => {
              webviewView.webview.postMessage(event);
            },
            (err) => {
              // SSE stream error — surface to UI and clear subscription so
              // the next send attempt re-subscribes
              this._unsubscribe = undefined;
              webviewView.webview.postMessage({
                type: "status",
                value: "error",
                message: err.message,
              });
            }
          );
          this._unsubscribe = unsubscribe;
          // Wait until the stream is open before dispatching the message,
          // so no events are missed due to the race between GET /event and
          // POST /session/:id/message
          await ready;
        }

        await api.sendMessage(sessionId, msg.text);
      } catch (err: unknown) {
        // Clear dead session so the next send starts fresh
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._sessionPromise = undefined;
        const message = err instanceof Error ? err.message : String(err);
        webviewView.webview.postMessage({ type: "status", value: "error", message });
      }
    });

    // Clean up when the view is disposed/hidden
    webviewView.onDidDispose(() => {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      if (this._currentView === webviewView) {
        this._currentView = undefined;
      }
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const distWebviewUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const baseUri = webview.asWebviewUri(distWebviewUri).toString();
    const htmlPath = path.join(this.extensionUri.fsPath, "dist", "webview", "index.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    html = html.replace(/src="\.\//g, `src="${baseUri}/`);
    html = html.replace(/href="\.\//g, `href="${baseUri}/`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} https:`,
    ].join("; ");
    if (html.includes('http-equiv="Content-Security-Policy"')) {
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    } else {
      html = html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    }
    return html;
  }
}
