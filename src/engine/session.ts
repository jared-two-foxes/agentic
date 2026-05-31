import * as crypto from 'crypto';
import type * as vscode from 'vscode';

// ── Message parts ─────────────────────────────────────────────────────────────

export type TextPart = {
  type: 'text';
  id: string;
  text: string;
};

export type ReasoningPart = {
  type: 'reasoning';
  id: string;
  text: string;
};

export type ToolUsePart = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultPart = {
  type: 'tool_result';
  id: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type MessagePart = TextPart | ReasoningPart | ToolUsePart | ToolResultPart;

// ── History message ───────────────────────────────────────────────────────────

export type HistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  timestamp: number;
};

// ── Session lean descriptor ───────────────────────────────────────────────────

export type SessionInfo = {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
  parentID?: string;
};

// ── Session class ─────────────────────────────────────────────────────────────

export class Session {
  readonly id: string;
  title: string;
  readonly directory: string;
  agentName: string;
  readonly parentID?: string;
  history: HistoryMessage[] = [];
  readonly createdAt: number;
  updatedAt: number;

  constructor(opts: {
    id?: string;
    title?: string;
    directory: string;
    agentName?: string;
    parentID?: string;
    createdAt?: number;
  }) {
    this.id        = opts.id ?? crypto.randomUUID();
    this.title     = opts.title ?? 'New session';
    this.directory = opts.directory;
    this.agentName = opts.agentName ?? 'default';
    this.parentID  = opts.parentID;
    this.createdAt = opts.createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
  }

  toInfo(): SessionInfo {
    return {
      id: this.id,
      title: this.title,
      directory: this.directory,
      time: { created: this.createdAt, updated: this.updatedAt },
      ...(this.parentID ? { parentID: this.parentID } : {}),
    };
  }
}

// ── Session manager ───────────────────────────────────────────────────────────

const MAX_HISTORY = 200;

type PersistedSession = {
  id: string;
  title: string;
  directory: string;
  agentName: string;
  parentID?: string;
  history: HistoryMessage[];
  createdAt: number;
  updatedAt: number;
};

export class SessionManager {
  private readonly _sessions = new Map<string, Session>();
  private _context?: vscode.ExtensionContext;

  init(context: vscode.ExtensionContext): void {
    this._context = context;
    this._restore();
  }

  create(opts: { directory: string; agentName?: string; parentID?: string }): Session {
    const session = new Session(opts);
    this._sessions.set(session.id, session);
    this._persist();
    return session;
  }

  get(id: string): Session | undefined {
    return this._sessions.get(id);
  }

  list(directory?: string): Session[] {
    const all = [...this._sessions.values()];
    if (!directory) return all.sort((a, b) => b.updatedAt - a.updatedAt);
    const norm = normPath(directory);
    return all
      .filter(s => normPath(s.directory) === norm)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    this._sessions.delete(id);
    this._persist();
  }

  updateTitle(id: string, title: string): void {
    const s = this._sessions.get(id);
    if (!s) return;
    s.title = title;
    s.updatedAt = Date.now();
    this._persist();
  }

  fork(id: string): Session | undefined {
    const orig = this._sessions.get(id);
    if (!orig) return undefined;
    const clone = new Session({
      directory: orig.directory,
      agentName: orig.agentName,
      title: `${orig.title} (fork)`,
    });
    clone.history = JSON.parse(JSON.stringify(orig.history)) as HistoryMessage[];
    this._sessions.set(clone.id, clone);
    this._persist();
    return clone;
  }

  addMessage(sessionId: string, message: HistoryMessage): void {
    const s = this._sessions.get(sessionId);
    if (!s) return;
    s.history.push(message);
    if (s.history.length > MAX_HISTORY) {
      s.history = s.history.slice(s.history.length - MAX_HISTORY);
    }
    s.updatedAt = Date.now();
    this._persist();
  }

  revert(sessionId: string, messageId: string): void {
    const s = this._sessions.get(sessionId);
    if (!s) return;
    const idx = s.history.findIndex(m => m.id === messageId);
    if (idx !== -1) s.history = s.history.slice(0, idx);
    s.updatedAt = Date.now();
    this._persist();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private _persist(): void {
    if (!this._context) return;
    const serialised: PersistedSession[] = [...this._sessions.values()].map(s => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      agentName: s.agentName,
      parentID: s.parentID,
      history: s.history,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    this._context.workspaceState.update('agentic.sessions', serialised);
  }

  private _restore(): void {
    if (!this._context) return;
    const saved = this._context.workspaceState.get<PersistedSession[]>('agentic.sessions') ?? [];
    for (const raw of saved) {
      const s = new Session({
        id: raw.id,
        title: raw.title,
        directory: raw.directory,
        agentName: raw.agentName,
        parentID: raw.parentID,
        createdAt: raw.createdAt,
      });
      s.history = raw.history ?? [];
      s.updatedAt = raw.updatedAt ?? raw.createdAt;
      this._sessions.set(s.id, s);
    }
  }
}

function normPath(p: string): string {
  let s = p.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}
