import * as vscode from 'vscode';
import type { IProvider } from './base';
import { VsCodeLmProvider } from './vscode-lm';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export const PROVIDER_IDS = ['vscode-lm', 'anthropic', 'openai-compatible'] as const;
export type ProviderID = typeof PROVIDER_IDS[number];

export class ProviderRegistry {
  private _active: IProvider | undefined;
  private _context: vscode.ExtensionContext | undefined;
  private _onProviderChanged?: () => void;

  setProviderChangedCallback(cb: () => void): void {
    this._onProviderChanged = cb;
  }

  async init(context: vscode.ExtensionContext): Promise<void> {
    this._context = context;
    await this._instantiate();

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration('opencode.provider') ||
          e.affectsConfiguration('opencode.anthropicModel') ||
          e.affectsConfiguration('opencode.openaiBaseUrl') ||
          e.affectsConfiguration('opencode.openaiModel')
        ) {
          this._instantiate().then(() => {
            this._onProviderChanged?.();
          }).catch(() => {});
        }
      }),
    );
  }

  getActive(): IProvider {
    if (!this._active) throw new Error('ProviderRegistry not initialized');
    return this._active;
  }

  async setProvider(id: ProviderID): Promise<void> {
    await vscode.workspace.getConfiguration('opencode').update(
      'provider', id, vscode.ConfigurationTarget.Global,
    );
    await this._instantiate();
    this._onProviderChanged?.();
  }

  async promptForApiKey(providerId: 'anthropic' | 'openai-compatible'): Promise<boolean> {
    if (!this._context) return false;
    const label = providerId === 'anthropic' ? 'Anthropic API Key' : 'OpenAI-compatible API Key';
    const secretKey = providerId === 'anthropic' ? 'opencode.anthropicApiKey' : 'opencode.openaiApiKey';
    const value = await vscode.window.showInputBox({
      title: `Enter ${label}`,
      prompt: 'The key will be stored securely in VS Code Secret Storage.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!value) return false;
    await this._context.secrets.store(secretKey, value);
    await this._instantiate();
    return true;
  }

  async hasApiKey(providerId: 'anthropic' | 'openai-compatible'): Promise<boolean> {
    if (!this._context) return false;
    const secretKey = providerId === 'anthropic' ? 'opencode.anthropicApiKey' : 'opencode.openaiApiKey';
    return !!(await this._context.secrets.get(secretKey));
  }

  private async _instantiate(): Promise<void> {
    if (!this._context) return;
    const cfg = vscode.workspace.getConfiguration('opencode');
    const providerId = cfg.get<ProviderID>('provider', 'vscode-lm');

    if (providerId === 'vscode-lm') {
      this._active = new VsCodeLmProvider();
    } else if (providerId === 'anthropic') {
      const model = cfg.get<string>('anthropicModel', 'claude-opus-4-5');
      this._active = new AnthropicProvider(model, this._context.secrets);
    } else if (providerId === 'openai-compatible') {
      const baseUrl = cfg.get<string>('openaiBaseUrl', 'https://api.openai.com/v1');
      const model = cfg.get<string>('openaiModel', 'gpt-4o');
      this._active = new OpenAIProvider({ baseUrl, model, secrets: this._context.secrets });
    }
  }
}
