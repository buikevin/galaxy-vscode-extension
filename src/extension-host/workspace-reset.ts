/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Workspace session reset and cleanup helpers extracted from the extension host entrypoint.
 */

import * as fs from "node:fs";
import type {
  ResetWorkspaceSessionOptions,
  WorkspaceResetCallbacks,
} from "../shared/workspace-reset";

/** Resets in-memory and persisted workspace session state back to the host defaults. */
export function resetWorkspaceSession(
  callbacks: WorkspaceResetCallbacks,
  opts?: ResetWorkspaceSessionOptions,
): void {
  if (opts?.removeProjectDir) {
    try {
      fs.rmSync(callbacks.projectDirPath, {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore project storage cleanup failures
    }
    callbacks.recreateProjectStorageState();
  } else {
    callbacks.clearUiTranscript();
  }

  callbacks.clearHistory();
  callbacks.clearActionApprovals();
  callbacks.clearRuntimeSession();
  callbacks.resetRuntimeLogs();
  callbacks.resetQualityDetails();
  callbacks.resetMessages();
  callbacks.setIsRunning(false);
  callbacks.clearPendingApprovalState();
  callbacks.clearProgressReporter();
  callbacks.clearShellState();
  try {
    fs.rmSync(callbacks.commandContextPath, { force: true });
  } catch {
    // ignore context cleanup failures
  }
  callbacks.clearStreamingBuffers();
  callbacks.updateWorkbenchChrome();
}
