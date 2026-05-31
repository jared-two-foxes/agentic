import * as vscode from 'vscode';
import { ChatPanel } from './panel/ChatPanel';
import { AgentEngine } from './engine';
import { PROVIDER_IDS } from './providers/registry';
import type { ProviderID } from './providers/registry';

let engine: AgentEngine | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  engine = new AgentEngine();

  const provider = new ChatPanel(context.extensionUri, engine, context);

  engine.on('event', (event: { type: string; properties?: Record<string, unknown> }) => {
    if (event.type === 'engine.ready') {
      provider.notifyStatus({ value: 'ready' });
    } else if (event.type === 'engine.error') {
      provider.notifyStatus({
        value: 'error',
        message: String(event.properties?.message ?? 'Engine error'),
      });
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('opencode.startChat', () => {
      vscode.commands.executeCommand('opencode.chatView.focus');
    }),
    vscode.commands.registerCommand('opencode.newSession', () => {
      provider.resetSession();
      vscode.commands.executeCommand('opencode.chatView.focus');
    }),
    vscode.commands.registerCommand('opencode.maximizeChat', () => {
      provider.maximize();
    }),
    vscode.commands.registerCommand('opencode.minimizeChat', () => provider.minimize()),
    vscode.commands.registerCommand('opencode.configureProvider', async () => {
      const LABELS: Record<string, string> = {
        'vscode-lm': 'GitHub Copilot (no API key needed)',
        'anthropic': 'Anthropic (requires API key)',
        'openai-compatible': 'OpenAI-compatible (OpenAI, Ollama, Azure, LM Studio...)',
      };
      const items = PROVIDER_IDS.map(id => ({ label: LABELS[id] ?? id, id }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Select AI Provider',
        placeHolder: 'Choose the LLM provider for opencode',
      });
      if (!picked) return;

      await engine!.switchProvider(picked.id as ProviderID);

      if (picked.id === 'anthropic' || picked.id === 'openai-compatible') {
        const hasKey = await engine!.hasApiKey(picked.id);
        if (!hasKey) {
          const entered = await engine!.configureProvider(picked.id);
          if (!entered) {
            vscode.window.showWarningMessage('No API key entered — switching back to GitHub Copilot.');
            await engine!.switchProvider('vscode-lm');
            return;
          }
        }
      }

      vscode.window.showInformationMessage(`Provider switched to: ${picked.label}`);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.resetSession();
    }),
  );

  provider.notifyStatus({ value: 'connecting' });
  engine.init(context).catch((err: Error) => {
    provider.notifyStatus({ value: 'error', message: err.message });
  });
}

export function deactivate(): void {
  engine = undefined;
}
