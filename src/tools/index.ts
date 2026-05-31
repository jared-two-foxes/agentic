import type { JsonSchema } from '../providers/base';

// ── Results ──────────────────────────────────────────────────────────────────

export type ToolResult = {
  content: string;
  isError?: boolean;
};

// ── Permission gate ──────────────────────────────────────────────────────────

export type PermissionGateFn = (
  requestId: string,
  toolName: string,
  patterns: string[],
) => Promise<'once' | 'always'>;

export class PermissionRejectedError extends Error {
  constructor(public readonly toolName: string) {
    super(`Permission rejected for tool: ${toolName}`);
    this.name = 'PermissionRejectedError';
  }
}

// ── Event emission ───────────────────────────────────────────────────────────

export type EngineEvent = {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
};

export type EmitEventFn = (event: EngineEvent) => void;

// ── Execution context ─────────────────────────────────────────────────────────

export type ToolExecutionContext = {
  workspaceRoot: string;
  sessionID: string;
  emitEvent: EmitEventFn;
  awaitPermission: PermissionGateFn;
};

// ── Tool interface ────────────────────────────────────────────────────────────

export interface ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;

  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly _tools = new Map<string, ITool>();

  register(tool: ITool): void {
    this._tools.set(tool.name, tool);
  }

  get(name: string): ITool | undefined {
    return this._tools.get(name);
  }

  list(): ITool[] {
    return [...this._tools.values()];
  }

  definitions(): import('../providers/base').ToolDefinition[] {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this._tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: "${name}"`, isError: true };
    }
    try {
      return await tool.execute(input, ctx);
    } catch (err) {
      if (err instanceof PermissionRejectedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Tool "${name}" failed: ${msg}`, isError: true };
    }
  }
}
