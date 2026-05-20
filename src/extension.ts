import * as vscode from "vscode";
import { ChatPanel } from "./panel/ChatPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, provider)
  );
}

export function deactivate(): void {}
