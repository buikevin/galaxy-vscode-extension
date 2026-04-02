/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared callback contracts for non-chat webview actions extracted from the extension host entrypoint.
 */

import type {
  FigmaAttachment,
  HostMessage,
  LocalAttachmentPayload,
  LogEntry,
  QualityPreferences,
  ToolApprovalDecision,
  ToolCapabilities,
  ToolToggles,
  WebviewMessage,
} from "./protocol";

/** Non-chat message variants that can be routed outside the main chat-send runtime flow. */
export type RoutedWebviewMessage = Exclude<
  WebviewMessage,
  Readonly<{ type: "chat-send" }>
>;

/** Host callbacks required to route non-chat webview messages outside the main provider switch. */
export type WebviewActionCallbacks = Readonly<{
  /** Replays the full init payload into the webview after the webview reports readiness. */
  postInit: () => Promise<void>;
  /** Applies file-selection changes coming from the file picker in the webview. */
  updateContextFileSelection: (
    updates: readonly Readonly<{ filePath: string; selected: boolean }>[],
  ) => Promise<void>;
  /** Opens one workspace file in the editor. */
  openWorkspaceFile: (filePath: string) => Promise<void>;
  /** Opens one tracked diff in the native diff UI. */
  openTrackedDiff: (filePath: string) => Promise<void>;
  /** Opens one external link outside VS Code. */
  openExternalLink: (href: string) => Promise<void>;
  /** Runs one terminal snippet or command fragment requested by the webview. */
  runTerminalSnippet: (payload: { code: string; language?: string }) => void;
  /** Reveals the VS Code terminal associated with one tool call id. */
  revealShellTerminal: (toolCallId: string) => Promise<void>;
  /** Loads one older transcript batch before the oldest message currently shown in the webview. */
  loadOlderTranscriptMessages: (
    oldestMessageId?: string,
    batchSize?: number,
  ) => Promise<Readonly<{
    messages: readonly import("./protocol").ChatMessage[];
    hasOlderMessages: boolean;
  }>>;
  /** Resolves a pending approval response coming back from the webview. */
  handleApprovalResponse: (
    requestId: string,
    decision: ToolApprovalDecision,
  ) => void;
  /** Applies updated quality preferences coming from the webview. */
  applyQualityPreferences: (
    next: QualityPreferences,
    opts?: Readonly<{ syncVsCodeSettings?: boolean; logMessage?: string }>,
  ) => Promise<void>;
  /** Applies updated tool capabilities coming from the webview. */
  applyToolCapabilities: (
    next: ToolCapabilities,
    opts?: Readonly<{ logMessage?: string }>,
  ) => Promise<void>;
  /** Applies updated core tool toggles coming from the webview. */
  applyToolToggles: (
    next: ToolToggles,
    opts?: Readonly<{ logMessage?: string }>,
  ) => Promise<void>;
  /** Applies updated extension-provided tool toggles coming from the webview. */
  applyExtensionToolToggles: (
    next: Readonly<Record<string, boolean>>,
    opts?: Readonly<{ logMessage?: string }>,
  ) => Promise<void>;
  /** Executes one composer command requested by the webview. */
  handleComposerCommand: (
    commandId: "config" | "reset" | "clear",
  ) => Promise<void>;
  /** Stores one local attachment and returns the metadata that should be echoed back into the webview. */
  createDraftLocalAttachment: (payload: {
    name: string;
    mimeType: string;
    dataUrl: string;
  }) => Promise<LocalAttachmentPayload>;
  /** Posts one host-side message back into the webview. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Removes one pending local attachment from workspace storage. */
  removeDraftAttachment: (attachmentId: string) => void;
  /** Opens the native review UI for tracked file changes. */
  openNativeReview: () => Promise<void>;
  /** Dismisses one review finding. */
  dismissReviewFinding: (findingId: string) => Promise<void>;
  /** Applies one review finding. */
  applyReviewFinding: (findingId: string) => Promise<void>;
  /** Reverts every tracked file change in the current session. */
  revertAllTrackedChanges: () => Promise<void>;
  /** Reverts one tracked file change in the current session. */
  revertTrackedFileChange: (filePath: string) => Promise<void>;
  /** Resolves one Figma attachment for attach/preview workflows. */
  resolveFigmaAttachment: (
    importId: string,
    purpose: "attach" | "preview",
  ) => FigmaAttachment | null;
}>;

/** Parameters required to build webview-action callbacks from provider-owned state and methods. */
export type CreateWebviewActionCallbacksParams = Readonly<{
  /** Absolute workspace path used by attachment and terminal actions. */
  workspacePath: string;
  /** Replays the full init payload into the webview. */
  postInit: WebviewActionCallbacks["postInit"];
  /** Applies file-selection updates coming from the webview. */
  updateContextFileSelection: WebviewActionCallbacks["updateContextFileSelection"];
  /** Opens one workspace file in the editor. */
  openWorkspaceFile: WebviewActionCallbacks["openWorkspaceFile"];
  /** Opens one tracked diff in the native diff UI. */
  openTrackedDiff: WebviewActionCallbacks["openTrackedDiff"];
  /** Reveals one terminal associated with a tool call id. */
  revealShellTerminal: WebviewActionCallbacks["revealShellTerminal"];
  /** Loads one older transcript batch before the oldest message currently shown in the webview. */
  loadOlderTranscriptMessages: WebviewActionCallbacks["loadOlderTranscriptMessages"];
  /** Writes one approval log entry when the user answers an approval prompt. */
  appendApprovalLog: (decision: ToolApprovalDecision) => void;
  /** Returns whether the given request id matches the current pending approval. */
  hasPendingApproval: (requestId: string) => boolean;
  /** Resolves the current pending approval promise with the selected decision. */
  resolvePendingApproval: (decision: ToolApprovalDecision) => void;
  /** Clears the pending approval state after resolution. */
  clearPendingApprovalState: () => void;
  /** Applies updated quality preferences. */
  applyQualityPreferences: WebviewActionCallbacks["applyQualityPreferences"];
  /** Applies updated tool capabilities. */
  applyToolCapabilities: WebviewActionCallbacks["applyToolCapabilities"];
  /** Applies updated core tool toggles. */
  applyToolToggles: WebviewActionCallbacks["applyToolToggles"];
  /** Applies updated extension-contributed tool toggles. */
  applyExtensionToolToggles: WebviewActionCallbacks["applyExtensionToolToggles"];
  /** Executes one composer command. */
  handleComposerCommand: WebviewActionCallbacks["handleComposerCommand"];
  /** Posts one host message back into the webview. */
  postMessage: WebviewActionCallbacks["postMessage"];
  /** Opens the native review UI. */
  openNativeReview: WebviewActionCallbacks["openNativeReview"];
  /** Dismisses one review finding. */
  dismissReviewFinding: WebviewActionCallbacks["dismissReviewFinding"];
  /** Applies one review finding. */
  applyReviewFinding: WebviewActionCallbacks["applyReviewFinding"];
  /** Reverts every tracked file change in the current session. */
  revertAllTrackedChanges: WebviewActionCallbacks["revertAllTrackedChanges"];
  /** Reverts one tracked file change in the current session. */
  revertTrackedFileChange: WebviewActionCallbacks["revertTrackedFileChange"];
}>;

/** Provider-owned bindings used to build the standard webview action callback bag. */
export type ProviderWebviewActionBindings = Readonly<{
  /** Absolute workspace path used by attachment and terminal actions. */
  workspacePath: string;
  /** Current pending approval request id, if one exists. */
  pendingApprovalRequestId: string | null;
  /** Current pending approval resolver, if one exists. */
  pendingApprovalResolver: ((decision: ToolApprovalDecision) => void) | null;
  /** Replays the full init payload into the webview. */
  postInit: WebviewActionCallbacks["postInit"];
  /** Applies file-selection updates coming from the webview. */
  updateContextFileSelection: WebviewActionCallbacks["updateContextFileSelection"];
  /** Opens one workspace file in the editor. */
  openWorkspaceFile: WebviewActionCallbacks["openWorkspaceFile"];
  /** Opens one tracked diff in the native diff UI. */
  openTrackedDiff: WebviewActionCallbacks["openTrackedDiff"];
  /** Reveals one terminal associated with a tool call id. */
  revealShellTerminal: WebviewActionCallbacks["revealShellTerminal"];
  /** Loads one older transcript batch before the oldest message currently shown in the webview. */
  loadOlderTranscriptMessages: WebviewActionCallbacks["loadOlderTranscriptMessages"];
  /** Appends one approval log line to the hosted runtime log. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Clears the pending approval state after resolution. */
  clearPendingApprovalState: () => void;
  /** Applies updated quality preferences. */
  applyQualityPreferences: WebviewActionCallbacks["applyQualityPreferences"];
  /** Applies updated tool capabilities. */
  applyToolCapabilities: WebviewActionCallbacks["applyToolCapabilities"];
  /** Applies updated core tool toggles. */
  applyToolToggles: WebviewActionCallbacks["applyToolToggles"];
  /** Applies updated extension-contributed tool toggles. */
  applyExtensionToolToggles: WebviewActionCallbacks["applyExtensionToolToggles"];
  /** Executes one composer command. */
  handleComposerCommand: WebviewActionCallbacks["handleComposerCommand"];
  /** Posts one host message back into the webview. */
  postMessage: WebviewActionCallbacks["postMessage"];
  /** Opens the native review UI. */
  openNativeReview: WebviewActionCallbacks["openNativeReview"];
  /** Dismisses one review finding. */
  dismissReviewFinding: WebviewActionCallbacks["dismissReviewFinding"];
  /** Applies one review finding. */
  applyReviewFinding: WebviewActionCallbacks["applyReviewFinding"];
  /** Reverts every tracked file change in the current session. */
  revertAllTrackedChanges: WebviewActionCallbacks["revertAllTrackedChanges"];
  /** Reverts one tracked file change in the current session. */
  revertTrackedFileChange: WebviewActionCallbacks["revertTrackedFileChange"];
}>;
