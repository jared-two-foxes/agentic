import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { OpenCodeClient } from "../client/api";
import type { Agent, Model, CurrentSelection, SessionMessageItem, EventSessionCreated, OpenCodeEvent } from "../client/api";
import { ServerManager, ServerStatus } from "../server";

/** Shape persisted to workspaceState so chips can be shown before the server is ready. */
interface CachedContext {
  agents: Array<{ name: string; description?: string; model?: { modelID: string; providerID: string } }>;
  models: Array<{ id: string; providerID: string; name: string; hasVariants: boolean; variants: string[] }>;
  current: CurrentSelection;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencode.chatView";
  public static readonly maximizeCommand = "opencode.maximizeChat";

  private _unsubscribe: (() => void) | undefined;
  private _childUnsubscribes = new Map<string, () => void>();
  private _sessionPromise: Promise<string> | undefined;
  private _currentView: vscode.WebviewView | undefined;
  private _lastStatus: ServerStatus = { value: "connecting" };
  private _agents: Agent[] = [];
  private _models: Model[] = [];
  private _selection: CurrentSelection = {};
  private _api: OpenCodeClient | undefined;
  private _editorPanel: vscode.WebviewPanel | undefined;
  private _editorDisposables: vscode.Disposable[] = [];

  private static readonly SESSION_KEY = "opencode.sessionId";
  private static readonly AGENT_KEY   = "opencode.agentSelection";
  private static readonly MODEL_KEY   = "opencode.modelSelection";
  private static readonly CONTEXT_KEY = "opencode.context";

  /** Returns a workspaceState key scoped to the current workspace root, preventing cross-project bleed. */
  private _sessionKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.SESSION_KEY}:${this._normPath(root)}`
      : ChatPanel.SESSION_KEY;
  }

  /** Returns a workspaceState key for persisting agent selection, scoped per workspace. */
  private _agentKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.AGENT_KEY}:${this._normPath(root)}`
      : ChatPanel.AGENT_KEY;
  }

  /** Returns a workspaceState key for persisting the last-known context payload, scoped per workspace. */
  private _contextKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.CONTEXT_KEY}:${this._normPath(root)}`
      : ChatPanel.CONTEXT_KEY;
  }

  /** Returns a workspaceState key for persisting model/variant selection, scoped per workspace. */
  private _modelKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.MODEL_KEY}:${this._normPath(root)}`
      : ChatPanel.MODEL_KEY;
  }

  /** Persist the current agent selection to workspaceState. */
  private _saveAgentSelection(): void {
    this._context.workspaceState.update(this._agentKey(), this._selection.agent ?? null);
  }

  /** Restore a previously saved agent selection into _selection (before context is posted). */
  private _restoreAgentSelection(): void {
    const saved = this._context.workspaceState.get<string>(this._agentKey());
    if (saved && !this._selection.agent) {
      this._selection.agent = saved;
    }
  }

  /** Persist the current model/variant selection to workspaceState. */
  private _saveModelSelection(): void {
    this._context.workspaceState.update(this._modelKey(), {
      modelId: this._selection.modelId ?? null,
      providerID: this._selection.providerID ?? null,
      variant: this._selection.variant ?? null,
    });
  }

  /** Restore a previously saved model/variant selection into _selection (only if no model is already set). */
  private _restoreModelSelection(): void {
    const saved = this._context.workspaceState.get<{ modelId?: string; providerID?: string; variant?: string }>(this._modelKey());
    if (saved && !this._selection.modelId) {
      if (saved.modelId) { this._selection.modelId = saved.modelId; }
      if (saved.providerID) { this._selection.providerID = saved.providerID; }
      if (saved.variant) { this._selection.variant = saved.variant; }
    }
  }

  /** Update only the `current` field of the stored CachedContext to reflect the latest _selection.
   *  Called after mid-session model/variant changes so the stale chips on the next open are correct. */
  private _updateCachedContextSelection(): void {
    const cached = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (cached) {
      this._context.workspaceState.update(this._contextKey(), { ...cached, current: { ...this._selection } });
    }
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly serverManager: ServerManager,
    private readonly secrets: vscode.SecretStorage,
    private readonly _context: vscode.ExtensionContext
  ) {}

  /** Called by extension.ts when server status changes */
  notifyStatus(status: ServerStatus): void {
    this._lastStatus = status;
    this._broadcast({ type: "status", ...status });
    if (status.value === "ready" && this._currentView) {
      this._fetchAndPostContext(this._currentView.webview);
    }
  }

  private _getOrCreateSession(api: OpenCodeClient): Promise<string> {
    if (!this._sessionPromise) {
      const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      this._sessionPromise = api.createSession(this._selection, directory).then((id) => {
        this._context.workspaceState.update(this._sessionKey(), id);
        // Push a fresh session list so the picker reflects the new session immediately.
        this._pushSessionList(id).catch(() => {});
        return id;
      }).catch((err) => {
        this._sessionPromise = undefined;
        throw err;
      });
    }
    return this._sessionPromise;
  }

  /** Fetch the session list for the current workspace and post it to the webview. */
  private async _pushSessionList(activeId: string | null): Promise<void> {
    if (!this._api) return;
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessions = await this._api.listSessions(workspaceRoot);
      // Always include the active session even if the server omitted it
      let result = sessions;
      if (activeId && !result.find(s => s.id === activeId)) {
        const all = await this._api.listSessions();
        const active = all.find(s => s.id === activeId);
        if (active) result = [active, ...result];
      }
      result.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      this._broadcast({ type: "sessionList", sessions: result, activeId });
    } catch {
      this._broadcast({ type: "sessionList", sessions: [], activeId });
    }
  }

  private async _fetchAndPostContext(webview: vscode.Webview, attemptRestore = true): Promise<void> {
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
      // Restore persisted agent selection if nothing is set from config
      this._restoreAgentSelection();
      // Restore persisted model/variant selection (takes priority over agent default and config default)
      this._restoreModelSelection();
      // If the (restored) agent has a model preference, apply it when no model is explicitly set
      if (this._selection.agent && !this._selection.modelId) {
        const agentDef = this._agents.find(a => a.name === this._selection.agent);
        if (agentDef?.model) {
          current.modelId = agentDef.model.modelID;
          current.providerID = agentDef.model.providerID;
        }
      }
      if (!this._selection.modelId) {
        this._selection.modelId = current.modelId;
        this._selection.providerID = current.providerID;
      }

      const payload: CachedContext = {
        agents: this._agents.map(a => ({ name: a.name, description: a.description, model: a.model })),
        models: models.map(m => ({
          id: m.id,
          providerID: m.providerID,
          name: m.name,
          hasVariants: !!(m.variants && Object.keys(m.variants).length > 0),
          variants: m.variants ? Object.keys(m.variants) : [],
        })),
        current: { ...this._selection },
      };
      webview.postMessage({ type: "context", ...payload });
      // Persist so the next panel open can show chips immediately (before server is ready).
      this._context.workspaceState.update(this._contextKey(), payload);

      if (attemptRestore && !this._sessionPromise) {
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
      const reasoningParts = parts.filter(p => p.type === "reasoning" && typeof p.text === "string");
      // TODO: restore subtask history — child sessions have their own message history and are not surfaced here
      if (info.role === "user") {
        const text = textParts.map(p => p.text ?? "").join("").trim();
        if (!text) continue;
        result.push({ kind: "user", id: uid(), serverId: info.id, text });
      } else if (info.role === "assistant") {
        const allParts: unknown[] = [
          ...reasoningParts.map(p => ({ type: "reasoning", partID: p.id, text: p.text ?? "", done: true })),
          ...textParts.map(p => ({ type: "text", partID: p.id, text: p.text ?? "" })),
        ];
        if (allParts.length === 0) continue;
        result.push({ kind: "assistant", id: uid(), parts: allParts });
      }
    }
    return result;
  }

  /** Normalise a filesystem path for comparison: lowercase on Windows, strip trailing separator */
  private _normPath(p: string): string {
    let s = p.replace(/[\\/]+$/, ""); // strip trailing slashes
    if (process.platform === "win32") s = s.toLowerCase();
    return s;
  }

  /** Try to re-attach to the last session for this workspace. Returns true if restored. */
  private async _tryRestoreSession(webview: vscode.Webview): Promise<boolean> {
    if (!this._api) return false;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Set a sentinel immediately — before any await — so concurrent calls
    // to _fetchAndPostContext see a non-null _sessionPromise and bail out.
    // We replace it with the real resolved value (or clear it) below.
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    this._sessionPromise = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    // Suppress unhandled-rejection noise during the async window
    this._sessionPromise.catch(() => {});

    try {
      const sessions = await this._api.listSessions(workspaceRoot);

      // 1. Prefer the session key scoped to this workspace root.
      const stateKey = this._sessionKey();
      const savedId = this._context.workspaceState.get<string>(stateKey);
      let target = savedId ? sessions.find(s => s.id === savedId) : undefined;

      // 2. Fall back to the most-recently-updated session for this workspace.
      if (!target && sessions.length > 0) {
        target = sessions.slice().sort(
          (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        )[0];
      }

      if (!target) {
        // Nothing to restore — clear the sentinel so the next send creates fresh.
        this._sessionPromise = undefined;
        rejectId(new Error("no session"));
        return false;
      }

      // Persist the resolved session ID under the scoped key.
      this._context.workspaceState.update(stateKey, target.id);
      resolveId(target.id);

      // Fetch history (capped at 50 messages).
      const history = await this._api.getSessionMessages(target.id, 50);
      const messages = this._mapToWebviewMessages(history);

      webview.postMessage({
        type: "sessionRestored",
        messages,
        current: { ...this._selection },
      });

      return true;
    } catch {
      // Non-fatal — clear sentinel so next send can create a fresh session.
      this._sessionPromise = undefined;
      rejectId(new Error("restore failed"));
      return false;
    }
  }

  /** Called by opencode.newSession command to clear state and reset the UI */
  resetSession(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._tearDownChildSubs();
    this._sessionPromise = undefined;
    this._selection = {};
    this._context.workspaceState.update(this._sessionKey(), undefined);
    this._broadcast({ type: "newSession" });
    // Re-post current status immediately so the webview doesn't stay stuck
    // on "connecting" — the server is already up, notifyStatus won't fire again.
    this._broadcast({ type: "status", ...this._lastStatus });
    if (this._lastStatus.value === "ready" && this._currentView) {
      this._fetchAndPostContext(this._currentView.webview, false);
    }
  }

  /** Unsubscribe from all active child session SSE streams. */
  private _tearDownChildSubs(): void {
    for (const unsub of this._childUnsubscribes.values()) {
      unsub();
    }
    this._childUnsubscribes.clear();
  }

  /** Returns an event handler for a parent session that detects child session spawns,
   *  subscribes to their SSE streams, and broadcasts all events to the webview. */
  private _makeParentEventHandler(
    _sessionId: string,
    apiClient: OpenCodeClient
  ): (event: OpenCodeEvent) => void {
    return (event) => {
      if (event.type === "session.created") {
        const created = event as EventSessionCreated;
        const childId = created.properties?.sessionID;
        const MAX_CHILD_SESSIONS = 10;
        if (childId && !this._childUnsubscribes.has(childId) && this._childUnsubscribes.size < MAX_CHILD_SESSIONS) {
          const { unsubscribe: childUnsub } = apiClient.subscribeEvents(
            childId,
            (childEvent) => {
              // Prune on child idle before deciding whether to forward
              if (childEvent.type === "session.idle") {
                const unsub = this._childUnsubscribes.get(childId);
                if (unsub) {
                  unsub();
                  this._childUnsubscribes.delete(childId);
                }
                // Do NOT broadcast child idle — it would set isThinking=false in the parent webview
                return;
              }
              // Suppress child session lifecycle events that have no meaning in the parent UI context
              if (childEvent.type === "session.status") {
                return;
              }
              this._broadcast(childEvent);
            }
          );
          this._childUnsubscribes.set(childId, childUnsub);
        }
      }
      this._broadcast(event);
    };
  }

  /**
   * Open the chat in an editor-tab WebviewPanel beside the active editor.
   * If a panel is already open, reveal it. Closes the sidebar automatically.
   * NOTE: workbench.action.closeSidebar hides the entire sidebar, not just
   * the opencode view.
   */
  public maximize(): void {
    // If already open, just reveal it.
    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    // Dispose any stale disposables from a previous panel.
    this._editorDisposables.forEach(d => d.dispose());
    this._editorDisposables = [];

    this._editorPanel = vscode.window.createWebviewPanel(
      "opencode.chatEditor",
      "opencode",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
      }
    );

    // Capture panel reference to avoid unsafe closure over mutable field.
    const panel = this._editorPanel;
    panel.webview.html = this._getHtml(panel.webview);

    // Wire incoming messages from the editor panel through the shared handler.
    this._editorDisposables.push(
      panel.webview.onDidReceiveMessage(
        (msg) => this._handleMessage(panel.webview, msg)
      )
    );

    // When the editor panel is closed, restore the sidebar.
    this._editorDisposables.push(
      panel.onDidDispose(() => {
        this._editorDisposables.forEach(d => d.dispose());
        this._editorDisposables = [];
        this._editorPanel = undefined;
        vscode.commands.executeCommand("opencode.chatView.focus");
      })
    );

    // Bootstrap: send current server status immediately.
    panel.webview.postMessage({ type: "status", ...this._lastStatus });

    // Bootstrap: send any cached context (agents/models/current selection).
    const stale = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (stale) {
      panel.webview.postMessage({ type: "context", ...stale });
    }

    // Bootstrap: restore session history if a session is already active.
    if (this._sessionPromise && this._api) {
      this._sessionPromise
        .then(async (sessionId) => {
          const history = await this._api!.getSessionMessages(sessionId, 50);
          const messages = this._mapToWebviewMessages(history);
          panel.webview.postMessage({
            type: "sessionRestored",
            messages,
            current: { ...this._selection },
          });
        })
        .catch(() => { /* non-fatal — panel will just start empty */ });
    }

    // Ensure _api is initialized even if the sidebar was never resolved.
    if (!this._api) {
      const config = vscode.workspace.getConfiguration("opencode");
      const editorPort: number = config.get("port") ?? 4096;
      this.secrets.get("opencode.password").then((pw) => {
        this._api = new OpenCodeClient(`http://localhost:${editorPort}`, pw ?? "");
        if (this._lastStatus.value === "ready" && !this._sessionPromise && panel.webview) {
          this._fetchAndPostContext(panel.webview);
        }
      });
    }

    // Auto-hide the sidebar (closes the entire sidebar panel).
    vscode.commands.executeCommand("workbench.action.closeSidebar");
  }

  /**
   * Close the editor-tab panel and restore the sidebar.
   * Called by the opencode.minimizeChat command.
   */
  public minimize(): void {
    this._editorPanel?.dispose();
  }

  /** Post a message to all active webviews (sidebar and editor panel). */
  private _broadcast(message: unknown): void {
    this._currentView?.webview.postMessage(message);
    this._editorPanel?.webview.postMessage(message);
  }

  private async _handleMessage(
    webview: vscode.Webview,
    msg: { type: string; text?: string; requestID?: string; answers?: unknown; reply?: string; message?: string; sessionId?: string; title?: string; editMessageId?: string }
  ): Promise<void> {
    const port: number = vscode.workspace.getConfiguration("opencode").get("port") ?? 4096;

    if (msg.type === 'abort') {
      if (this._api) {
        const sessionId = await this._sessionPromise?.catch(() => undefined);
        if (sessionId) {
          this._api.abort(sessionId).catch(() => {/* ignore */});
        }
      }
      return;
    }

    if (msg.type === "getStatus") {
      this._broadcast({ type: "status", ...this._lastStatus });
      if (this._lastStatus.value === "ready" && !this._sessionPromise) {
        this._fetchAndPostContext(webview);
      }
      return;
    }

    if (msg.type === "newSession") {
      this.resetSession();
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
        this._saveAgentSelection();
        const update: Record<string, unknown> = { type: "contextUpdate", agent: picked.label };
        // If the agent has a model preference, switch to it automatically
        const agentDef = this._agents.find(a => a.name === picked.label);
        if (agentDef?.model) {
          this._selection.modelId = agentDef.model.modelID;
          this._selection.providerID = agentDef.model.providerID;
          update.modelId = agentDef.model.modelID;
          update.providerID = agentDef.model.providerID;
          const modelDef = this._models.find(
            m => m.id === agentDef.model!.modelID && m.providerID === agentDef.model!.providerID
          );
          update.modelName = modelDef?.name ?? agentDef.model.modelID;
        }
        this._broadcast(update);
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
        this._saveModelSelection();
        this._updateCachedContextSelection();
        // Reset session so next send uses the new model
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._sessionPromise = undefined;
        this._broadcast({
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
        this._saveModelSelection();
        this._updateCachedContextSelection();
        // Reset session so next send uses the new variant
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._sessionPromise = undefined;
        this._broadcast({ type: "contextUpdate", variant: picked });
      }
      return;
    }

    if (msg.type === "fetchSessions") {
      if (!this._api) return;
      const activeId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(activeId ?? null);
      return;
    }

    if (msg.type === "switchSession") {
      if (!this._api || !msg.sessionId) return;
      // Tear down current session without clearing the stored key yet
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      this._tearDownChildSubs();
      this._sessionPromise = undefined;
      this._selection = {};
      // Persist the requested session as the active one
      this._context.workspaceState.update(this._sessionKey(), msg.sessionId);
      // Re-subscribe to events for the new session
      const { ready, unsubscribe } = this._api.subscribeEvents(
        msg.sessionId,
        this._makeParentEventHandler(msg.sessionId, this._api),
        () => { this._unsubscribe = undefined; }
      );
      this._unsubscribe = unsubscribe;
      this._sessionPromise = Promise.resolve(msg.sessionId);
      try {
        await ready;
        const history = await this._api.getSessionMessages(msg.sessionId, 50);
        const messages = this._mapToWebviewMessages(history);
        this._broadcast({
          type: "sessionRestored",
          messages,
          current: { ...this._selection },
        });
      } catch {
        this._broadcast({ type: "status", value: "error", message: "Failed to switch session" });
      }
      return;
    }

    if (msg.type === "deleteSession") {
      if (!this._api || !msg.sessionId) return;
      try {
        await this._api.deleteSession(msg.sessionId);
        // If we deleted the active session, reset to a blank slate
        const activeId = await this._sessionPromise?.catch(() => undefined);
        if (activeId === msg.sessionId) {
          this.resetSession();
        }
      } catch { /* ignore */ }
      const newActiveId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(newActiveId ?? null);
      return;
    }

    if (msg.type === "renameSession") {
      if (!this._api || !msg.sessionId || !msg.title) return;
      try {
        await this._api.updateSession(msg.sessionId, msg.title);
      } catch { /* ignore */ }
      const activeId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(activeId ?? null);
      return;
    }

    if (msg.type === "forkSession") {
      if (!this._api || !msg.sessionId) return;
      try {
        const newId = await this._api.forkSession(msg.sessionId);
        // Switch to the forked session
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._tearDownChildSubs();
        this._sessionPromise = undefined;
        this._selection = {};
        this._context.workspaceState.update(this._sessionKey(), newId);
        const { ready, unsubscribe } = this._api.subscribeEvents(
          newId,
          this._makeParentEventHandler(newId, this._api),
          () => { this._unsubscribe = undefined; }
        );
        this._unsubscribe = unsubscribe;
        this._sessionPromise = Promise.resolve(newId);
        await ready;
        const history = await this._api.getSessionMessages(newId, 50);
        const messages = this._mapToWebviewMessages(history);
        this._broadcast({
          type: "sessionRestored",
          messages,
          current: { ...this._selection },
        });
        await this._pushSessionList(newId);
      } catch {
        this._broadcast({ type: "status", value: "error", message: "Failed to fork session" });
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

    if (msg.type !== "send" && msg.type !== "editMessage") return;
    if (!msg.text) return;

    try {
      const password = await this.secrets.get("opencode.password") ?? "";
      const api = new OpenCodeClient(`http://localhost:${port}`, password);

      const sessionId = await this._getOrCreateSession(api);

      // Subscribe once per session, await stream open before sending
      if (!this._unsubscribe) {
        const { ready, unsubscribe } = api.subscribeEvents(
          sessionId,
          this._makeParentEventHandler(sessionId, api),
          (err) => {
            this._unsubscribe = undefined;
            this._broadcast({
              type: "status",
              value: "error",
              message: err.message,
            });
          }
        );
        this._unsubscribe = unsubscribe;
        await ready;
      }

      if (msg.type === "editMessage" && msg.editMessageId) {
        await api.revertSession(sessionId, msg.editMessageId);
      }

      await api.sendMessage(sessionId, msg.text, this._selection.agent);
    } catch (err: unknown) {
      // Clear dead session so the next send starts fresh
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      this._sessionPromise = undefined;
      const message = err instanceof Error ? err.message : String(err);
      this._broadcast({ type: "status", value: "error", message });
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

    // Post any previously cached context immediately so chips render without waiting for the server.
    const stale = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (stale) {
      webviewView.webview.postMessage({ type: "context", ...stale });
    }

    // Create an authenticated client for context fetching (same auth as send)
    // Password is read lazily so we recreate _api when the view resolves.
    // We store a reference so _fetchAndPostContext can use it.
    this.secrets.get("opencode.password").then((pw) => {
      const port: number = vscode.workspace.getConfiguration("opencode").get("port") ?? 4096;
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
    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(webviewView.webview, msg),
      undefined,
      []
    );

    // Clean up when the view is disposed/hidden
    webviewView.onDidDispose(() => {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      this._tearDownChildSubs();
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
