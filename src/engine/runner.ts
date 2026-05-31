import * as crypto from 'crypto';
import type { IProvider, ProviderMessage, AssistantMessage, UserMessage } from '../providers/base';
import type { ToolRegistry, EmitEventFn, PermissionGateFn } from '../tools/index';
import { PermissionRejectedError } from '../tools/index';
import type { Session, HistoryMessage, MessagePart } from './session';
import { isSpawnAgentCall, SpawnAgentToolDefinition, SPAWN_AGENT_TOOL_NAME } from '../tools/spawn-agent';
import type { SpawnAgentCallbacks } from '../tools/spawn-agent';

const MAX_ITERATIONS = 20;

export class AgentRunner {
  private _controller: AbortController | undefined;
  private _isRunning = false;

  constructor(
    private session: Session,
    private provider: IProvider,
    private tools: ToolRegistry,
    private systemPrompt: string,
    private emitEvent: EmitEventFn,
    private pendingPermissions: Map<string, { resolve: (r: 'once' | 'always') => void; reject: (e: Error) => void }>,
    private callbacks?: SpawnAgentCallbacks,
  ) {}

  abort(): void {
    this._controller?.abort();
  }

  async run(userText: string, images?: { dataUrl: string; mimeType: string }[]): Promise<void> {
    if (this._isRunning) {
      this.abort();
    }
    this._isRunning = true;
    this._controller = new AbortController();
    const { signal } = this._controller;

    // Add user message to history
    const userMsgId = crypto.randomUUID();
    const userHistMsg: HistoryMessage = {
      id: userMsgId,
      role: 'user',
      parts: [{ type: 'text', id: crypto.randomUUID(), text: userText }],
      timestamp: Date.now(),
    };
    if (images && images.length > 0) {
      for (const img of images) {
        (userHistMsg.parts as MessagePart[]).push({
          type: 'text',
          id: crypto.randomUUID(),
          text: `[Image: ${img.mimeType}]`,
        });
      }
    }
    this.session.history.push(userHistMsg);

    this._emitStatus('busy');

    // Auto-generate title from first message
    if (this.session.title === 'New session') {
      this.session.title = userText.slice(0, 50).trim();
    }

    const WALL_CLOCK_MS = 5 * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      this.abort();
      this.emitEvent({
        type: 'session.status',
        id: crypto.randomUUID(),
        properties: {
          sessionID: this.session.id,
          status: { type: 'error', error: 'Agent timed out after 5 minutes' },
        },
      });
    }, WALL_CLOCK_MS);

    let iterations = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (signal.aborted) break;

        if (iterations >= MAX_ITERATIONS) {
          this._emitStatus('error', 'Agent exceeded maximum tool call iterations (20).');
          break;
        }
        iterations++;

        const messages = this._formatMessages();
        const toolDefs = this.tools.definitions();
        if (this.callbacks) toolDefs.push(SpawnAgentToolDefinition);

        // Accumulated data for this turn
        let accText = '';
        const toolCallMap = new Map<string, { name: string; jsonBuffer: string }>();
        const toolCallsThisTurn: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        const msgId = crypto.randomUUID();
        const partId = crypto.randomUUID();

        // Stream from provider
        const stream = this.provider.streamCompletion(messages, toolDefs, signal);

        for await (const chunk of stream) {
          if (signal.aborted) break;

          if (chunk.type === 'text_delta') {
            accText += chunk.delta;
            this.emitEvent({
              type: 'message.part.delta',
              id: crypto.randomUUID(),
              properties: {
                sessionID: this.session.id,
                messageID: msgId,
                partID: partId,
                field: 'text',
                delta: chunk.delta,
              },
            });
          } else if (chunk.type === 'tool_use_start') {
            toolCallMap.set(chunk.id, { name: chunk.name, jsonBuffer: '' });
            this.emitEvent({
              type: 'session.next.tool.input.started',
              id: crypto.randomUUID(),
              properties: { sessionID: this.session.id, callID: chunk.id, name: chunk.name },
            });
          } else if (chunk.type === 'tool_input_delta') {
            const tc = toolCallMap.get(chunk.id);
            if (tc) tc.jsonBuffer += chunk.delta;
          } else if (chunk.type === 'tool_use_end') {
            const tc = toolCallMap.get(chunk.id);
            if (tc) {
              let parsedInput: Record<string, unknown> = {};
              try { parsedInput = JSON.parse(tc.jsonBuffer) as Record<string, unknown>; } catch { /* use empty */ }
              toolCallsThisTurn.push({ id: chunk.id, name: tc.name, input: parsedInput });
              this.emitEvent({
                type: 'session.next.tool.input.ended',
                id: crypto.randomUUID(),
                properties: { sessionID: this.session.id, callID: chunk.id, text: tc.jsonBuffer },
              });
            }
          } else if (chunk.type === 'message_stop') {
            break;
          }
          // UsageChunk: ignore for now
        }

        // Build assistant history message
        const assistantParts: MessagePart[] = [];
        if (accText) {
          assistantParts.push({ type: 'text', id: partId, text: accText });
        }
        for (const tc of toolCallsThisTurn) {
          assistantParts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        if (assistantParts.length > 0) {
          const assistantMsg: HistoryMessage = {
            id: msgId,
            role: 'assistant',
            parts: assistantParts,
            timestamp: Date.now(),
          };
          this.session.history.push(assistantMsg);
        }

        // No tool calls → done
        if (toolCallsThisTurn.length === 0) {
          this._emitStatus('idle');
          this.emitEvent({
            type: 'session.idle',
            id: crypto.randomUUID(),
            properties: { sessionID: this.session.id },
          });
          break;
        }

        // Execute tools sequentially
        const toolResultParts: MessagePart[] = [];
        for (const tc of toolCallsThisTurn) {
          // Intercept spawn_agent before ToolRegistry
          if (this.callbacks && isSpawnAgentCall(tc.name)) {
            const input = tc.input as { agent?: string; prompt?: string; context?: string };
            const agentName = input.agent ?? 'default';
            const prompt = input.prompt ?? '';
            const context = input.context ?? '';

            let resultText: string;
            try {
              const childId = await this.callbacks.spawnChild(agentName, prompt, context);
              resultText = await this.callbacks.awaitChildIdle(childId);
              this.emitEvent({
                type: 'session.next.tool.success',
                id: crypto.randomUUID(),
                properties: { sessionID: this.session.id, callID: tc.id },
              });
            } catch (err) {
              resultText = `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
              this.emitEvent({
                type: 'session.next.tool.error',
                id: crypto.randomUUID(),
                properties: { sessionID: this.session.id, callID: tc.id, error: resultText },
              });
            }

            toolResultParts.push({
              type: 'tool_result',
              id: crypto.randomUUID(),
              toolUseId: tc.id,
              content: resultText,
            });
            continue;
          }

          const awaitPermission: PermissionGateFn = (requestId, toolName, patterns) => {
            return new Promise((resolve, reject) => {
              this.pendingPermissions.set(requestId, { resolve, reject });
              this.emitEvent({
                type: 'permission.asked',
                id: requestId,
                properties: {
                  sessionID: this.session.id,
                  id: requestId,
                  permission: toolName,
                  patterns,
                },
              });
            });
          };

          const ctx = {
            workspaceRoot: this.session.directory,
            sessionID: this.session.id,
            emitEvent: this.emitEvent,
            awaitPermission,
          };

          try {
            const result = await this.tools.execute(tc.name, tc.input, ctx);
            this.emitEvent({
              type: 'session.next.tool.success',
              id: crypto.randomUUID(),
              properties: { sessionID: this.session.id, callID: tc.id },
            });
            toolResultParts.push({
              type: 'tool_result',
              id: crypto.randomUUID(),
              toolUseId: tc.id,
              content: result.content,
              isError: result.isError,
            });
          } catch (err) {
            if (err instanceof PermissionRejectedError) {
              // Inject rejection result and continue
              this.emitEvent({
                type: 'session.next.tool.error',
                id: crypto.randomUUID(),
                properties: { sessionID: this.session.id, callID: tc.id, error: 'Permission rejected' },
              });
              toolResultParts.push({
                type: 'tool_result',
                id: crypto.randomUUID(),
                toolUseId: tc.id,
                content: '[user rejected this action]',
                isError: true,
              });
            } else {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.emitEvent({
                type: 'session.next.tool.error',
                id: crypto.randomUUID(),
                properties: { sessionID: this.session.id, callID: tc.id, error: errMsg },
              });
              toolResultParts.push({
                type: 'tool_result',
                id: crypto.randomUUID(),
                toolUseId: tc.id,
                content: `Tool error: ${errMsg}`,
                isError: true,
              });
            }
          }
        }

        // Add tool results as user message
        const toolResultMsg: HistoryMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          parts: toolResultParts,
          timestamp: Date.now(),
        };
        this.session.history.push(toolResultMsg);
      }
    } catch (err) {
      if (!signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this._emitStatus('error', errMsg);
      }
    } finally {
      clearTimeout(timeoutHandle);
      this._isRunning = false;
      this._controller = undefined;
    }
  }

  private _emitStatus(type: 'busy' | 'idle' | 'error', error?: string): void {
    this.emitEvent({
      type: 'session.status',
      id: crypto.randomUUID(),
      properties: {
        sessionID: this.session.id,
        status: { type, ...(error ? { error } : {}) },
      },
    });
  }

  private _formatMessages(): ProviderMessage[] {
    const out: ProviderMessage[] = [];

    if (this.systemPrompt) {
      out.push({ role: 'system', content: this.systemPrompt });
    }

    for (const msg of this.session.history) {
      if (msg.role === 'user') {
        const content: UserMessage['content'] = [];
        for (const part of msg.parts) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              toolUseId: part.toolUseId,
              content: part.content,
              isError: part.isError,
            });
          }
        }
        if (content.length > 0) {
          out.push({ role: 'user', content });
        }
      } else if (msg.role === 'assistant') {
        const content: AssistantMessage['content'] = [];
        for (const part of msg.parts) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'tool_use') {
            content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
          }
        }
        if (content.length > 0) {
          out.push({ role: 'assistant', content });
        }
      }
    }

    return out;
  }
}
