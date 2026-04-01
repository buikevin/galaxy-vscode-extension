/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Workspace file selection, change-summary, and native shell view synchronization extracted from the extension host entrypoint.
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import { getSessionChangeSummary } from "../runtime/session-tracker";
import {
  CHANGED_FILES_VIEW_ID,
  GALAXY_VIEW_CONTAINER_ID,
} from "../shared/constants";
import type {
  ChangeSummary,
  ChangedFileSummary as ChangedFileSummaryPayload,
  FileItem,
} from "../shared/protocol";
import type {
  FileSelectionUpdate,
  NativeShellViews,
  WorkspaceSyncCallbacks,
} from "../shared/extension-host";

/** Builds the current session change-summary payload for the webview and tree views. */
export function buildChangeSummaryPayload(
  asWorkspaceRelative: (filePath: string) => string,
): ChangeSummary {
  const summary = getSessionChangeSummary();
  return Object.freeze({
    fileCount: summary.fileCount,
    createdCount: summary.createdCount,
    addedLines: summary.addedLines,
    deletedLines: summary.deletedLines,
    files: Object.freeze(
      summary.files.map(
        (file): ChangedFileSummaryPayload =>
          Object.freeze({
            filePath: file.filePath,
            label: asWorkspaceRelative(file.filePath),
            language: file.language,
            wasNew: file.wasNew,
            addedLines: file.addedLines,
            deletedLines: file.deletedLines,
            originalContent: file.originalContent,
            currentContent: file.currentContent,
            diffText: file.diffText,
          }),
      ),
    ),
  });
}

/** Posts one refreshed change-summary payload into the webview. */
export async function postChangeSummary(
  postMessage: WorkspaceSyncCallbacks["postMessage"],
  changeSummary: ChangeSummary,
): Promise<void> {
  await postMessage({
    type: "change-summary-updated",
    payload: changeSummary,
  });
}

/** Builds the current session change-summary payload using provider-owned sync callbacks. */
export function buildProviderChangeSummaryPayload(
  callbacks: Pick<WorkspaceSyncCallbacks, "asWorkspaceRelative">,
): ChangeSummary {
  return buildChangeSummaryPayload(callbacks.asWorkspaceRelative);
}

/** Posts a refreshed change summary using provider-owned sync callbacks. */
export async function postProviderChangeSummary(
  callbacks: Pick<WorkspaceSyncCallbacks, "postMessage">,
  changeSummary: ChangeSummary,
): Promise<void> {
  await postChangeSummary(callbacks.postMessage, changeSummary);
}

/** Refreshes the native file and changed-file tree views from current session state. */
export async function refreshNativeShellViews(
  nativeShellViews: NativeShellViews | null,
  files: readonly FileItem[],
  changeSummary: ChangeSummary,
): Promise<void> {
  if (!nativeShellViews) {
    return;
  }

  const selectedFileCount = files.filter((file) => file.selected).length;

  nativeShellViews.contextFilesProvider.setFiles(files);
  nativeShellViews.contextFilesView.description =
    files.length > 0
      ? `${selectedFileCount}/${files.length} selected`
      : undefined;
  nativeShellViews.contextFilesView.message =
    files.length === 0 ? "No workspace files found." : undefined;
  nativeShellViews.contextFilesView.badge =
    selectedFileCount > 0
      ? {
          value: selectedFileCount,
          tooltip: `${selectedFileCount} file(s) selected for prompt context.`,
        }
      : undefined;

  nativeShellViews.changedFilesProvider.setFiles(changeSummary.files);
  nativeShellViews.changedFilesView.description =
    changeSummary.fileCount > 0
      ? `+${changeSummary.addedLines} -${changeSummary.deletedLines}`
      : undefined;
  nativeShellViews.changedFilesView.message =
    changeSummary.fileCount === 0
      ? "No tracked changes in this session."
      : undefined;
  nativeShellViews.changedFilesView.badge =
    changeSummary.fileCount > 0
      ? {
          value: changeSummary.fileCount,
          tooltip: `${changeSummary.fileCount} tracked file change(s) are ready for review.`,
        }
      : undefined;
}

/** Refreshes native shell views using provider-owned sync callbacks and optional precomputed state. */
export async function refreshProviderNativeShellViews(
  callbacks: Pick<
    WorkspaceSyncCallbacks,
    "nativeShellViews" | "getWorkspaceFiles" | "asWorkspaceRelative"
  >,
  files?: readonly FileItem[],
  changeSummary?: ChangeSummary,
): Promise<void> {
  const nextFiles = files ?? (await callbacks.getWorkspaceFiles());
  const nextChangeSummary =
    changeSummary ?? buildChangeSummaryPayload(callbacks.asWorkspaceRelative);
  await refreshNativeShellViews(
    callbacks.nativeShellViews,
    nextFiles,
    nextChangeSummary,
  );
}

/** Applies file selection changes from the webview and syncs native views plus webview state. */
export async function updateContextFileSelection(
  callbacks: WorkspaceSyncCallbacks,
  updates: readonly FileSelectionUpdate[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  for (const update of updates) {
    const filePath = callbacks.resolveWorkspaceFilePath(update.filePath);
    if (update.selected) {
      callbacks.selectedFiles.add(filePath);
    } else {
      callbacks.selectedFiles.delete(filePath);
    }
  }

  const files = await callbacks.getWorkspaceFiles();
  const changeSummary = buildChangeSummaryPayload(
    callbacks.asWorkspaceRelative,
  );
  await refreshNativeShellViews(
    callbacks.nativeShellViews,
    files,
    changeSummary,
  );
  await callbacks.postMessage({
    type: "files-updated",
    payload: { files },
  });
  await callbacks.postMessage({
    type: "selection-updated",
    payload: { selectedFiles: [...callbacks.selectedFiles] },
  });
}

/** Refreshes file selections, changed-file views, and change-summary state after workspace changes. */
export async function refreshWorkspaceFiles(
  callbacks: WorkspaceSyncCallbacks,
): Promise<void> {
  for (const selectedPath of [...callbacks.selectedFiles]) {
    if (!fs.existsSync(selectedPath)) {
      callbacks.selectedFiles.delete(selectedPath);
    }
  }

  const files = await callbacks.getWorkspaceFiles();
  const changeSummary = buildChangeSummaryPayload(
    callbacks.asWorkspaceRelative,
  );
  await refreshNativeShellViews(
    callbacks.nativeShellViews,
    files,
    changeSummary,
  );
  await callbacks.postMessage({
    type: "files-updated",
    payload: { files },
  });
  await callbacks.postMessage({
    type: "selection-updated",
    payload: { selectedFiles: [...callbacks.selectedFiles] },
  });
  await postChangeSummary(callbacks.postMessage, changeSummary);
}

/** Focuses the changed-files tree view and optionally reveals one changed file entry. */
export async function focusChangedFilesView(
  nativeShellViews: NativeShellViews | null,
  file?: ChangedFileSummaryPayload,
): Promise<void> {
  await vscode.commands.executeCommand(
    `workbench.view.extension.${GALAXY_VIEW_CONTAINER_ID}`,
  );
  await vscode.commands.executeCommand(`${CHANGED_FILES_VIEW_ID}.focus`);

  if (!file || !nativeShellViews) {
    return;
  }

  try {
    await nativeShellViews.changedFilesView.reveal(file, {
      focus: true,
      select: true,
    });
  } catch {
    // ignore reveal failures when the view has not resolved its current tree state yet
  }
}

/** Focuses the changed-files view using provider-owned sync callbacks. */
export async function focusProviderChangedFilesView(
  callbacks: Pick<WorkspaceSyncCallbacks, "nativeShellViews">,
  file?: ChangedFileSummaryPayload,
): Promise<void> {
  await focusChangedFilesView(callbacks.nativeShellViews, file);
}

/** Opens the legacy changed-files review flow used by the native review command. */
export async function openLegacyChangedFilesReview(
  callbacks: WorkspaceSyncCallbacks,
): Promise<void> {
  const changeSummary = buildChangeSummaryPayload(
    callbacks.asWorkspaceRelative,
  );
  const files = await callbacks.getWorkspaceFiles();
  await refreshNativeShellViews(
    callbacks.nativeShellViews,
    files,
    changeSummary,
  );

  if (changeSummary.fileCount === 0) {
    void vscode.window.showInformationMessage(
      "No tracked changes to review in this session.",
    );
    return;
  }

  if (changeSummary.fileCount === 1) {
    const [file] = changeSummary.files;
    if (file) {
      await focusChangedFilesView(callbacks.nativeShellViews, file);
      await callbacks.openTrackedDiff(file.filePath);
    }
    return;
  }

  const [firstFile] = changeSummary.files;
  await focusChangedFilesView(callbacks.nativeShellViews, firstFile);
  void vscode.window.showInformationMessage(
    `Review the ${changeSummary.fileCount} changed files in the Changed Files view.`,
  );
}
