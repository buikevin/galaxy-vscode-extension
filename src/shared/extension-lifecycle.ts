/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared lifecycle contracts for extension activation and hosted bridge startup.
 */

import type * as vscode from "vscode";
import type { FigmaImportRecord } from "./figma";
import type { GalaxyWorkbenchChrome } from "./extension-host";
import type { LocalAttachmentPayload } from "./protocol";

/** Provider surface required by extension activation command wiring. */
export type SidebarProviderLifecycle = vscode.WebviewViewProvider & {
  /** Reveals the sidebar-hosted Galaxy chat view. */
  reveal(): Promise<void>;
  /** Opens the Galaxy chat webview tab in the current editor group. */
  openChatTab(): Promise<void>;
  /** Mirrors the current quality preferences into VS Code settings. */
  syncQualityPreferencesToVsCodeSettings(): Promise<void>;
  /** Reacts to external VS Code settings changes affecting quality preferences. */
  handleVsCodeQualitySettingsChange(): Promise<void>;
  /** Toggles review preference from the command palette. */
  toggleReviewPreference(): Promise<void>;
  /** Toggles validation preference from the command palette. */
  toggleValidationPreference(): Promise<void>;
  /** Shows the agent selection quick pick. */
  showAgentQuickPick(): Promise<void>;
  /** Opens the runtime log view. */
  openRuntimeLogs(): Promise<void>;
  /** Opens the telemetry summary view. */
  openTelemetrySummary(): Promise<void>;
  /** Surfaces one draft local attachment into the active composer. */
  surfaceDraftLocalAttachment(
    attachment: LocalAttachmentPayload,
  ): Promise<void>;
};

/** Callback used when a Figma import is surfaced back into the provider. */
export type HandleImportedFigmaDesign = (record: FigmaImportRecord) => boolean;

/** Parameters required to activate the extension workbench surface. */
export type ActivateExtensionParams = Readonly<{
  /** Extension context used to register commands, views, and disposables. */
  context: vscode.ExtensionContext;
  /** Registered webview view type for the Galaxy sidebar. */
  viewType: string;
  /** Creates the singleton sidebar provider from the assembled workbench chrome. */
  createSidebarProvider: (
    chrome: GalaxyWorkbenchChrome,
  ) => SidebarProviderLifecycle;
  /** Clears the current provider-backed chat session history. */
  clearCurrent: () => void;
  /** Surfaces one imported Figma design into the live provider when possible. */
  handleImportedFigmaDesign: HandleImportedFigmaDesign;
}>;
