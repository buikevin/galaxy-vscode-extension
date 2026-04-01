/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Webview HTML and message wiring helpers extracted from the extension entrypoint.
 */

import * as vscode from "vscode";
import type { WebviewMessage } from "../shared/protocol";
import { getNonce } from "./utils";

/** Builds the Galaxy chat webview HTML shell. */
export function getChatWebviewHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "chat.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "chat.css"),
  );
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Code</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      globalThis.process = globalThis.process || { env: { NODE_ENV: 'production' } };
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

/** Configures one Galaxy webview instance and wires inbound messages back to the provider. */
export function configureChatWebview(params: {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  onMessage: (message: WebviewMessage) => void;
}): string {
  params.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(params.extensionUri, "dist")],
  };
  params.webview.onDidReceiveMessage((message: WebviewMessage) => {
    params.onMessage(message);
  });
  return getChatWebviewHtml(params.extensionUri, params.webview);
}
