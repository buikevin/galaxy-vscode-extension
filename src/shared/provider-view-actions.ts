/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound sidebar and panel webview lifecycle actions.
 */

import type * as vscode from "vscode";
import type { WebviewMessage } from "./protocol";

/** Provider-owned callbacks and state accessors required to build view lifecycle actions. */
export type ProviderViewActionBindings = Readonly<{
  /** Extension URI used to resolve bundled webview assets. */
  extensionUri: vscode.Uri;
  /** Returns the currently active secondary panel, if any. */
  getPanel: () => vscode.WebviewPanel | null;
  /** Stores the active secondary panel state. */
  setPanel: (panel: vscode.WebviewPanel | null) => void;
  /** Stores the active sidebar webview view state. */
  setView: (view: vscode.WebviewView | null) => void;
  /** Handles one inbound message arriving from a sidebar or panel webview. */
  onMessage: (message: WebviewMessage) => void;
  /** Replays the full init payload into the live webview after setup. */
  postInit: () => Promise<void>;
  /** Returns the current sidebar webview view, if any. */
  getView: () => vscode.WebviewView | null;
  /** Executes the VS Code command used to reveal the Galaxy sidebar container. */
  executeRevealSidebar: () => Promise<void>;
}>;

/** Provider-bound sidebar and panel webview lifecycle actions. */
export type ProviderViewActions = Readonly<{
  /** Configures and initializes the sidebar-hosted webview view. */
  resolveWebviewView: (webviewView: vscode.WebviewView) => Promise<void>;
  /** Reveals the Galaxy sidebar and focuses the sidebar-hosted webview. */
  reveal: () => Promise<void>;
  /** Opens or reveals the secondary chat panel beside the active editor. */
  openChatRight: () => Promise<void>;
}>;
