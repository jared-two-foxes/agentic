// ── Agent definition ──────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Unique name used to reference the agent (e.g. "design", "coder") */
  name: string;

  /** Short description shown in the agent picker */
  description: string;

  /**
   * System prompt injected as the first message in every conversation.
   * Supports a limited set of placeholders:
   *   {{workspace}} — absolute path to the workspace root
   *   {{date}}      — current date in ISO format
   */
  systemPrompt: string;

  /**
   * Preferred model. Falls back to the active provider's default.
   * Format: "providerID/modelID", e.g. "anthropic/claude-opus-4-5"
   */
  model?: string;

  /**
   * Tool names this agent is allowed to use.
   * Defaults to DEFAULT_TOOLS if omitted.
   */
  tools?: string[];

  /**
   * When true, this agent is hidden from the agent picker.
   * Used for sub-agents that should only be spawned programmatically.
   */
  hidden?: boolean;

  /**
   * Execution mode:
   * - 'primary'  — can be selected by the user as the main agent
   * - 'subagent' — only spawnable by another agent (via spawn_agent tool)
   * - 'all'      — both (default)
   */
  mode?: 'primary' | 'subagent' | 'all';
}

// ── Config file format ────────────────────────────────────────────────────────

/**
 * The shape of a .opencode/agents/*.json file.
 * Can be a single definition or an array of definitions.
 */
export type AgentConfigFile = AgentDefinition | AgentDefinition[];

// ── Type guard ─────────────────────────────────────────────────────────────────

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['name'] === 'string' && typeof v['description'] === 'string';
}

// ── Built-in agent IDs ────────────────────────────────────────────────────────

export type BuiltinAgentId = 'default' | 'design' | 'coder' | 'pipeline-runner';

// ── Default tool set ──────────────────────────────────────────────────────────

/** All tools available when an agent omits the 'tools' field */
export const DEFAULT_TOOLS = ['read', 'glob', 'grep', 'write', 'edit', 'bash'] as const;

/** Read-only tool set (for design/planning agents) */
export const READONLY_TOOLS = ['read', 'glob', 'grep'] as const;

// ── System prompt placeholder expansion ──────────────────────────────────────

export function expandSystemPrompt(template: string, ctx: { workspaceRoot: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  return template
    .replace(/\{\{workspace\}\}/g, ctx.workspaceRoot)
    .replace(/\{\{date\}\}/g, date);
}
