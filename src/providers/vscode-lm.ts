import * as vscode from 'vscode';
import type {
  IProvider, ProviderMessage, ToolDefinition, StreamChunk, ModelInfo,
  TextDeltaChunk, ToolUseStartChunk, ToolInputDeltaChunk, ToolUseEndChunk,
  MessageStopChunk,
} from './base';
import { ProviderError } from './base';

export class VsCodeLmProvider implements IProvider {
  readonly providerID = 'vscode-lm';

  async listModels(): Promise<ModelInfo[]> {
    if (!(vscode.lm as typeof vscode.lm | undefined)?.selectChatModels) return [];
    try {
      const models = await vscode.lm.selectChatModels({});
      return models.map(m => ({
        id: m.id,
        name: m.name,
        providerID: 'vscode-lm',
        contextWindow: m.maxInputTokens,
      }));
    } catch {
      return [];
    }
  }

  async *streamCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    if (!(vscode.lm as typeof vscode.lm | undefined)?.selectChatModels) {
      throw new ProviderError('VS Code Language Model API not available. Requires VS Code 1.90+.', undefined, 'vscode-lm');
    }

    let models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
    if (!models || models.length === 0) {
      models = await vscode.lm.selectChatModels({});
    }
    const model = models?.[0];
    if (!model) {
      throw new ProviderError('No VS Code language model available. Install GitHub Copilot.', undefined, 'vscode-lm');
    }

    const cts = new vscode.CancellationTokenSource();
    signal?.addEventListener('abort', () => cts.cancel());

    const lmMessages = messagesToVsCode(messages);

    const lmTools: vscode.LanguageModelChatTool[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as vscode.LanguageModelChatTool['inputSchema'],
    }));

    try {
      const request = await model.sendRequest(
        lmMessages,
        { tools: lmTools.length > 0 ? lmTools : undefined },
        cts.token,
      );

      for await (const chunk of request.stream) {
        if (signal?.aborted) break;

        if (chunk instanceof vscode.LanguageModelTextPart) {
          yield { type: 'text_delta', delta: chunk.value } satisfies TextDeltaChunk;
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          const id = chunk.callId;
          const inputStr = JSON.stringify(chunk.input ?? {});
          yield { type: 'tool_use_start', id, name: chunk.name } satisfies ToolUseStartChunk;
          yield { type: 'tool_input_delta', id, delta: inputStr } satisfies ToolInputDeltaChunk;
          yield { type: 'tool_use_end', id } satisfies ToolUseEndChunk;
        }
      }
    } finally {
      cts.dispose();
    }

    yield { type: 'message_stop', stopReason: signal?.aborted ? 'cancelled' : 'end_turn' } satisfies MessageStopChunk;
  }
}

function messagesToVsCode(messages: ProviderMessage[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push(vscode.LanguageModelChatMessage.User(msg.content));
    } else if (msg.role === 'user') {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart> = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          parts.push(new vscode.LanguageModelTextPart(c.text));
        } else if (c.type === 'tool_result') {
          parts.push(new vscode.LanguageModelToolResultPart(
            c.toolUseId,
            [new vscode.LanguageModelTextPart(c.content)],
          ));
        }
        // image: vscode.lm does not support image parts — silently drop
      }
      out.push(vscode.LanguageModelChatMessage.User(parts));
    } else if (msg.role === 'assistant') {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart> = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          parts.push(new vscode.LanguageModelTextPart(c.text));
        } else if (c.type === 'tool_use') {
          parts.push(new vscode.LanguageModelToolCallPart(c.id, c.name, c.input));
        }
      }
      out.push(vscode.LanguageModelChatMessage.Assistant(parts));
    }
  }
  return out;
}
