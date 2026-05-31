import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentEngine } from "../engine";
import type { EngineEvent } from "../tools/index";

/** Shape persisted to workspaceState so chips can be shown before engine is ready. */
interface CachedContext {
  agents: Array<{ name: string; description?: string; model?: { modelID: string; providerID: string } }>;
  models: Array<{ id: string; providerID: string; name: string; hasVariants: boolean; variants: string[] }>;
  current: CurrentSelection;
}

interface CurrentSelection {
  agent?: string;
  modelId?: string;
  providerID?: string;
  variant?: string;
}

interface AgentDef {
  name: string;
  description?: string;
  model?: { modelID: string; providerID: string };
}

interface ModelDef {
  id: string;
  providerID: string;
  name: string;
  status?: string;
  variants?: Record<string, unknown>;
}

type ServerStatus = { value: 'connecting' | 'ready' | 'error'; message?: string };

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencode.chatView";
  public static readonly maximizeCommand = "opencode.maximizeChat";

  private _sessionPromise: Promise<string> | undefined;
  private _currentView: vscode.WebviewView | undefined;
  private _lastStatus: ServerStatus = { value: "connecting" };
  private _agents: AgentDef[] = [];
  private _models: ModelDef[] = [];
  private _selection: CurrentSelection = {};
  private _editorPanel: vscode.WebviewPanel | undefined;
  private _editorDisposables: vscode.Disposable[] = [];
  private _engineSubscribed = false;

  private static readonly SESSION_KEY = "opencode.sessionId";
  private static readonly AGENT_KEY   = "opencode.agentSelection";
  private static readonly MODEL_KEY   = "opencode.modelSelection";
  private static readonly CONTEXT_KEY = "opencode.context";

  private _sessionKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.SESSION_KEY}:${this._normPath(root)}`
      : ChatPanel.SESSION_KEY;
  }

  private _agentKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.AGENT_KEY}:${this._normPath(root)}`
      : ChatPanel.AGENT_KEY;
  }

  private _contextKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.CONTEXT_KEY}:${this._normPath(root)}`
      : ChatPanel.CONTEXT_KEY;
  }

  private _modelKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? `${ChatPanel.MODEL_KEY}:${this._normPath(root)}`
      : ChatPanel.MODEL_KEY;
  }

  private _saveAgentSelection(): void {
    this._context.workspaceState.update(this._agentKey(), this._selection.agent ?? null);
  }

  private _restoreAgentSelection(): void {
    const saved = this._context.workspaceState.get<string>(this._agentKey());
    if (saved && !this._selection.agent) {
      this._selection.agent = saved;
    }
  }

  private _saveModelSelection(): void {
    this._context.workspaceState.update(this._modelKey(), {
      modelId: this._selection.modelId ?? null,
      providerID: this._selection.providerID ?? null,
      variant: this._selection.variant ?? null,
    });
  }

  private _restoreModelSelection(): void {
    const saved = this._context.workspaceState.get<{ modelId?: string; providerID?: string; variant?: string }>(this._modelKey());
    if (saved && !this._selection.modelId) {
      if (saved.modelId) { this._selection.modelId = saved.modelId; }
      if (saved.providerID) { this._selection.providerID = saved.providerID; }
      if (saved.variant) { this._selection.variant = saved.variant; }
    }
  }

  private _updateCachedContextSelection(): void {
    const cached = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (cached) {
      this._context.workspaceState.update(this._contextKey(), { ...cached, current: { ...this._selection } });
    }
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly _engine: AgentEngine,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  /** Called by extension.ts when engine status changes */
  notifyStatus(status: ServerStatus): void {
    this._lastStatus = status;
    this._broadcast({ type: "status", ...status });
    if (status.value === "ready" && this._currentView) {
      this._fetchAndPostContext(this._currentView.webview);
    }
  }

  private _subscribeToEngine(): void {
    if (this._engineSubscribed) return;
    this._engine.on('event', (event: EngineEvent) => {
      this._handleEngineEvent(event);
    });
    this._engineSubscribed = true;
  }

  private _handleEngineEvent(event: EngineEvent): void {
    if (event.type === 'permission.asked') {
      const props = event.properties ?? {};
      const permName = props.permission as string | undefined;
      const permId   = props.id as string | undefined;
      if (!permId || !permName) {
        this._broadcast(event);
        return;
      }
      const autoApproveFileWrites = vscode.workspace.getConfiguration('opencode').get<boolean>('autoApprove.fileWrites', false);
      const autoApproveCommands   = vscode.workspace.getConfiguration('opencode').get<boolean>('autoApprove.commands', false);
      const autoApproveFileReads  = vscode.workspace.getConfiguration('opencode').get<boolean>('autoApprove.fileReads', true);

      if (ChatPanel._isWriteToolName(permName) && autoApproveFileWrites) {
        this._engine.permissionReply(permId, 'once');
        return;
      }
      if (ChatPanel._isCommandToolName(permName) && autoApproveCommands) {
        this._engine.permissionReply(permId, 'once');
        return;
      }
      if (ChatPanel._isReadToolName(permName) && autoApproveFileReads) {
        this._engine.permissionReply(permId, 'once');
        return;
      }
      // Not auto-approved → forward to webview
      this._broadcast(event);
      return;
    }
    if (event.type === 'engine.provider.changed') {
      if (this._currentView) {
        this._fetchAndPostContext(this._currentView.webview, false);
      }
      return;
    }
    // Forward all other events to webview
    this._broadcast(event);
  }

  private async _getOrCreateSession(): Promise<string> {
    if (!this._sessionPromise) {
      const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      this._sessionPromise = this._engine.createSession(this._selection.agent, directory)
        .then(id => {
          this._context.workspaceState.update(this._sessionKey(), id);
          this._pushSessionList(id).catch(() => {});
          return id;
        })
        .catch(err => {
          this._sessionPromise = undefined;
          throw err;
        });
    }
    return this._sessionPromise;
  }

  private async _pushSessionList(activeId: string | null): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessions = this._engine.listSessions(workspaceRoot);
    sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    this._broadcast({ type: "sessionList", sessions, activeId });
  }

  private async _fetchAndPostContext(webview: vscode.Webview, attemptRestore = true): Promise<void> {
    try {
      const [agents, models, config] = await Promise.all([
        Promise.resolve(this._engine.listAgents()),
        this._engine.listModels(),
        Promise.resolve(this._engine.getConfig()),
      ]);

      this._agents = agents.map(a => ({
        name: a.name,
        description: (a as { description?: string }).description,
      }));
      this._models = models.map(m => ({
        id: m.id,
        providerID: m.providerID,
        name: m.name,
      }));

      const current: CurrentSelection = {};
      if (config.defaultAgent) current.agent = config.defaultAgent;
      if (config.activeModel) {
        const parts = config.activeModel.split('/');
        if (parts.length >= 2) {
          current.providerID = parts[0];
          current.modelId = parts.slice(1).join('/');
        } else {
          current.modelId = config.activeModel;
        }
      }

      if (!this._selection.agent) this._selection.agent = current.agent;
      this._restoreAgentSelection();
      if (!this._selection.agent) this._selection.agent = 'default';
      this._restoreModelSelection();

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
        agents: this._agents.map(a => ({
          name: a.name,
          description: a.description,
          model: a.model,
        })),
        models: this._models.map(m => ({
          id: m.id,
          providerID: m.providerID,
          name: m.name,
          hasVariants: !!(m.variants && Object.keys(m.variants).length > 0),
          variants: m.variants ? Object.keys(m.variants) : [],
        })),
        current: { ...this._selection },
      };
      webview.postMessage({ type: "context", ...payload });
      this._context.workspaceState.update(this._contextKey(), payload);

      if (attemptRestore && !this._sessionPromise) {
        await this._tryRestoreSession(webview);
      }
    } catch {
      webview.postMessage({ type: "contextError", message: "Could not load agents/models" });
    }
  }

  private _normPath(p: string): string {
    let s = p.replace(/[\\/]+$/, "");
    if (process.platform === "win32") s = s.toLowerCase();
    return s;
  }

  private async _tryRestoreSession(webview: vscode.Webview): Promise<boolean> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessions = this._engine.listSessions(workspaceRoot);
    if (sessions.length === 0) return false;
    const savedId = this._context.workspaceState.get<string>(this._sessionKey());
    const target = (savedId ? sessions.find(s => s.id === savedId) : undefined) ?? sessions[0];
    if (!target) return false;
    this._sessionPromise = Promise.resolve(target.id);
    const messages = this._engine.getSessionMessages(target.id, 50);
    webview.postMessage({ type: "sessionRestored", messages, current: { ...this._selection } });
    return true;
  }

  resetSession(): void {
    this._sessionPromise = undefined;
    this._selection = {};
    this._context.workspaceState.update(this._sessionKey(), undefined);
    this._broadcast({ type: "newSession" });
    this._broadcast({ type: "status", ...this._lastStatus });
    if (this._lastStatus.value === "ready" && this._currentView) {
      this._fetchAndPostContext(this._currentView.webview, false);
    }
  }

  private static _isWriteToolName(name: string): boolean {
    return name === 'write' || name === 'Write' || name === 'edit' || name === 'Edit';
  }

  private static _isCommandToolName(name: string): boolean {
    return name === 'bash' || name === 'Bash';
  }

  private static _isReadToolName(name: string): boolean {
    return ['read', 'Read', 'glob', 'Glob', 'grep', 'Grep'].includes(name);
  }

  public maximize(): void {
    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

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

    const panel = this._editorPanel;
    panel.webview.html = this._getHtml(panel.webview);

    this._editorDisposables.push(
      panel.webview.onDidReceiveMessage(
        (msg) => this._handleMessage(panel.webview, msg)
      )
    );

    this._editorDisposables.push(
      panel.onDidDispose(() => {
        this._editorDisposables.forEach(d => d.dispose());
        this._editorDisposables = [];
        this._editorPanel = undefined;
        vscode.commands.executeCommand("opencode.chatView.focus");
      })
    );

    panel.webview.postMessage({ type: "status", ...this._lastStatus });

    const stale = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (stale) {
      panel.webview.postMessage({ type: "context", ...stale });
    }

    if (this._sessionPromise) {
      this._sessionPromise
        .then((sessionId) => {
          const messages = this._engine.getSessionMessages(sessionId, 50);
          panel.webview.postMessage({
            type: "sessionRestored",
            messages,
            current: { ...this._selection },
          });
        })
        .catch(() => { /* non-fatal */ });
    }

    if (this._lastStatus.value === "ready" && !this._sessionPromise) {
      this._fetchAndPostContext(panel.webview);
    }

    vscode.commands.executeCommand("workbench.action.closeSidebar");
  }

  public minimize(): void {
    this._editorPanel?.dispose();
  }

  private _broadcast(message: unknown): void {
    this._currentView?.webview.postMessage(message);
    this._editorPanel?.webview.postMessage(message);
  }

  private async _augmentWithMentions(text: string, _webview: vscode.Webview): Promise<string> {
    const mentionRegex = /@([\w./\-]+)/g;
    let match: RegExpExecArray | null;
    let augmentedText = text;
    const contextBlocks: string[] = [];
    while ((match = mentionRegex.exec(text)) !== null) {
      const relPath = match[1];
      const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!rootUri) continue;
      try {
        const fileUri = vscode.Uri.joinPath(rootUri, relPath);
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString('utf-8');
        const ext = relPath.split('.').pop() ?? '';
        contextBlocks.push(`\`\`\`${ext}\n// ${relPath}\n${content}\n\`\`\``);
      } catch {
        // file not readable — skip silently
      }
    }
    if (contextBlocks.length > 0) {
      augmentedText = contextBlocks.join('\n\n') + '\n\n' + augmentedText;
    }
    return augmentedText;
  }

  private async _handleMessage(
    webview: vscode.Webview,
    msg: {
      type: string;
      text?: string;
      requestID?: string;
      answers?: unknown;
      reply?: string;
      message?: string;
      sessionId?: string;
      title?: string;
      editMessageId?: string;
      filePath?: string;
      original?: string;
      modified?: string;
      images?: { dataUrl: string; mimeType: string }[];
      query?: string;
    }
  ): Promise<void> {
    if (msg.type === 'abort') {
      const sessionId = await this._sessionPromise?.catch(() => undefined);
      if (sessionId) {
        this._engine.abort(sessionId);
      }
      return;
    }

    if (msg.type === "getStatus") {
      this._broadcast({ type: "status", ...this._lastStatus });
      if (this._lastStatus.value === "ready") {
        if (!this._sessionPromise) {
          this._fetchAndPostContext(webview);
        } else {
          const stale = this._context.workspaceState.get<CachedContext>(this._contextKey());
          if (stale) {
            webview.postMessage({ type: "context", ...stale });
          }
          this._sessionPromise
            .then((sessionId) => {
              const msgs = this._engine.getSessionMessages(sessionId, 50);
              webview.postMessage({
                type: "sessionRestored",
                messages: msgs,
                current: { ...this._selection },
              });
            })
            .catch(() => { /* no session */ });
        }
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
      const models = await this._engine.listModels();
      type ModelInfo = { id: string; providerID: string; name: string };

      const grouped = new Map<string, ModelInfo[]>();
      for (const m of models) {
        const g = grouped.get(m.providerID) ?? [];
        g.push(m);
        grouped.set(m.providerID, g);
      }

      type ModelItem = vscode.QuickPickItem & { _model?: ModelInfo };
      const items: ModelItem[] = [];
      for (const [providerID, providerModels] of grouped) {
        items.push({ label: providerID, kind: vscode.QuickPickItemKind.Separator });
        for (const m of providerModels.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))) {
          items.push({ label: m.name || m.id, description: m.id, _model: m });
        }
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Model',
        placeHolder: 'Choose a model for this session',
      });
      if (picked?._model) {
        this._selection.modelId = picked._model.id;
        this._selection.providerID = picked._model.providerID;
        this._selection.variant = undefined;
        this._saveModelSelection();
        this._updateCachedContextSelection();
        this._sessionPromise = undefined;
        this._broadcast({
          type: 'contextUpdate',
          modelId:    picked._model.id,
          providerID: picked._model.providerID,
          modelName:  picked._model.name || picked._model.id,
          variants:   [],
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
        this._sessionPromise = undefined;
        this._broadcast({ type: "contextUpdate", variant: picked });
      }
      return;
    }

    if (msg.type === "fetchSessions") {
      const activeId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(activeId ?? null);
      return;
    }

    if (msg.type === "switchSession") {
      if (!msg.sessionId) return;
      this._sessionPromise = undefined;
      this._selection = {};
      this._context.workspaceState.update(this._sessionKey(), msg.sessionId);
      this._sessionPromise = Promise.resolve(msg.sessionId);
      try {
        const messages = this._engine.getSessionMessages(msg.sessionId, 50);
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
      if (!msg.sessionId) return;
      try {
        const activeId = await this._sessionPromise?.catch(() => undefined);
        this._engine.deleteSession(msg.sessionId);
        if (activeId === msg.sessionId) {
          this.resetSession();
        }
      } catch { /* ignore */ }
      const newActiveId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(newActiveId ?? null);
      return;
    }

    if (msg.type === "renameSession") {
      if (!msg.sessionId || !msg.title) return;
      try {
        this._engine.updateSession(msg.sessionId, msg.title);
      } catch { /* ignore */ }
      const activeId = await this._sessionPromise?.catch(() => undefined);
      await this._pushSessionList(activeId ?? null);
      return;
    }

    if (msg.type === "forkSession") {
      if (!msg.sessionId) return;
      try {
        const newId = await this._engine.forkSession(msg.sessionId);
        this._sessionPromise = undefined;
        this._selection = {};
        this._context.workspaceState.update(this._sessionKey(), newId);
        this._sessionPromise = Promise.resolve(newId);
        const messages = this._engine.getSessionMessages(newId, 50);
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
      if (msg.requestID && Array.isArray(msg.answers)) {
        this._engine.questionReply(msg.requestID as string, msg.answers as string[][]);
      }
      return;
    }

    if (msg.type === "questionReject") {
      if (msg.requestID) {
        this._engine.questionReject(msg.requestID as string);
      }
      return;
    }

    if (msg.type === "permissionReply") {
      if (msg.requestID && msg.reply) {
        this._engine.permissionReply(
          msg.requestID as string,
          msg.reply as "once" | "always" | "reject",
        );
      }
      return;
    }

    if (msg.type === "openSettings") {
      vscode.commands.executeCommand("workbench.action.openSettings", "opencode.autoApprove");
      return;
    }

    if (msg.type === "fetchFiles") {
      const query: string = msg.query ?? '';
      const pattern = query ? `**/*${query}*` : '**/*';
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
      const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const files = uris.map(u =>
        rootUri ? u.fsPath.replace(rootUri.fsPath, '').replace(/\\/g, '/').replace(/^\//, '') : u.fsPath
      );
      webview.postMessage({ type: 'fileList', files });
      return;
    }

    if (msg.type === "openDiff") {
      if (!msg.filePath || msg.original === undefined) return;
      const filename = path.basename(msg.filePath);
      const tmpPath = path.join(os.tmpdir(), `opencode-diff-${Date.now()}-${filename}`);
      fs.writeFileSync(tmpPath, msg.original, "utf8");
      const tmpUri = vscode.Uri.file(tmpPath);
      const actualUri = vscode.Uri.file(msg.filePath);
      vscode.commands.executeCommand("vscode.diff", tmpUri, actualUri, `Before ↔ After: ${filename}`);
      const disposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.fsPath === tmpPath) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          disposable.dispose();
        }
      });
      return;
    }

    if (msg.type !== "send" && msg.type !== "editMessage") return;
    if (!msg.text && !(Array.isArray(msg.images) && (msg.images as unknown[]).length > 0)) return;

    try {
      const sessionId = await this._getOrCreateSession();

      if (msg.type === "editMessage" && msg.editMessageId) {
        this._engine.revertSession(sessionId, msg.editMessageId);
      }

      const augmentedText = await this._augmentWithMentions(msg.text ?? '', webview);
      await this._engine.sendMessage(sessionId, augmentedText, msg.images);
    } catch (err: unknown) {
      this._sessionPromise = undefined;
      const message = err instanceof Error ? err.message : String(err);
      this._broadcast({ type: "status", value: "error", message });
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const isNewInstance = this._currentView !== webviewView;
    if (isNewInstance) {
      this._sessionPromise = undefined;
    }

    this._currentView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };

    if (isNewInstance) {
      webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    // Subscribe to engine events (only once)
    this._subscribeToEngine();

    webviewView.webview.postMessage({ type: "status", ...this._lastStatus });

    const stale = this._context.workspaceState.get<CachedContext>(this._contextKey());
    if (stale) {
      webviewView.webview.postMessage({ type: "context", ...stale });
    }

    if (this._lastStatus.value === "ready" && this._currentView && !this._sessionPromise) {
      this._fetchAndPostContext(this._currentView.webview);
    }

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      if (this._lastStatus.value !== "ready") return;
      if (!this._sessionPromise) {
        this._fetchAndPostContext(webviewView.webview);
      } else {
        webviewView.webview.postMessage({ type: "status", ...this._lastStatus });
      }
    });

    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(webviewView.webview, msg),
      undefined,
      []
    );

    webviewView.onDidDispose(() => {
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
