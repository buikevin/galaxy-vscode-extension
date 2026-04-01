/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc VS Code extension entrypoint. Runtime orchestration lives in extension-host modules.
 */

import type * as vscode from "vscode";
import {
  activateExtension as activateHostedExtension,
  deactivateExtension as deactivateHostedExtension,
} from "./extension-host/extension-lifecycle";
import { GalaxyChatViewProvider } from "./extension-host/galaxy-chat-view-provider";

/** Registers the provider, commands, status items, and bridge lifecycle for the extension. */
export function activate(context: vscode.ExtensionContext): void {
  activateHostedExtension({
    context,
    viewType: GalaxyChatViewProvider.viewType,
    createSidebarProvider: (chrome) =>
      GalaxyChatViewProvider.create(context, chrome),
    clearCurrent: () => GalaxyChatViewProvider.clearCurrent(),
    handleImportedFigmaDesign: (record) =>
      GalaxyChatViewProvider.handleImportedFigmaDesign(record),
  });
}

/** Tears down hosted extension resources created during activation. */
export function deactivate(): void {
  deactivateHostedExtension();
}
