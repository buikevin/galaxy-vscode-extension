/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound workspace tooling wrappers extracted from the extension entrypoint.
 */

import type { ToolResult } from "../tools/entities/file-tools";
import type {
  ExecuteExtensionCommandRequest,
  FindReferencesRequest,
  InvokeLanguageModelToolRequest,
  OpenTrackedDiffRequest,
  OpenTrackedDiffToolRequest,
  ShowProblemsRequest,
  WorkspaceFileRevealRange,
  WorkspaceSearchRequest,
} from "../shared/workspace-tooling";
import {
  executeExtensionCommandTool as executeNativeExtensionCommandTool,
  findReferencesTool as findNativeReferencesTool,
  invokeLanguageModelToolTool as invokeNativeLanguageModelTool,
  openDrawioDiagramTool as openNativeDrawioDiagramTool,
  openTrackedDiff as openNativeTrackedDiff,
  openTrackedDiffTool as openNativeTrackedDiffTool,
  openWorkspaceFile as openNativeWorkspaceFile,
  resolveWorkspaceFilePath as resolveNativeWorkspaceFilePath,
  revealFile as revealNativeFile,
  showProblemsTool as showNativeProblemsTool,
  workspaceSearchTool as runNativeWorkspaceSearchTool,
} from "./vscode-tooling";

/** Resolves a possibly relative workspace file path against the active workspace root. */
export function resolveWorkspaceFilePath(
  workspacePath: string,
  filePath: string,
): string {
  return resolveNativeWorkspaceFilePath(workspacePath, filePath);
}

/** Opens one workspace file in a standard editor tab. */
export async function openWorkspaceFile(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  await openNativeWorkspaceFile(workspacePath, filePath);
}

/** Reveals one file and optionally focuses the requested line range. */
export async function revealFile(
  filePath: string,
  range?: WorkspaceFileRevealRange,
): Promise<void> {
  await revealNativeFile(filePath, range);
}

/** Opens one tracked diff and routes missing-snapshot failures back through the host message channel. */
export async function openTrackedDiff(
  params: OpenTrackedDiffRequest,
): Promise<void> {
  await openNativeTrackedDiff({
    filePath: params.filePath,
    asWorkspaceRelative: params.asWorkspaceRelative,
    appendLog: params.appendLog,
    postErrorMessage: async (message) => {
      await params.postMessage({
        type: "error",
        payload: { message },
      });
    },
  });
}

/** Wraps tracked diff opening in a structured tool result contract. */
export async function openTrackedDiffTool(
  params: OpenTrackedDiffToolRequest,
): Promise<ToolResult> {
  return openNativeTrackedDiffTool(params);
}

/** Shows current diagnostics in the Problems panel and returns a summarized tool result. */
export async function showProblemsTool(
  params: ShowProblemsRequest,
): Promise<ToolResult> {
  return showNativeProblemsTool(params);
}

/** Opens one Draw.io diagram in a supported custom editor or falls back to text. */
export async function openDrawioDiagramTool(
  workspacePath: string,
  filePath: string,
  asWorkspaceRelative: (filePath: string) => string,
  appendLog: (
    level: "info" | "error" | "status" | "approval" | "review" | "validation",
    message: string,
  ) => void,
): Promise<ToolResult> {
  return openNativeDrawioDiagramTool({
    workspacePath,
    filePath,
    asWorkspaceRelative,
    appendLog,
  });
}

/** Runs one workspace search using the native VS Code search UI. */
export async function workspaceSearchTool(
  params: WorkspaceSearchRequest,
): Promise<ToolResult> {
  return runNativeWorkspaceSearchTool(params);
}

/** Finds references for one symbol location or symbol name. */
export async function findReferencesTool(
  params: FindReferencesRequest,
): Promise<ToolResult> {
  return findNativeReferencesTool(params);
}

/** Executes one public extension command and returns a normalized tool result. */
export async function executeExtensionCommandTool(
  params: ExecuteExtensionCommandRequest,
): Promise<ToolResult> {
  return executeNativeExtensionCommandTool(params);
}

/** Invokes one VS Code language-model tool and returns a normalized tool result. */
export async function invokeLanguageModelToolTool(
  params: InvokeLanguageModelToolRequest,
): Promise<ToolResult> {
  return invokeNativeLanguageModelTool(params);
}
