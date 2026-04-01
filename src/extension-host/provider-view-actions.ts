/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound sidebar and panel webview lifecycle actions extracted from the extension host entrypoint.
 */

import * as vscode from "vscode";
import { configureChatWebview } from "./webview-view";
import type {
  ProviderViewActionBindings,
  ProviderViewActions,
} from "../shared/provider-view-actions";

/** Builds provider-bound sidebar and panel webview lifecycle actions from provider-owned state accessors and callbacks. */
export function createProviderViewActions(
  bindings: ProviderViewActionBindings,
): ProviderViewActions {
  return {
    resolveWebviewView: async (webviewView) => {
      bindings.setView(webviewView);
      webviewView.webview.html = configureChatWebview({
        extensionUri: bindings.extensionUri,
        webview: webviewView.webview,
        onMessage: bindings.onMessage,
      });
      await bindings.postInit();
    },
    reveal: async () => {
      await bindings.executeRevealSidebar();
      bindings.getView()?.show?.(true);
    },
    openChatRight: async () => {
      const activePanel = bindings.getPanel();
      if (activePanel) {
        await activePanel.reveal(vscode.ViewColumn.Beside);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        "galaxy-code.chatPanel",
        "Galaxy Code",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(bindings.extensionUri, "dist"),
          ],
        },
      );

      bindings.setPanel(panel);
      panel.webview.html = configureChatWebview({
        extensionUri: bindings.extensionUri,
        webview: panel.webview,
        onMessage: bindings.onMessage,
      });
      panel.onDidDispose(() => {
        if (bindings.getPanel() === panel) {
          bindings.setPanel(null);
        }
      });

      await bindings.postInit();
    },
  };
}
