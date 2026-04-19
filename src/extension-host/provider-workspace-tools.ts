/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound workspace tooling actions extracted from the extension entrypoint.
 */

import type {
  ProviderWorkspaceToolActionBindings,
  ProviderWorkspaceToolActions,
} from "../shared/workspace-tooling";
import { startFrontendPreviewSession } from "./frontend-preview";
import {
  activateExtensionToolsTool,
  refreshExtensionToolGroups,
  searchExtensionToolsTool,
} from "./extension-tool-catalog";
import {
  executeExtensionCommandTool,
  findReferencesTool,
  invokeLanguageModelToolTool,
  openDrawioDiagramTool,
  openTrackedDiff,
  openTrackedDiffTool,
  openWorkspaceFile,
  resolveWorkspaceFilePath,
  revealFile,
  showProblemsTool,
  workspaceSearchTool,
} from "./workspace-tooling";

/** Builds provider-bound workspace tooling actions from provider-owned state accessors and callbacks. */
export function createProviderWorkspaceToolActions(
  bindings: ProviderWorkspaceToolActionBindings,
): ProviderWorkspaceToolActions {
  const openProviderTrackedDiff: ProviderWorkspaceToolActions["openTrackedDiff"] =
    async (filePath) => {
      await openTrackedDiff({
        filePath,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
        appendLog: bindings.appendLog,
        postMessage: bindings.postMessage,
      });
    };

  return {
    resolveWorkspaceFilePath: (filePath) =>
      resolveWorkspaceFilePath(bindings.workspacePath, filePath),
    openWorkspaceFile: async (filePath) => {
      await openWorkspaceFile(bindings.workspacePath, filePath);
    },
    revealFile: async (filePath, range) => {
      await revealFile(filePath, range);
    },
    openTrackedDiff: openProviderTrackedDiff,
    openTrackedDiffTool: async (filePath) =>
      openTrackedDiffTool({
        workspacePath: bindings.workspacePath,
        filePath,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
        openTrackedDiff: openProviderTrackedDiff,
      }),
    startFrontendPreviewTool: async (options) => {
      try {
        const candidate = await startFrontendPreviewSession(
          bindings.workspacePath,
          {
            interactive: false,
            query: options?.query,
          },
        );
        if (!candidate) {
          return Object.freeze({
            success: false,
            content: "",
            error: "Frontend preview startup was cancelled.",
          });
        }
        return Object.freeze({
          success: true,
          content:
            `Started frontend preview for ${candidate.label} at ${candidate.previewUrl} using ${candidate.commandText} in ${candidate.relativePath}.`,
          meta: Object.freeze({
            label: candidate.label,
            relativePath: candidate.relativePath,
            previewUrl: candidate.previewUrl,
            commandText: candidate.commandText,
            packageManager: candidate.packageManager,
            scriptName: candidate.scriptName,
            operation: "frontend_preview_start",
          }),
        });
      } catch (error) {
        return Object.freeze({
          success: false,
          content: "",
          error: `Frontend preview failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    openDrawioDiagramTool: async (filePath) =>
      openDrawioDiagramTool(
        bindings.workspacePath,
        filePath,
        bindings.asWorkspaceRelative,
        bindings.appendLog,
      ),
    showProblemsTool: async (filePath) =>
      showProblemsTool({
        workspacePath: bindings.workspacePath,
        filePath,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
      }),
    workspaceSearchTool: async (query, options) =>
      workspaceSearchTool({
        workspacePath: bindings.workspacePath,
        query,
        options,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
      }),
    findReferencesTool: async (filePath, options) =>
      findReferencesTool({
        workspacePath: bindings.workspacePath,
        filePath,
        options,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
      }),
    executeExtensionCommandTool: async (commandId, title, extensionId) =>
      executeExtensionCommandTool({
        commandId,
        title,
        extensionId,
        appendLog: bindings.appendLog,
      }),
    invokeLanguageModelToolTool: async (toolName, title, extensionId, input) =>
      invokeLanguageModelToolTool({
        toolName,
        title,
        extensionId,
        input,
        appendLog: bindings.appendLog,
      }),
    refreshExtensionToolGroups: () => {
      bindings.setExtensionToolGroups(
        refreshExtensionToolGroups(bindings.extensionId),
      );
    },
    searchExtensionToolsTool: async (query, maxResults = 8) =>
      searchExtensionToolsTool({
        extensionId: bindings.extensionId,
        query,
        maxResults,
        extensionToolToggles: bindings.getExtensionToolToggles(),
        setExtensionToolGroups: bindings.setExtensionToolGroups,
      }),
    activateExtensionToolsTool: async (toolKeys) =>
      activateExtensionToolsTool({
        extensionId: bindings.extensionId,
        toolKeys,
        extensionToolToggles: bindings.getExtensionToolToggles(),
        applyExtensionToolToggles: bindings.applyExtensionToolToggles,
        setExtensionToolGroups: bindings.setExtensionToolGroups,
      }),
  };
}
