/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for session-init refresh helpers extracted from the extension entrypoint.
 */

import type { PostSessionInitParams } from "./extension-host";
import type { FileItem, SessionInitPayload } from "./protocol";

/** Parameters required to rebuild file/change state and post a fresh provider session-init payload. */
export type PostProviderSessionInitParams = Readonly<{
  /** Refreshes status bar items before the UI snapshot is sent. */
  updateWorkbenchChrome: () => void;
  /** Refreshes extension tool group state before building the payload. */
  refreshExtensionToolGroups: () => void;
  /** Reads the current workspace files shown in the webview picker. */
  getWorkspaceFiles: () => Promise<SessionInitPayload["files"]>;
  /** Builds the current tracked-change summary for the session. */
  buildChangeSummaryPayload: () => SessionInitPayload["changeSummary"];
  /** Refreshes native shell views using the latest files and change summary. */
  refreshNativeShellViews: (
    files: readonly FileItem[],
    changeSummary: SessionInitPayload["changeSummary"],
  ) => Promise<void>;
  /** Base session-init parameters, excluding fields rebuilt by the helper itself. */
  postSessionInitParams: Omit<PostSessionInitParams, "files" | "changeSummary">;
}>;
