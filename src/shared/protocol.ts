/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared protocol entities exchanged between the extension host and webview.
 */

/** Agent identifiers supported by the extension runtime. */
export type AgentType = 'manual' | 'ollama' | 'gemini' | 'claude' | 'codex';
/** Possible approval decisions returned by the user. */
export type ToolApprovalDecision = 'deny' | 'allow' | 'ask';

/** File entry rendered in the webview file picker. */
export type FileItem = Readonly<{
  /** Workspace-relative file path. */
  path: string;
  /** Human-readable file label shown in the UI. */
  label: string;
  /** Whether the file is currently selected in the UI. */
  selected: boolean;
}>;

/** Transcript attachment metadata representing one imported Figma design. */
export type FigmaAttachment = Readonly<{
  /** Optional persisted attachment id when the Figma payload is stored locally. */
  attachmentId?: string;
  /** Stable Figma import id used to correlate later actions. */
  importId: string;
  /** Human-readable label shown in the transcript. */
  label: string;
  /** Short summary describing the imported Figma context. */
  summary: string;
  /** Optional inline preview image data URL. */
  previewDataUrl?: string;
}>;

/** Metadata returned when the user attaches a local file or image. */
export type LocalAttachmentPayload = Readonly<{
  /** Stable attachment id stored in Galaxy project storage. */
  attachmentId: string;
  /** Original file name provided by the user. */
  name: string;
  /** Browser-reported MIME type used for rendering and parsing. */
  mimeType: string;
  /** Whether the attachment is an image previewable inline. */
  isImage: boolean;
  /** Optional inline preview image data URL shown in the webview. */
  previewDataUrl?: string;
}>;

/** Attachment descriptor persisted on one chat message. */
export type MessageAttachment = Readonly<{
  /** Stable attachment id stored in Galaxy project storage. */
  attachmentId: string;
  /** Attachment kind used for rendering and follow-up actions. */
  kind: 'figma' | 'image' | 'file';
  /** Human-readable label shown alongside the attachment. */
  label: string;
  /** Optional inline preview image data URL shown in the transcript. */
  previewDataUrl?: string;
  /** Optional Figma import id used to resolve full design context later. */
  importId?: string;
}>;

/** Transcript message exchanged between runtime state and the webview. */
export type ChatMessage = Readonly<{
  /** Stable message id used by the transcript renderer. */
  id: string;
  /** Message role used by the runtime transcript and protocol bridge. */
  role: 'assistant' | 'user' | 'tool';
  /** Main message body shown in the transcript. */
  content: string;
  /** Optional agent type that produced the assistant message. */
  agentType?: AgentType;
  /** Attachments associated with the transcript message. */
  attachments?: readonly MessageAttachment[];
  /** Optional chain-of-thought preview shown in the UI when available. */
  thinking?: string;
  /** Inline image payloads passed through to multimodal models. */
  images?: readonly string[];
  /** Unix timestamp in milliseconds when the message was created. */
  timestamp: number;
  /** Tool name used for tool-role transcript entries. */
  toolName?: string;
  /** Tool parameters echoed into the transcript for debugging. */
  toolParams?: Readonly<Record<string, unknown>>;
  /** Extra tool metadata used by the UI for richer rendering. */
  toolMeta?: Readonly<Record<string, unknown>>;
  /** Whether the tool invocation succeeded. */
  toolSuccess?: boolean;
  /** Stable tool call id used to correlate follow-up events. */
  toolCallId?: string;
  /** Pending tool calls emitted by the model before execution. */
  toolCalls?: readonly Readonly<{ id: string; name: string; params: Record<string, unknown> }>[];
  /** Figma attachments resolved for this transcript message. */
  figmaAttachments?: readonly FigmaAttachment[];
}>;

/** One visible item in the execution plan panel. */
export type PlanItem = Readonly<{
  /** Stable plan item id used for updates. */
  id: string;
  /** Short plan title rendered in the UI. */
  title: string;
  /** Longer detail describing the step. */
  detail: string;
  /** Current execution status for the plan item. */
  status: 'done' | 'in_progress' | 'pending';
}>;

/** Activity-log entry displayed in the side panel. */
export type LogEntry = Readonly<{
  /** Stable log entry id. */
  id: string;
  /** Log kind used for styling in the UI. */
  kind: 'info' | 'status' | 'approval' | 'validation' | 'review' | 'error';
  /** Log message text shown in the activity panel. */
  text: string;
  /** Unix timestamp in milliseconds when the log entry was produced. */
  timestamp: number;
}>;

/** Quality-gate summary rendered after validation and review complete. */
export type QualityDetails = Readonly<{
  /** Final validation summary rendered in the quality panel. */
  validationSummary: string;
  /** Final review summary rendered in the quality panel. */
  reviewSummary: string;
  /** Optional list of review findings still relevant for the current turn. */
  reviewFindings?: readonly ReviewFinding[];
}>;

/** Structured review finding shown in the review panel. */
export type ReviewFinding = Readonly<{
  /** Stable finding id used for dismiss/apply actions. */
  id: string;
  /** Severity used for prioritization and styling. */
  severity: 'critical' | 'warning' | 'info';
  /** Human-readable location string such as file and line. */
  location: string;
  /** Finding message shown to the user and agent. */
  message: string;
  /** Optional lifecycle state tracked by the review workflow. */
  status?: 'open' | 'dismissed';
}>;

/** Persistent quality preferences selected by the user. */
export type QualityPreferences = Readonly<{
  /** Whether code review should run as part of the quality gate. */
  reviewEnabled: boolean;
  /** Whether validation should run as part of the quality gate. */
  validateEnabled: boolean;
  /** Whether the agent may use unrestricted tool access. */
  fullAccessEnabled: boolean;
}>;

/** Effective high-level capability switches for the current runtime session. */
export type ToolCapabilities = Readonly<{
  /** Whether the runtime may inspect project files. */
  readProject: boolean;
  /** Whether the runtime may edit project files. */
  editFiles: boolean;
  /** Whether the runtime may execute commands. */
  runCommands: boolean;
  /** Whether the runtime may browse the web. */
  webResearch: boolean;
  /** Whether validation tooling is enabled. */
  validation: boolean;
  /** Whether code review tooling is enabled. */
  review: boolean;
  /** Whether VS Code native tooling is enabled. */
  vscodeNative: boolean;
  /** Whether Galaxy design tooling is enabled. */
  galaxyDesign: boolean;
}>;

/** Keys used to persist per-tool enablement state. */
export type ToolToggleKey =
  | 'read_file'
  | 'find_test_files'
  | 'get_latest_test_failure'
  | 'get_latest_review_findings'
  | 'get_next_review_finding'
  | 'dismiss_review_finding'
  | 'write_file'
  | 'insert_file_at_line'
  | 'edit_file_range'
  | 'multi_edit_file_ranges'
  | 'grep'
  | 'list_dir'
  | 'head'
  | 'tail'
  | 'read_document'
  | 'search_web'
  | 'extract_web'
  | 'map_web'
  | 'crawl_web'
  | 'run_terminal_command'
  | 'await_terminal_command'
  | 'get_terminal_output'
  | 'kill_terminal_command'
  | 'git_status'
  | 'git_diff'
  | 'git_add'
  | 'git_commit'
  | 'git_push'
  | 'git_pull'
  | 'git_checkout'
  | 'run_project_command'
  | 'validate_code'
  | 'request_code_review'
  | 'vscode_open_diff'
  | 'vscode_show_problems'
  | 'vscode_workspace_search'
  | 'vscode_find_references'
  | 'search_extension_tools'
  | 'activate_extension_tools'
  | 'galaxy_design_project_info'
  | 'galaxy_design_registry'
  | 'galaxy_design_init'
  | 'galaxy_design_add';

/** Mapping from tool toggle key to enabled state. */
export type ToolToggles = Readonly<Record<ToolToggleKey, boolean>>;

/** One discovered extension-provided tool entry. */
export type ExtensionToolItem = Readonly<{
  /** Stable toggle key for this extension-provided tool. */
  key: string;
  /** Runtime tool name exposed to the model. */
  runtimeName: string;
  /** User-facing tool title shown in settings and search. */
  title: string;
  /** User-facing description shown in tool management UI. */
  description: string;
  /** Optional JSON schema describing tool input. */
  inputSchema?: object;
  /** Tags used for search and grouping. */
  tags: readonly string[];
  /** Invocation path describing whether the tool is an LM tool or command bridge. */
  invocation: 'lm_tool' | 'command';
  /** Optional VS Code command id when the tool is command-backed. */
  commandId?: string;
}>;

/** Source used to register extension-provided tools. */
export type ExtensionToolSource = 'lm_tool' | 'mcp_curated';

/** Group of extension-provided tools shown together in settings and search. */
export type ExtensionToolGroup = Readonly<{
  /** Extension identifier that owns this group. */
  extensionId: string;
  /** User-facing group label. */
  label: string;
  /** Description shown in extension tool management UI. */
  description: string;
  /** Extension version that produced the tool list. */
  version: string;
  /** Source used to register the extension tools. */
  source: ExtensionToolSource;
  /** Whether the group should be highlighted as recommended. */
  recommended?: boolean;
  /** Tools exposed by the extension group. */
  tools: readonly ExtensionToolItem[];
}>;

/** Diff summary for one file changed during the current session. */
export type ChangedFileSummary = Readonly<{
  /** Absolute or workspace-relative path of the changed file. */
  filePath: string;
  /** User-facing label rendered in the diff summary. */
  label: string;
  /** Best-effort language identifier for the file. */
  language: string;
  /** Whether the file was created during the current turn. */
  wasNew: boolean;
  /** Number of added lines in the diff summary. */
  addedLines: number;
  /** Number of deleted lines in the diff summary. */
  deletedLines: number;
  /** Optional original file content used for revert or diff views. */
  originalContent?: string | null;
  /** Optional current file content used for diff views. */
  currentContent?: string | null;
  /** Optional unified diff text shown in the UI. */
  diffText?: string;
}>;

/** Aggregate diff summary for all files changed during the current session. */
export type ChangeSummary = Readonly<{
  /** Number of files changed in the current workspace session. */
  fileCount: number;
  /** Number of files created in the current workspace session. */
  createdCount: number;
  /** Total added line count across changed files. */
  addedLines: number;
  /** Total deleted line count across changed files. */
  deletedLines: number;
  /** Per-file change summaries used by the diff panel. */
  files: readonly ChangedFileSummary[];
}>;

/** Initial state snapshot sent from the host when the webview starts. */
export type SessionInitPayload = Readonly<{
  /** Workspace name shown in the webview header. */
  workspaceName: string;
  /** File list shown in the file picker. */
  files: readonly FileItem[];
  /** Existing transcript messages restored on load. */
  messages: readonly ChatMessage[];
  /** Currently selected agent in the composer. */
  selectedAgent: AgentType;
  /** Current execution phase of the runtime state machine. */
  phase: 'phase-0' | 'phase-1' | 'phase-2' | 'phase-3' | 'phase-4' | 'phase-5' | 'phase-6' | 'phase-7' | 'phase-8';
  /** Whether the runtime is currently busy processing a turn. */
  isRunning: boolean;
  /** Human-readable status line shown in the UI. */
  statusText: string;
  /** Current plan items rendered in the planning panel. */
  planItems: readonly PlanItem[];
  /** Activity log entries rendered in the log panel. */
  logs: readonly LogEntry[];
  /** Current quality summary block. */
  qualityDetails: QualityDetails;
  /** User-selected quality preferences. */
  qualityPreferences: QualityPreferences;
  /** Effective tool capability flags. */
  toolCapabilities: ToolCapabilities;
  /** Effective per-tool toggles. */
  toolToggles: ToolToggles;
  /** Extension-contributed tool groups available to the user. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Toggle state for extension-contributed tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Current workspace change summary. */
  changeSummary: ChangeSummary;
  /** Optional in-flight assistant text stream restored into the composer. */
  streamingAssistant?: string;
  /** Optional in-flight thinking stream restored into the composer. */
  streamingThinking?: string;
  /** Optional active shell sessions displayed in the command panel. */
  activeShellSessions?: readonly Readonly<{
    /** Stable tool call id for the running command. */
    toolCallId: string;
    /** Exact command text shown in the terminal panel. */
    commandText: string;
    /** Working directory used by the command. */
    cwd: string;
    /** Unix timestamp in milliseconds when the command started. */
    startedAt: number;
    /** Buffered terminal output shown in the UI. */
    output: string;
    /** Optional terminal title or tab label. */
    terminalTitle?: string;
    /** Whether the command completed successfully. */
    success?: boolean;
    /** Process exit code when the command has completed. */
    exitCode?: number;
    /** Total runtime in milliseconds when the command has completed. */
    durationMs?: number;
    /** Whether the command continues in the background. */
    background?: boolean;
  }>[];
  /** Pending approval request that should be shown immediately on load. */
  approvalRequest?: ApprovalRequestPayload | null;
}>;

/** Prompt-evidence block sent to the webview for debug and inspection. */
export type EvidenceContextPayload = Readonly<{
  /** Prompt-ready evidence block text. */
  content: string;
  /** Estimated token count of the evidence block. */
  tokens: number;
  /** Number of evidence entries merged into the block. */
  entryCount: number;
  /** Optional final prompt token count after assembly. */
  finalPromptTokens?: number;
  /** Focus symbols selected by syntax-aware retrieval. */
  focusSymbols?: readonly string[];
  /** Optional manual planning content inserted into the prompt. */
  manualPlanningContent?: string;
  /** Optional manual read batch items queued for the agent. */
  manualReadBatchItems?: readonly string[];
  /** Optional progress items for the manual read plan UI. */
  readPlanProgressItems?: readonly Readonly<{
    /** User-facing label for the read plan item. */
    label: string;
    /** Whether the item already has confirmed evidence. */
    confirmed: boolean;
    /** Optional short evidence summary for the item. */
    evidenceSummary?: string;
    /** File path targeted by the read plan item. */
    targetPath: string;
    /** Optional symbol name associated with the read plan item. */
    symbolName?: string;
    /** Tool expected to satisfy the read plan item. */
    tool: 'read_file' | 'grep';
  }>[];
  /** Number of read plan items already confirmed. */
  confirmedReadCount?: number;
  /** Optional retrieval lifecycle summary derived from read-plan status. */
  retrievalLifecycleContent?: string;
  /** Optional anti-loop guidance emitted for the current prompt. */
  antiLoopGuardrailsContent?: string;
  /** Optional evidence-reuse guidance emitted for the current prompt. */
  evidenceReuseContent?: string;
  /** Optional workflow reread guard metadata for flow-oriented turns. */
  workflowRereadGuard?: Readonly<{
    /** Whether broad rereads should be blocked for the current turn. */
    enabled: boolean;
    /** Candidate files protected by the guard. */
    candidatePaths: readonly string[];
    /** Number of workflow retrieval entries behind the guard. */
    entryCount: number;
    /** Original user query text that triggered the workflow retrieval. */
    queryText: string;
  }>;
}>;

/** Host payload emitted when a command starts streaming output. */
export type CommandStreamStartPayload = Readonly<{
  /** Stable tool call id for the streamed command. */
  toolCallId: string;
  /** Exact command text shown in the terminal panel. */
  commandText: string;
  /** Working directory used by the command. */
  cwd: string;
  /** Unix timestamp in milliseconds when the command started. */
  startedAt: number;
  /** Optional terminal title or tab label. */
  terminalTitle?: string;
}>;

/** Host payload emitted for one streamed command-output chunk. */
export type CommandStreamChunkPayload = Readonly<{
  /** Stable tool call id for the streamed command. */
  toolCallId: string;
  /** Raw output chunk appended to the terminal transcript. */
  chunk: string;
}>;

/** Host payload emitted when a streamed command finishes. */
export type CommandStreamEndPayload = Readonly<{
  /** Stable tool call id for the streamed command. */
  toolCallId: string;
  /** Process exit code emitted by the command. */
  exitCode: number;
  /** Whether the command completed successfully. */
  success: boolean;
  /** Total runtime in milliseconds for the command. */
  durationMs: number;
  /** Whether the command remains active in background mode. */
  background?: boolean;
}>;

/** Approval request payload shown in the webview modal. */
export type ApprovalRequestPayload = Readonly<{
  /** Stable request id used when the webview responds. */
  requestId: string;
  /** Approval cache key used to reuse previous decisions. */
  approvalKey: string;
  /** Tool name requesting approval. */
  toolName: string;
  /** Short approval title shown in the modal. */
  title: string;
  /** Primary approval message shown to the user. */
  message: string;
  /** Extra detail lines shown under the approval message. */
  details: readonly string[];
}>;

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | Readonly<{ type: 'session-init'; payload: SessionInitPayload }>
  | Readonly<{ type: 'selected-agent-updated'; payload: {
      /** Agent selected in the webview composer. */
      selectedAgent: AgentType;
    } }>
  | Readonly<{ type: 'assistant-stream'; payload: {
      /** Incremental assistant text chunk. */
      delta: string;
    } }>
  | Readonly<{ type: 'assistant-thinking'; payload: {
      /** Incremental assistant thinking chunk. */
      delta: string;
    } }>
  | Readonly<{ type: 'assistant-message'; payload: ChatMessage }>
  | Readonly<{ type: 'message-added'; payload: ChatMessage }>
  | Readonly<{ type: 'selection-updated'; payload: {
      /** Currently selected file paths in the UI. */
      selectedFiles: readonly string[];
    } }>
  | Readonly<{ type: 'files-updated'; payload: {
      /** Refreshed file list shown in the selector. */
      files: readonly FileItem[];
    } }>
  | Readonly<{ type: 'approval-request'; payload: ApprovalRequestPayload }>
  | Readonly<{ type: 'command-stream-start'; payload: CommandStreamStartPayload }>
  | Readonly<{ type: 'command-stream-chunk'; payload: CommandStreamChunkPayload }>
  | Readonly<{ type: 'command-stream-end'; payload: CommandStreamEndPayload }>
  | Readonly<{ type: 'evidence-context'; payload: EvidenceContextPayload }>
  | Readonly<{ type: 'run-state'; payload: {
      /** Whether the host is currently executing a turn. */
      isRunning: boolean;
      /** Human-readable run state shown in the composer footer. */
      statusText: string;
    } }>
  | Readonly<{ type: 'logs-updated'; payload: {
      /** Refreshed activity log entries. */
      logs: readonly LogEntry[];
    } }>
  | Readonly<{ type: 'quality-updated'; payload: QualityDetails }>
  | Readonly<{ type: 'quality-preferences-updated'; payload: QualityPreferences }>
  | Readonly<{ type: 'tool-capabilities-updated'; payload: ToolCapabilities }>
  | Readonly<{ type: 'tool-toggles-updated'; payload: ToolToggles }>
  | Readonly<{ type: 'extension-tool-toggles-updated'; payload: {
      /** Toggle state for extension-contributed tools. */
      [key: string]: boolean;
    } }>
  | Readonly<{ type: 'change-summary-updated'; payload: ChangeSummary }>
  | Readonly<{ type: 'figma-attachment-resolved'; payload: {
      /** Resolved Figma attachment metadata. */
      attachment: FigmaAttachment;
      /** Whether the resolution is for transcript attach or preview. */
      purpose: 'attach' | 'preview';
    } }>
  | Readonly<{ type: 'local-attachment-added'; payload: {
      /** Newly stored local attachment metadata. */
      attachment: LocalAttachmentPayload;
    } }>
  | Readonly<{ type: 'error'; payload: {
      /** User-facing error message. */
      message: string;
    } }>;

/** Messages sent from the webview back to the extension host. */
export type WebviewMessage =
  | Readonly<{ type: 'webview-ready' }>
  | Readonly<{
      type: 'chat-send';
      payload: {
        /** User-authored message text sent to the host. */
        content: string;
        /** Agent selected for this turn. */
        agent: AgentType;
        /** File paths selected in the composer when the turn starts. */
        selectedFiles: readonly string[];
        /** Optional Figma imports attached to the message. */
        figmaImportIds?: readonly string[];
        /** Optional local attachment ids attached to the message. */
        attachmentIds?: readonly string[];
        /** Optional override for whether review runs after the turn. */
        reviewEnabled?: boolean;
        /** Optional override for whether validation runs after the turn. */
        validateEnabled?: boolean;
        /** Optional override for unrestricted tool access. */
        fullAccessEnabled?: boolean;
      };
    }>
  | Readonly<{ type: 'quality-set'; payload: QualityPreferences }>
  | Readonly<{ type: 'tool-capabilities-set'; payload: ToolCapabilities }>
  | Readonly<{ type: 'tool-toggles-set'; payload: ToolToggles }>
  | Readonly<{ type: 'extension-tool-toggles-set'; payload: {
      /** Updated enablement state for extension-contributed tools. */
      [key: string]: boolean;
    } }>
  | Readonly<{ type: 'composer-command'; payload: {
      /** Composer command identifier to execute. */
      id: 'config' | 'reset' | 'clear';
    } }>
  | Readonly<{ type: 'attachment-add-local'; payload: {
      /** Original file name chosen by the user. */
      name: string;
      /** Browser-reported MIME type for the attachment. */
      mimeType: string;
      /** Base64 or data URL payload of the attachment. */
      dataUrl: string;
    } }>
  | Readonly<{ type: 'attachment-remove'; payload: {
      /** Attachment id to remove from pending state. */
      attachmentId: string;
    } }>
  | Readonly<{ type: 'review-open' }>
  | Readonly<{ type: 'review-finding-dismiss'; payload: {
      /** Review finding id to dismiss. */
      findingId: string;
    } }>
  | Readonly<{ type: 'review-finding-apply'; payload: {
      /** Review finding id to apply or navigate to. */
      findingId: string;
    } }>
  | Readonly<{ type: 'revert-all-changes' }>
  | Readonly<{ type: 'revert-file-change'; payload: {
      /** File path whose pending changes should be reverted. */
      filePath: string;
    } }>
  | Readonly<{ type: 'file-toggle'; payload: {
      /** File path whose selection state changed. */
      filePath: string;
      /** Updated selected state for the file. */
      selected: boolean;
    } }>
  | Readonly<{ type: 'file-open'; payload: {
      /** File path that should be opened in the editor. */
      filePath: string;
    } }>
  | Readonly<{ type: 'file-diff'; payload: {
      /** File path whose diff should be opened. */
      filePath: string;
    } }>
  | Readonly<{ type: 'link-open'; payload: {
      /** URL or href that should be opened externally. */
      href: string;
    } }>
  | Readonly<{ type: 'terminal-snippet-run'; payload: {
      /** Code snippet or command fragment to execute. */
      code: string;
      /** Optional language hint used to choose execution behavior. */
      language?: string;
    } }>
  | Readonly<{ type: 'approval-response'; payload: {
      /** Approval request id being answered. */
      requestId: string;
      /** User decision for the pending approval request. */
      decision: ToolApprovalDecision;
    } }>
  | Readonly<{ type: 'resolve-figma-attachment'; payload: {
      /** Figma import id that should be resolved. */
      importId: string;
      /** Whether the resolution is for transcript attach or preview. */
      purpose: 'attach' | 'preview';
    } }>
  | Readonly<{ type: 'shell-open-terminal'; payload: {
      /** Tool call id whose terminal should be revealed. */
      toolCallId: string;
    } }>;
