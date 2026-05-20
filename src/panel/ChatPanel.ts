import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { OpenCodeClient } from "../client/api";
import { ServerManager, ServerStatus } from "../server";

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencode.chatView";

  private _unsubscribe: (() => void) | undefined;
  private _sessionPromise: Promise<string> | undefined;
  private _currentView: vscode.WebviewView | undefined;
  private _lastStatus: ServerStatus = { value: "connecting" };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly serverManager: ServerManager,
    private readonly secrets: vscode.SecretStorage
  ) {}

  /** Called by extension.ts when server status changes */
  notifyStatus(status: ServerStatus): void {
    this._lastStatus = status;
    if (this._currentView) {
      this._currentView.webview.postMessage({ type: "status", ...status });
    }
  }

  private _getOrCreateSession(api: OpenCodeClient): Promise<string> {
    if (!this._sessionPromise) {
      this._sessionPromise = api.createSession().catch((err) => {
        this._sessionPromise = undefined;
        throw err;
      });
    }
    return this._sessionPromise;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Tear down any previous subscription and session
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._sessionPromise = undefined;

    this._currentView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Post current server status immediately
    webviewView.webview.postMessage({ type: "status", ...this._lastStatus });

    // Read settings fresh each time the view is resolved
    const config = vscode.workspace.getConfiguration("opencode");
    const port: number = config.get("port") ?? 4096;

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string }) => {
      if (msg.type === "getStatus") {
        webviewView.webview.postMessage({ type: "status", ...this._lastStatus });
        return;
      }

      if (msg.type !== "send" || !msg.text) return;

      try {
        const password = await this.secrets.get("opencode.password") ?? "";
        const api = new OpenCodeClient(`http://localhost:${port}`, password);

        const sessionId = await this._getOrCreateSession(api);

        // Subscribe once per session
        if (!this._unsubscribe) {
          this._unsubscribe = api.subscribeEvents(sessionId, (event) => {
            webviewView.webview.postMessage(event);
            if (event.type === "session.error") {
              const errMsg = String((event.properties?.error as Record<string, unknown>)?.message ?? "Session error");
              webviewView.webview.postMessage({ type: "status", value: "error", message: errMsg });
            }
          });
        }

        await api.sendMessage(sessionId, msg.text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        webviewView.webview.postMessage({ type: "status", value: "error", message });
      }
    });

    // Clean up when the view is disposed/hidden
    webviewView.onDidDispose(() => {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
      if (this._currentView === webviewView) {
        this._currentView = undefined;
      }
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const distWebviewUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const baseUri = webview.asWebviewUri(distWebviewUri).toString();
    const htmlPath = path.join(this.extensionUri.fsPath, "dist", "webview", "index.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    html = html.replace(/src="\.\//g, `src="${baseUri}/`);
    html = html.replace(/href="\.\//g, `href="${baseUri}/`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} https:`,
    ].join("; ");
    if (html.includes('http-equiv="Content-Security-Policy"')) {
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    } else {
      html = html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    }
    return html;
  }
}
