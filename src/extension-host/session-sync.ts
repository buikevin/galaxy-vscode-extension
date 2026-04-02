/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Webview message fan-out and session-init synchronization extracted from the extension host entrypoint.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadProjectMeta } from "../context/project-store";
import type {
  FileItem,
  HostMessage,
  SessionInitPayload,
} from "../shared/protocol";
import type { PostSessionInitParams } from "../shared/extension-host";
import type { PostProviderSessionInitParams } from "../shared/session-sync";
import { buildSessionInitPayload } from "./workbench-state";

/**
 * Broadcasts one host message to every live Galaxy webview target.
 *
 * @param targets Live webview instances owned by the sidebar and optional panel.
 * @param message Host message payload to broadcast.
 * @returns A promise that resolves after every target receives the message.
 */
export async function postHostMessage(
  targets: readonly vscode.Webview[],
  message: HostMessage,
): Promise<void> {
  if (targets.length === 0) {
    return;
  }
  await Promise.all(targets.map((target) => target.postMessage(message)));
}

/**
 * Returns the current workspace name shown in the Galaxy webview header.
 *
 * @returns Active workspace folder name or a fallback label when no folder is open.
 */
export function getWorkspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? "Workspace";
}

/** Returns the active workspace folder path used by Galaxy runtime helpers. */
export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolves the stable workspace storage path, including the no-folder fallback. */
export function resolveStorageWorkspacePath(): string {
  return (
    getWorkspaceRoot() ??
    path.join(os.homedir(), ".galaxy", "__vscode-no-workspace__")
  );
}

/**
 * Lists workspace files for the Galaxy file picker and preserves the active editor selection.
 *
 * @param selectedFiles Mutable selected-file set maintained by the provider.
 * @param asWorkspaceRelative Formatter used to build display labels.
 * @returns Sorted workspace file entries for the webview picker.
 */
export async function getWorkspaceFiles(
  selectedFiles: Set<string>,
  asWorkspaceRelative: (filePath: string) => string,
): Promise<readonly FileItem[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const activePath =
    vscode.window.activeTextEditor?.document.uri.scheme === "file"
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : "";

  if (activePath) {
    selectedFiles.add(activePath);
  }

  const uris = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,dist,out,.git,.next,.nuxt,coverage,.turbo,build}/**",
    250,
  );

  return uris
    .filter((uri) => uri.scheme === "file")
    .map((uri) => uri.fsPath)
    .sort((left, right) =>
      asWorkspaceRelative(left).localeCompare(asWorkspaceRelative(right)),
    )
    .map((filePath) => ({
      path: filePath,
      label: asWorkspaceRelative(filePath),
      selected: selectedFiles.has(filePath),
    }));
}

/** Converts one absolute file path into the shortest workspace-relative label available. */
export function asWorkspaceRelativePath(filePath: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (!folder) {
    return path.basename(filePath);
  }

  return path.relative(folder.uri.fsPath, filePath) || path.basename(filePath);
}

/**
 * Rebuilds the webview session snapshot and posts it to every live view.
 *
 * @param params Session-init data and helpers required to sanitize and post the payload.
 * @returns A promise that resolves after the session-init message is posted.
 */
export async function postSessionInit(
  params: PostSessionInitParams,
): Promise<void> {
  const meta = loadProjectMeta(params.projectStorage);
  const payload: SessionInitPayload = buildSessionInitPayload({
    workspaceName: getWorkspaceName(),
    files: params.files,
    messages: params.messages.map((message) =>
      params.sanitizeChatMessageForWebview(message),
    ),
    selectedAgent: params.selectedAgent,
    isRunning: params.isRunning,
    statusText: params.statusText,
    planItems: params.planItems,
    logs: params.logs,
    qualityDetails: Object.freeze({
      ...params.qualityDetails,
      reviewFindings:
        meta?.latestReviewFindings?.findings ??
        params.qualityDetails.reviewFindings ??
        Object.freeze([]),
    }),
    qualityPreferences: params.qualityPreferences,
    toolCapabilities: params.toolCapabilities,
    toolToggles: params.toolToggles,
    extensionToolGroups: params.extensionToolGroups,
    extensionToolToggles: params.extensionToolToggles,
    changeSummary: params.changeSummary,
    hasOlderMessages: params.hasOlderMessages,
    streamingAssistant: params.streamingAssistant,
    streamingThinking: params.streamingThinking,
    activeShellSessions: params.activeShellSessions,
    approvalRequest: params.approvalRequest,
  });

  await params.postMessage({ type: "session-init", payload });
}

/**
 * Refreshes host chrome, rebuilds file/change summaries, and posts a fresh session-init payload.
 *
 * @param params Provider-bound callbacks and payload fragments used to rebuild the session state.
 * @returns A promise that resolves after native views and the webview session-init payload are refreshed.
 */
export async function postProviderSessionInit(
  params: PostProviderSessionInitParams,
): Promise<void> {
  params.updateWorkbenchChrome();
  params.refreshExtensionToolGroups();
  const files = await params.getWorkspaceFiles();
  const changeSummary = params.buildChangeSummaryPayload();
  await params.refreshNativeShellViews(files, changeSummary);
  await postSessionInit({
    ...params.postSessionInitParams,
    files,
    changeSummary,
    hasOlderMessages: params.hasOlderMessages,
  });
}
