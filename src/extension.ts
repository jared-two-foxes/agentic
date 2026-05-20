import * as vscode from "vscode";
import { ChatPanel } from "./panel/ChatPanel";
import { ServerManager } from "./server";

let serverManager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, provider)
  );

  serverManager = new ServerManager();
  serverManager.start().catch(() => {});
}

export function deactivate(): Promise<void> | void {
  return serverManager?.stop();
}
