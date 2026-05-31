import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import type { ProviderID } from '../providers/registry';
import { ToolRegistry, PermissionRejectedError } from '../tools/index';
import type { EngineEvent } from '../tools/index';
import { ReadTool, GlobTool, GrepTool } from '../tools/read';
import { WriteTool, EditTool } from '../tools/write';
import { BashTool } from '../tools/bash';
import { SessionManager } from './session';
import type { SessionInfo } from './session';
import { AgentRunner } from './runner';
import type { ModelInfo } from '../providers/base';
import { AgentRegistry } from '../agents/registry';
import { expandSystemPrompt, DEFAULT_TOOLS } from '../agents/types';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI coding assistant. You have access to tools to read and write files, search the codebase, and run shell commands. Always ask for clarification if the user's request is ambiguous. Prefer minimal, targeted changes.`;

type AgentInfo = {
  name: string;
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  hidden?: boolean;
  model?: { modelID: string; providerID: string };
};

type EngineConfig = {
  model?: string;          // "providerID/modelID" or undefined
  default_agent: string;
  activeProvider: string;
};

type WebviewTextPart    = { type: 'text';      partID: string; text: string };
type WebviewReasoningPart = { type: 'reasoning'; partID: string; text: string; done: boolean };
type WebviewPart = WebviewTextPart | WebviewReasoningPart;
type WebviewMessage =
  | { kind: 'user';      id: string; serverId: string; text: string }
  | { kind: 'assistant'; id: string; parts: WebviewPart[] };

function parseModelString(model: string): { modelID: string; providerID: string } | undefined {
  const parts = model.split('/');
  if (parts.length < 2) return undefined;
  return { providerID: parts[0], modelID: parts.slice(1).join('/') };
}

export class AgentEngine extends EventEmitter {
  private _sessions = new SessionManager();
  private _tools    = new ToolRegistry();
  private _registry: ProviderRegistry | undefined;
  private _agentRegistry = new AgentRegistry();
  private _runners  = new Map<string, AgentRunner>();
  private _pendingPermissions = new Map<string, {
    resolve: (r: 'once' | 'always') => void;
    reject: (e: Error) => void;
  }>();
  private _modelCache: { models: ModelInfo[]; expiresAt: number } | undefined;

  constructor() {
    super();
  }

  async init(context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel): Promise<void> {
    // 1. Restore sessions
    this._sessions.init(context);

    // 2. Register tools
    this._tools.register(new ReadTool());
    this._tools.register(new GlobTool());
    this._tools.register(new GrepTool());
    this._tools.register(new WriteTool());
    this._tools.register(new EditTool());
    this._tools.register(new BashTool());

    // 3. Create provider registry
    this._registry = new ProviderRegistry();
    this._registry.setProviderChangedCallback(() => {
      this._modelCache = undefined; // invalidate model cache on provider change
      this._emitEvent({ type: 'engine.provider.changed', id: crypto.randomUUID(), properties: {} });
    });
    await this._registry.init(context);

    // 4. Load agent registry
    if (outputChannel) {
      this._agentRegistry.setOutputChannel(outputChannel);
    }
    this._agentRegistry.loadBuiltins();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    await this._agentRegistry.load(workspaceRoot);

    // 5. Watch for agent file changes
    this._agentRegistry.watch(context, workspaceRoot, () => {
      // Re-resolve agent definitions for all active sessions
      for (const session of this._sessions.list()) {
        const def = this._agentRegistry.get(session.agentName);
        if (def) session.agentDefinition = def;
      }
      this._emitEvent({ type: 'engine.agents.reloaded', id: crypto.randomUUID(), properties: {} });
    });

    // 6. Re-resolve agentDefinition for all restored sessions
    for (const session of this._sessions.list()) {
      const def = this._agentRegistry.get(session.agentName);
      if (def) session.agentDefinition = def;
    }

    // 7. Emit ready
    this._emitEvent({ type: 'engine.ready', id: crypto.randomUUID(), properties: {} });
  }

  // ── Session CRUD ─────────────────────────────────────────────────────────────

  async createSession(agentName?: string, directory?: string): Promise<string> {
    const name = agentName ?? 'default';
    const def  = this._agentRegistry.get(name) ?? this._agentRegistry.get('default');
    const session = this._sessions.create({ directory: directory ?? '', agentName: name });
    session.agentDefinition = def;
    this._emitEvent({
      type: 'session.created',
      id: crypto.randomUUID(),
      properties: { sessionID: session.id, info: session.toInfo() },
    });
    return session.id;
  }

  listSessions(directory?: string): SessionInfo[] {
    return this._sessions.list(directory).map(s => s.toInfo());
  }

  getSessionMessages(sessionId: string, _limit?: number): WebviewMessage[] {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    let idCounter = 0;
    const uid = () => `r${++idCounter}`;
    const result: WebviewMessage[] = [];

    for (const msg of session.history) {
      if (msg.role === 'user') {
        const textParts = msg.parts.filter(p => p.type === 'text');
        const text = textParts.map(p => p.type === 'text' ? p.text : '').join('').trim();
        if (!text) continue;
        result.push({ kind: 'user', id: uid(), serverId: msg.id, text });
      } else if (msg.role === 'assistant') {
        const parts: WebviewPart[] = [];
        for (const p of msg.parts) {
          if (p.type === 'text') {
            parts.push({ type: 'text', partID: p.id, text: p.text });
          } else if (p.type === 'reasoning') {
            parts.push({ type: 'reasoning', partID: p.id, text: p.text, done: true });
          }
        }
        if (parts.length === 0) continue;
        result.push({ kind: 'assistant', id: uid(), parts });
      }
    }
    return result;
  }

  deleteSession(sessionId: string): void {
    this._runners.get(sessionId)?.abort();
    this._runners.delete(sessionId);
    this._sessions.delete(sessionId);
  }

  updateSession(sessionId: string, title: string): void {
    this._sessions.updateTitle(sessionId, title);
  }

  async forkSession(sessionId: string): Promise<string> {
    const cloned = this._sessions.fork(sessionId);
    if (!cloned) throw new Error(`Session ${sessionId} not found`);
    return cloned.id;
  }

  revertSession(sessionId: string, messageId: string): void {
    this._sessions.revert(sessionId, messageId);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────────

  async sendMessage(
    sessionId: string,
    text: string,
    images?: { dataUrl: string; mimeType: string }[],
  ): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!this._registry) throw new Error('Engine not initialized');

    // Abort any existing runner
    const existing = this._runners.get(sessionId);
    if (existing) {
      existing.abort();
      this._runners.delete(sessionId);
    }

    // Resolve system prompt from agent definition
    const def = session.agentDefinition;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const systemPrompt = def
      ? expandSystemPrompt(def.systemPrompt, { workspaceRoot })
      : DEFAULT_SYSTEM_PROMPT;

    // Build filtered tool registry based on agent's allowed tools
    const allowedTools = def?.tools ?? [...DEFAULT_TOOLS];
    const filteredRegistry = new ToolRegistry();
    for (const toolName of allowedTools) {
      const tool = this._tools.get(toolName);
      if (tool) filteredRegistry.register(tool);
    }

    const runner = new AgentRunner(
      session,
      this._registry.getActive(),
      filteredRegistry,
      systemPrompt,
      (event: EngineEvent) => this.emit('event', event),
      this._pendingPermissions,
    );
    this._runners.set(sessionId, runner);

    try {
      await runner.run(text, images);
    } finally {
      this._runners.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this._runners.get(sessionId)?.abort();
  }

  // ── Context ───────────────────────────────────────────────────────────────────

  listAgents(): AgentInfo[] {
    return this._agentRegistry.list().map(a => ({
      name: a.name,
      description: a.description,
      mode: a.mode ?? 'all',
      hidden: a.hidden ?? false,
      model: a.model ? parseModelString(a.model) : undefined,
    }));
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this._registry) return [];
    if (this._modelCache && Date.now() < this._modelCache.expiresAt) {
      return this._modelCache.models;
    }
    try {
      const models = await this._registry.getActive().listModels();
      this._modelCache = { models, expiresAt: Date.now() + 60_000 };
      return models;
    } catch {
      return [];
    }
  }

  getConfig(): EngineConfig {
    const cfg = vscode.workspace.getConfiguration('opencode');
    const providerID = cfg.get<string>('provider', 'vscode-lm');
    const modelId = cfg.get<string>('anthropicModel') ?? cfg.get<string>('openaiModel');
    const defaultAgent = this._agentRegistry.get('default')?.name ?? 'default';
    return {
      model: modelId ? `${providerID}/${modelId}` : undefined,
      default_agent: defaultAgent,
      activeProvider: this._registry?.getActive().providerID ?? providerID,
    };
  }

  async configureProvider(providerId: 'anthropic' | 'openai-compatible'): Promise<boolean> {
    if (!this._registry) return false;
    return this._registry.promptForApiKey(providerId);
  }

  async switchProvider(id: ProviderID): Promise<void> {
    if (!this._registry) return;
    await this._registry.setProvider(id);
  }

  async hasApiKey(providerId: 'anthropic' | 'openai-compatible'): Promise<boolean> {
    if (!this._registry) return false;
    return this._registry.hasApiKey(providerId);
  }

  // ── Permissions ───────────────────────────────────────────────────────────────

  permissionReply(requestId: string, reply: 'once' | 'always' | 'reject'): void {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending) return;
    this._pendingPermissions.delete(requestId);
    if (reply === 'reject') {
      pending.reject(new PermissionRejectedError('tool'));
    } else {
      pending.resolve(reply);
    }
  }

  questionReply(_requestId: string, _answers: string[][]): void {
    // Phase 3
  }

  questionReject(_requestId: string): void {
    // Phase 3
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private _emitEvent(event: EngineEvent): void {
    this.emit('event', event);
  }
}
