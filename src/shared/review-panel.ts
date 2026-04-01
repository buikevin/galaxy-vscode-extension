/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared callback contracts for the native Galaxy diff review panel.
 */

import type * as vscode from "vscode";
import type { ChangedFileSummary, SessionChangeSummary } from "./runtime";
import type { WebviewMessage } from "./protocol";

/** One rendered row in the native review panel diff model. */
export type ReviewRow = Readonly<Record<string, unknown>>;

/** Parameters required to build the native review panel HTML. */
export type ReviewPanelHtmlParams = Readonly<{
  /** Webview used to resolve CSP source and postback runtime. */
  webview: vscode.Webview;
  /** Session change summary currently shown in the diff panel. */
  summary: SessionChangeSummary;
  /** Formats an absolute path into a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Creates a unique id used as the inline-script nonce. */
  createMessageId: () => string;
}>;

/** Host callbacks required to open and keep the native review panel synchronized. */
export type ReviewPanelCallbacks = Readonly<{
  /** Builds the latest review panel HTML for one webview instance. */
  renderHtml: (webview: vscode.Webview) => string;
  /** Routes review panel webview messages back into the main host message handler. */
  handleMessage: (message: WebviewMessage) => Promise<void>;
  /** Refreshes tracked workspace file state before rebuilding the review panel HTML. */
  refreshWorkspaceFiles: () => Promise<void>;
}>;

/** Parameters required to open the native review panel directly from provider-owned state. */
export type OpenProviderReviewPanelParams = Readonly<{
  /** Returns the latest tracked session summary used to render the panel. */
  getSummary: () => SessionChangeSummary;
  /** Formats an absolute path into a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Creates a unique id used as the inline-script nonce. */
  createMessageId: () => string;
  /** Routes review panel webview messages back into the provider. */
  handleMessage: (message: WebviewMessage) => Promise<void>;
  /** Refreshes tracked workspace file state before rebuilding the review panel HTML. */
  refreshWorkspaceFiles: () => Promise<void>;
}>;
