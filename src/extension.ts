import * as vscode from "vscode";
import { ChatPanel } from "./panel/ChatPanel";
import { ServerManager } from "./server";

let serverManager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  serverManager = new ServerManager();
  const provider = new ChatPanel(context.extensionUri, serverManager, context.secrets);

  serverManager.onStatusChange = (status) => {
    provider.notifyStatus(status);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, provider),
    vscode.commands.registerCommand("opencode.startChat", () => {
      vscode.commands.executeCommand("opencode.chatView.focus");
    }),
    vscode.commands.registerCommand("opencode.newSession", () => {
      provider.resetSession();
      vscode.commands.executeCommand("opencode.chatView.focus");
    })
  );

  serverManager.start().catch(() => {});
}

export function deactivate(): Promise<void> | void {
  return serverManager?.stop();
}
