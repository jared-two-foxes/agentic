import * as vscode from "vscode";
import { ChatPanel } from "./panel/ChatPanel";
import { ServerManager } from "./server";

let serverManager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  serverManager = new ServerManager();
  const provider = new ChatPanel(context.extensionUri, serverManager, context.secrets, context);

  serverManager.onStatusChange = (status) => {
    provider.notifyStatus(status);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencode.startChat", () => {
      vscode.commands.executeCommand("opencode.chatView.focus");
    }),
    vscode.commands.registerCommand("opencode.newSession", () => {
      provider.resetSession();
      vscode.commands.executeCommand("opencode.chatView.focus");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // Reset the chat session immediately so the UI reflects the new folder,
      // then restart the server so it runs in the new workspace directory.
      provider.resetSession();
      serverManager?.restart().catch(() => {});
    })
  );

  serverManager.start().catch(() => {});
}

export function deactivate(): Promise<void> | void {
  return serverManager?.stop();
}
