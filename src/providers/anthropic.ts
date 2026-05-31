import * as https from 'https';
import type * as vscode from 'vscode';
import type {
  IProvider,
  ProviderMessage,
  ToolDefinition,
  StreamChunk,
  ModelInfo,
} from './base';
import { ProviderError } from './base';

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage =
  | { role: 'user'; content: AnthropicContent[] }
  | { role: 'assistant'; content: AnthropicContent[] };

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: object;
};

function toAnthropicMessages(messages: ProviderMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') { system = msg.content; continue; }
    if (msg.role === 'user') {
      const content: AnthropicContent[] = msg.content.map(c => {
        if (c.type === 'text') return { type: 'text' as const, text: c.text };
        if (c.type === 'image') return { type: 'image' as const, source: { type: 'base64' as const, media_type: c.mimeType, data: c.data } };
        if (c.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: c.toolUseId, content: c.content, is_error: c.isError };
        return { type: 'text' as const, text: '' };
      });
      out.push({ role: 'user', content });
    }
    if (msg.role === 'assistant') {
      const content: AnthropicContent[] = msg.content.map(c => {
        if (c.type === 'text') return { type: 'text' as const, text: c.text };
        if (c.type === 'tool_use') return { type: 'tool_use' as const, id: c.id, name: c.name, input: c.input };
        return { type: 'text' as const, text: '' };
      });
      out.push({ role: 'assistant', content });
    }
  }
  return { system, messages: out };
}

export class AnthropicProvider implements IProvider {
  readonly providerID = 'anthropic';

  constructor(
    private readonly _model: string = 'claude-opus-4-5',
    private readonly _secrets: vscode.SecretStorage,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', providerID: 'anthropic', contextWindow: 200000 },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', providerID: 'anthropic', contextWindow: 200000 },
      { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5', providerID: 'anthropic', contextWindow: 200000 },
    ];
  }

  async *streamCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = await this._getApiKey();
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

    const body: Record<string, unknown> = {
      model: this._model,
      max_tokens: 8192,
      messages: anthropicMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t): AnthropicTool => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const bodyStr = JSON.stringify(body);

    // Retry once on 429
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* this._doStream(bodyStr, apiKey, signal);
      if (result !== 'retry') break;
    }
  }

  private async *_doStream(
    bodyStr: string,
    apiKey: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk, 'retry' | 'done'> {
    let retryAfter = 0;

    const chunks: StreamChunk[] = await new Promise<StreamChunk[]>((resolve, reject) => {
      if (signal?.aborted) { reject(new ProviderError('Aborted', 0, 'anthropic')); return; }

      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          if (res.statusCode === 429) {
            retryAfter = parseInt((res.headers['retry-after'] as string) ?? '1', 10) || 1;
            res.resume();
            // We'll resolve with a special marker
            resolve([]);
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (d: Buffer) => { errBody += d.toString(); });
            res.on('end', () => reject(new ProviderError(`Anthropic error ${res.statusCode}: ${errBody}`, res.statusCode, 'anthropic')));
            return;
          }

          const collected: StreamChunk[] = [];
          let buf = '';
          // Track content block types by index
          const blockTypes = new Map<number, { type: 'text' | 'tool_use'; id?: string; name?: string }>();
          let stopReason = 'end_turn';

          res.on('data', (data: Buffer) => {
            buf += data.toString();
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) {
              let dataStr = '';
              for (const line of frame.split('\n')) {
                if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
              }
              if (!dataStr || dataStr === '[DONE]') continue;
              let payload: Record<string, unknown>;
              try { payload = JSON.parse(dataStr) as Record<string, unknown>; } catch { continue; }

              const type = payload.type as string;
              if (type === 'content_block_start') {
                const idx = payload.index as number;
                const cb = payload.content_block as { type: string; id?: string; name?: string };
                blockTypes.set(idx, { type: cb.type as 'text' | 'tool_use', id: cb.id, name: cb.name });
                if (cb.type === 'tool_use' && cb.id && cb.name) {
                  collected.push({ type: 'tool_use_start', id: cb.id, name: cb.name });
                }
              } else if (type === 'content_block_delta') {
                const idx = payload.index as number;
                const delta = payload.delta as { type: string; text?: string; partial_json?: string };
                const block = blockTypes.get(idx);
                if (delta.type === 'text_delta' && delta.text) {
                  collected.push({ type: 'text_delta', delta: delta.text });
                } else if (delta.type === 'input_json_delta' && delta.partial_json && block?.id) {
                  collected.push({ type: 'tool_input_delta', id: block.id, delta: delta.partial_json });
                }
              } else if (type === 'content_block_stop') {
                const idx = payload.index as number;
                const block = blockTypes.get(idx);
                if (block?.type === 'tool_use' && block.id) {
                  collected.push({ type: 'tool_use_end', id: block.id });
                }
              } else if (type === 'message_delta') {
                const delta = payload.delta as { stop_reason?: string };
                const usage = payload.usage as { output_tokens?: number } | undefined;
                if (delta.stop_reason) stopReason = delta.stop_reason;
                if (usage?.output_tokens !== undefined) {
                  collected.push({ type: 'usage', inputTokens: 0, outputTokens: usage.output_tokens });
                }
              } else if (type === 'message_stop') {
                const normalizedStop = (['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'cancelled'].includes(stopReason)
                  ? stopReason
                  : 'end_turn') as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'cancelled';
                collected.push({ type: 'message_stop', stopReason: normalizedStop });
              }
            }
          });
          res.on('end', () => resolve(collected));
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(bodyStr);
      req.end();

      signal?.addEventListener('abort', () => {
        req.destroy();
        reject(new ProviderError('Aborted', 0, 'anthropic'));
      });
    });

    if (retryAfter > 0) {
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return 'retry';
    }

    for (const chunk of chunks) {
      yield chunk;
    }
    return 'done';
  }

  private async _getApiKey(): Promise<string> {
    const key = await this._secrets.get('opencode.anthropicApiKey');
    if (!key) throw new ProviderError('Anthropic API key not configured. Run "opencode: Configure AI Provider".', 401, 'anthropic');
    return key;
  }
}
