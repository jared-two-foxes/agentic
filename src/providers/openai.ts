import * as https from 'https';
import * as http from 'http';
import type * as vscode from 'vscode';
import type {
  IProvider,
  ProviderMessage,
  ToolDefinition,
  StreamChunk,
  ModelInfo,
} from './base';
import { ProviderError } from './base';

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: object };
};

function toOpenAIMessages(messages: ProviderMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      const textParts = msg.content.filter(c => c.type !== 'tool_result');
      const toolResults = msg.content.filter(c => c.type === 'tool_result');
      if (textParts.length > 0) {
        const content: OpenAIContentPart[] = textParts.map(c => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text };
          if (c.type === 'image') return { type: 'image_url' as const, image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
          return { type: 'text' as const, text: '' };
        });
        out.push({ role: 'user', content });
      }
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          out.push({ role: 'tool', content: tr.content, tool_call_id: tr.toolUseId });
        }
      }
    } else if (msg.role === 'assistant') {
      const textContent = msg.content
        .filter(c => c.type === 'text')
        .map(c => (c.type === 'text' ? c.text : ''))
        .join('');
      const toolCalls: OpenAIToolCall[] = msg.content
        .filter(c => c.type === 'tool_use')
        .map(c => c.type === 'tool_use' ? ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }) : null)
        .filter((x): x is OpenAIToolCall => x !== null);
      out.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return out;
}

export class OpenAIProvider implements IProvider {
  readonly providerID = 'openai-compatible';
  readonly baseUrl: string;
  readonly model: string;
  private readonly _secrets: vscode.SecretStorage;

  constructor(opts: { baseUrl: string; model: string; secrets: vscode.SecretStorage }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this._secrets = opts.secrets;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const url = new URL('/models', this.baseUrl);
      const raw = await this._get(url.toString());
      const body = JSON.parse(raw) as { data?: { id: string; object: string }[] };
      return (body.data ?? [])
        .filter(m => m.object === 'model')
        .map(m => ({ id: m.id, name: m.id, providerID: 'openai-compatible' }));
    } catch {
      return [{ id: this.model, name: this.model, providerID: 'openai-compatible' }];
    }
  }

  async *streamCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = await this._secrets.get('opencode.openaiApiKey') ?? 'none';

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t): OpenAITool => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }

    const bodyStr = JSON.stringify(body);
    const url = new URL('/chat/completions', this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);

    const chunks: StreamChunk[] = await new Promise<StreamChunk[]>((resolve, reject) => {
      if (signal?.aborted) { reject(new ProviderError('Aborted', 0, 'openai-compatible')); return; }

      const reqLib = isHttps ? https : http;
      const req = reqLib.request(
        {
          hostname: url.hostname,
          port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (d: Buffer) => { errBody += d.toString(); });
            res.on('end', () => reject(new ProviderError(`OpenAI error ${res.statusCode}: ${errBody}`, res.statusCode, 'openai-compatible')));
            return;
          }

          const collected: StreamChunk[] = [];
          let buf = '';
          const toolCallMap = new Map<number, { id: string; name: string; argBuffer: string }>();
          let finishReason: string | null = null;

          res.on('data', (data: Buffer) => {
            buf += data.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (!dataStr || dataStr === '[DONE]') continue;
              let payload: {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      type?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: { prompt_tokens: number; completion_tokens: number };
              };
              try { payload = JSON.parse(dataStr); } catch { continue; }

              if (payload.usage) {
                usage = payload.usage;
              }

              const choice = payload.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) finishReason = choice.finish_reason;

              const delta = choice.delta;
              if (delta?.content) {
                collected.push({ type: 'text_delta', delta: delta.content });
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (tc.id) {
                    // First chunk for this tool call
                    const entry = { id: tc.id, name: tc.function?.name ?? '', argBuffer: tc.function?.arguments ?? '' };
                    toolCallMap.set(idx, entry);
                    collected.push({ type: 'tool_use_start', id: tc.id, name: entry.name });
                  } else {
                    const entry = toolCallMap.get(idx);
                    if (entry && tc.function?.arguments) {
                      entry.argBuffer += tc.function.arguments;
                      collected.push({ type: 'tool_input_delta', id: entry.id, delta: tc.function.arguments });
                    }
                  }
                }
              }

              if (choice.finish_reason === 'tool_calls') {
                for (const [, entry] of toolCallMap) {
                  collected.push({ type: 'tool_use_end', id: entry.id });
                }
                const normalizedStop: 'tool_use' = 'tool_use';
                collected.push({ type: 'message_stop', stopReason: normalizedStop });
              }
            }

            if (usage) {
              collected.push({ type: 'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
            }
          });

          res.on('end', () => {
            if (finishReason === 'stop' || finishReason === 'length') {
              const reason = finishReason === 'length' ? 'max_tokens' : 'end_turn';
              collected.push({ type: 'message_stop', stopReason: reason as 'end_turn' | 'max_tokens' });
            }
            resolve(collected);
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(bodyStr);
      req.end();

      signal?.addEventListener('abort', () => {
        req.destroy();
        reject(new ProviderError('Aborted', 0, 'openai-compatible'));
      });
    });

    for (const chunk of chunks) {
      yield chunk;
    }
  }

  private _get(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const reqLib = isHttps ? https : http;
      reqLib.get(url, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }).on('error', reject);
    });
  }
}
