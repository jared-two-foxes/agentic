import type { ToolDefinition } from '../providers/base';

export const SPAWN_AGENT_TOOL_NAME = 'spawn_agent';

export const SpawnAgentToolDefinition: ToolDefinition = {
  name: SPAWN_AGENT_TOOL_NAME,
  description: `Spawn a sub-agent to handle a focused sub-task. The sub-agent runs in its own session and returns its final answer. Use this to delegate specialised work (e.g. spawn the "coder" agent to implement a specific file while you continue planning).`,
  inputSchema: {
    type: 'object',
    properties: {
      agent:   { type: 'string', description: 'Name of the agent to spawn (e.g. "coder", "design")' },
      prompt:  { type: 'string', description: 'The task or question to give the sub-agent' },
      context: { type: 'string', description: 'Optional additional context to include with the prompt' },
    },
    required: ['agent', 'prompt'],
  },
};

export function isSpawnAgentCall(toolName: string): boolean {
  return toolName === SPAWN_AGENT_TOOL_NAME;
}

export type SpawnAgentCallbacks = {
  /** Create a child session and start its runner. Returns the child session ID. */
  spawnChild(agentName: string, prompt: string, context?: string): Promise<string>;
  /** Await the child session's idle event. Returns the child's final assistant text. */
  awaitChildIdle(childSessionId: string): Promise<string>;
};
