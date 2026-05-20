import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencode.chatView";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const distWebviewUri = vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "webview"
    );
    const baseUri = webview.asWebviewUri(distWebviewUri).toString();

    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "dist",
      "webview",
      "index.html"
    );

    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace relative asset paths with webview URIs
    html = html.replace(/src="\.\//g, `src="${baseUri}/`);
    html = html.replace(/href="\.\//g, `href="${baseUri}/`);

    // Inject nonce into all <script> tags
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);

    // Replace or insert CSP meta tag
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} https:`,
    ].join("; ");

    if (html.includes("http-equiv=\"Content-Security-Policy\"")) {
      html = html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`
      );
    } else {
      html = html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`
      );
    }

    return html;
  }
}
