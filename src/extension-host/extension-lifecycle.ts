/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Extension activation and Figma bridge lifecycle helpers extracted from the extension entrypoint.
 */

import * as vscode from "vscode";
import { getConfigDir } from "../config/manager";
import { getProjectStorageInfo } from "../context/project-store";
import {
  appendFigmaImport,
  buildFigmaClipboardToken,
} from "../figma/design-store";
import { startFigmaBridgeServer } from "../figma/bridge-server";
import {
  FIGMA_BRIDGE_HOST,
  FIGMA_BRIDGE_PORT,
  GALAXY_CONFIGURATION_SECTION,
  QUALITY_FULL_ACCESS_SETTING_KEY,
  QUALITY_REVIEW_SETTING_KEY,
  QUALITY_VALIDATE_SETTING_KEY,
  TOGGLE_REVIEW_COMMAND_ID,
  TOGGLE_VALIDATION_COMMAND_ID,
} from "../shared/constants";
import type {
  ActivateExtensionParams,
  HandleImportedFigmaDesign,
} from "../shared/extension-lifecycle";
import type { FigmaBridgeServer, FigmaImportRecord } from "../shared/figma";
import { openGalaxyConfigDir } from "./utils";

let figmaBridge: FigmaBridgeServer | null = null;

/**
 * Registers Galaxy commands, status items, webview view provider, and bridge lifecycle hooks.
 *
 * @param params Shared activation callbacks and extension registration state.
 */
export function activateExtension(params: ActivateExtensionParams): void {
  const outputChannel = vscode.window.createOutputChannel("Galaxy Code");
  outputChannel.appendLine(
    `[${new Date().toTimeString().slice(0, 8)}] [info] Galaxy Code logs initialized.`,
  );
  const runStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    103,
  );
  runStatusItem.name = "Galaxy Code Run Status";
  runStatusItem.command = "galaxy-code.openLogs";
  runStatusItem.show();

  const agentStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    102,
  );
  agentStatusItem.name = "Galaxy Code Agent";
  agentStatusItem.command = "galaxy-code.switchAgent";
  agentStatusItem.show();

  const approvalStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    101,
  );
  approvalStatusItem.name = "Galaxy Code Approval Mode";
  approvalStatusItem.command = "galaxy-code.openConfig";
  approvalStatusItem.show();

  const sidebarProvider = params.createSidebarProvider({
    outputChannel,
    runStatusItem,
    agentStatusItem,
    approvalStatusItem,
  });
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    params.viewType,
    sidebarProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );
  const openChat = vscode.commands.registerCommand(
    "galaxy-code.openChat",
    () => {
      void sidebarProvider.reveal();
    },
  );
  const openChatRight = vscode.commands.registerCommand(
    "galaxy-code.openChatRight",
    () => {
      void sidebarProvider.openChatRight();
    },
  );
  const clearHistory = vscode.commands.registerCommand(
    "galaxy-code.clearHistory",
    () => {
      params.clearCurrent();
    },
  );
  const openConfig = vscode.commands.registerCommand(
    "galaxy-code.openConfig",
    async () => {
      try {
        await openGalaxyConfigDir(getConfigDir());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          `Failed to open Galaxy Code config folder: ${message}`,
        );
      }
    },
  );
  const switchAgent = vscode.commands.registerCommand(
    "galaxy-code.switchAgent",
    async () => {
      await sidebarProvider.showAgentQuickPick();
    },
  );
  const openLogs = vscode.commands.registerCommand(
    "galaxy-code.openLogs",
    async () => {
      await sidebarProvider.openRuntimeLogs();
    },
  );
  const openTelemetrySummary = vscode.commands.registerCommand(
    "galaxy-code.openTelemetrySummary",
    async () => {
      await sidebarProvider.openTelemetrySummary();
    },
  );
  const toggleReview = vscode.commands.registerCommand(
    TOGGLE_REVIEW_COMMAND_ID,
    async () => {
      await sidebarProvider.toggleReviewPreference();
    },
  );
  const toggleValidation = vscode.commands.registerCommand(
    TOGGLE_VALIDATION_COMMAND_ID,
    async () => {
      await sidebarProvider.toggleValidationPreference();
    },
  );
  const qualitySettingsSync = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (
        event.affectsConfiguration(
          `${GALAXY_CONFIGURATION_SECTION}.${QUALITY_REVIEW_SETTING_KEY}`,
        ) ||
        event.affectsConfiguration(
          `${GALAXY_CONFIGURATION_SECTION}.${QUALITY_VALIDATE_SETTING_KEY}`,
        ) ||
        event.affectsConfiguration(
          `${GALAXY_CONFIGURATION_SECTION}.${QUALITY_FULL_ACCESS_SETTING_KEY}`,
        )
      ) {
        void sidebarProvider.handleVsCodeQualitySettingsChange();
      }
    },
  );

  void sidebarProvider.syncQualityPreferencesToVsCodeSettings();
  void ensureFigmaBridgeStarted(params.handleImportedFigmaDesign, false);

  params.context.subscriptions.push(
    outputChannel,
    runStatusItem,
    agentStatusItem,
    approvalStatusItem,
    sidebarRegistration,
    openChat,
    openChatRight,
    clearHistory,
    openConfig,
    switchAgent,
    openLogs,
    openTelemetrySummary,
    toggleReview,
    toggleValidation,
    qualitySettingsSync,
    {
      dispose() {
        void stopFigmaBridgeServer(false);
      },
    },
  );
}

/** Stops the hosted Figma bridge during extension deactivation. */
export function deactivateExtension(): void {
  void stopFigmaBridgeServer(false);
}

/**
 * Starts the hosted Figma bridge when it is not already running.
 *
 * @param handleImportedFigmaDesign Callback that surfaces an imported Figma record into the live provider.
 * @param showFeedback Whether VS Code should show user-facing bridge startup status messages.
 */
async function ensureFigmaBridgeStarted(
  handleImportedFigmaDesign: HandleImportedFigmaDesign,
  showFeedback: boolean,
): Promise<void> {
  if (figmaBridge) {
    if (showFeedback) {
      vscode.window.showInformationMessage(
        `Galaxy Code Figma Bridge is already running at http://${figmaBridge.host}:${figmaBridge.port}`,
      );
    }
    return;
  }

  try {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const storageWorkspacePath =
      workspacePath ??
      vscode.Uri.joinPath(
        vscode.Uri.file(require("node:os").homedir()),
        ".galaxy",
        "__vscode-no-workspace__",
      ).fsPath;
    figmaBridge = await startFigmaBridgeServer({
      onImport: async (payload) => {
        const record = appendFigmaImport(storageWorkspacePath, payload);
        const storage = getProjectStorageInfo(storageWorkspacePath);
        await vscode.env.clipboard.writeText(
          buildFigmaClipboardToken(record.importId),
        );
        const surfacedInView = handleImportedFigmaDesign(record);
        if (!surfacedInView) {
          void vscode.window.showInformationMessage(
            `Galaxy Code received a Figma import and copied its token to the clipboard: ${record.summary}`,
          );
        }
        return Object.freeze({
          importId: record.importId,
          storedAt: storage.figmaImportsPath,
          summary: record.summary,
        });
      },
    });

    if (showFeedback) {
      vscode.window.showInformationMessage(
        `Galaxy Code Figma Bridge started at http://${FIGMA_BRIDGE_HOST}:${FIGMA_BRIDGE_PORT}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (showFeedback) {
      vscode.window.showErrorMessage(
        `Failed to start Galaxy Code Figma Bridge: ${message}`,
      );
    }
  }
}

/**
 * Stops the hosted Figma bridge when it is running.
 *
 * @param showFeedback Whether VS Code should show user-facing bridge shutdown status messages.
 */
async function stopFigmaBridgeServer(showFeedback: boolean): Promise<void> {
  if (!figmaBridge) {
    if (showFeedback) {
      vscode.window.showInformationMessage(
        "Galaxy Code Figma Bridge is not running.",
      );
    }
    return;
  }

  const current = figmaBridge;
  figmaBridge = null;
  await current.stop();
  if (showFeedback) {
    vscode.window.showInformationMessage("Galaxy Code Figma Bridge stopped.");
  }
}
