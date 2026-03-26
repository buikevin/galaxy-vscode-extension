export type AgentType = 'manual' | 'ollama' | 'gemini' | 'claude' | 'codex';
export type ToolApprovalDecision = 'deny' | 'allow' | 'ask';

export type FileItem = Readonly<{
  path: string;
  label: string;
  selected: boolean;
}>;

export type FigmaAttachment = Readonly<{
  attachmentId?: string;
  importId: string;
  label: string;
  summary: string;
  previewDataUrl?: string;
}>;

export type LocalAttachmentPayload = Readonly<{
  attachmentId: string;
  name: string;
  mimeType: string;
  isImage: boolean;
  previewDataUrl?: string;
}>;

export type MessageAttachment = Readonly<{
  attachmentId: string;
  kind: 'figma' | 'image' | 'file';
  label: string;
  previewDataUrl?: string;
  importId?: string;
}>;

export type ChatMessage = Readonly<{
  id: string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  agentType?: AgentType;
  attachments?: readonly MessageAttachment[];
  thinking?: string;
  images?: readonly string[];
  timestamp: number;
  toolName?: string;
  toolParams?: Readonly<Record<string, unknown>>;
  toolMeta?: Readonly<Record<string, unknown>>;
  toolSuccess?: boolean;
  toolCallId?: string;
  toolCalls?: readonly Readonly<{ id: string; name: string; params: Record<string, unknown> }>[];
  figmaAttachments?: readonly FigmaAttachment[];
}>;

export type PlanItem = Readonly<{
  id: string;
  title: string;
  detail: string;
  status: 'done' | 'in_progress' | 'pending';
}>;

export type LogEntry = Readonly<{
  id: string;
  kind: 'info' | 'status' | 'approval' | 'validation' | 'review' | 'error';
  text: string;
  timestamp: number;
}>;

export type QualityDetails = Readonly<{
  validationSummary: string;
  reviewSummary: string;
  reviewFindings?: readonly ReviewFinding[];
}>;

export type ReviewFinding = Readonly<{
  id: string;
  severity: 'critical' | 'warning' | 'info';
  location: string;
  message: string;
  status?: 'open' | 'dismissed';
}>;

export type QualityPreferences = Readonly<{
  reviewEnabled: boolean;
  validateEnabled: boolean;
  fullAccessEnabled: boolean;
}>;

export type ToolCapabilities = Readonly<{
  readProject: boolean;
  editFiles: boolean;
  runCommands: boolean;
  webResearch: boolean;
  validation: boolean;
  review: boolean;
  vscodeNative: boolean;
  galaxyDesign: boolean;
}>;

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

export type ToolToggles = Readonly<Record<ToolToggleKey, boolean>>;

export type ExtensionToolItem = Readonly<{
  key: string;
  command: string;
  qualifiedName: string;
  title: string;
  description: string;
}>;

export type ExtensionToolGroup = Readonly<{
  extensionId: string;
  label: string;
  description: string;
  version: string;
  tools: readonly ExtensionToolItem[];
}>;

export type ChangedFileSummary = Readonly<{
  filePath: string;
  label: string;
  language: string;
  wasNew: boolean;
  addedLines: number;
  deletedLines: number;
}>;

export type ChangeSummary = Readonly<{
  fileCount: number;
  createdCount: number;
  addedLines: number;
  deletedLines: number;
  files: readonly ChangedFileSummary[];
}>;

export type SessionInitPayload = Readonly<{
  workspaceName: string;
  files: readonly FileItem[];
  messages: readonly ChatMessage[];
  selectedAgent: AgentType;
  phase: 'phase-0' | 'phase-1' | 'phase-2' | 'phase-3' | 'phase-4' | 'phase-5' | 'phase-6' | 'phase-7' | 'phase-8';
  isRunning: boolean;
  statusText: string;
  planItems: readonly PlanItem[];
  logs: readonly LogEntry[];
  qualityDetails: QualityDetails;
  qualityPreferences: QualityPreferences;
  toolCapabilities: ToolCapabilities;
  toolToggles: ToolToggles;
  extensionToolGroups: readonly ExtensionToolGroup[];
  extensionToolToggles: Readonly<Record<string, boolean>>;
  changeSummary: ChangeSummary;
  streamingAssistant?: string;
  streamingThinking?: string;
  activeShellSessions?: readonly Readonly<{
    toolCallId: string;
    commandText: string;
    cwd: string;
    startedAt: number;
    output: string;
    terminalTitle?: string;
    success?: boolean;
    exitCode?: number;
    durationMs?: number;
    background?: boolean;
  }>[];
  approvalRequest?: ApprovalRequestPayload | null;
}>;

export type EvidenceContextPayload = Readonly<{
  content: string;
  tokens: number;
  entryCount: number;
  finalPromptTokens?: number;
  focusSymbols?: readonly string[];
  manualPlanningContent?: string;
  manualReadBatchItems?: readonly string[];
  readPlanProgressItems?: readonly Readonly<{
    label: string;
    confirmed: boolean;
    evidenceSummary?: string;
    targetPath: string;
    symbolName?: string;
    tool: 'read_file' | 'grep';
  }>[];
  confirmedReadCount?: number;
}>;

export type CommandStreamStartPayload = Readonly<{
  toolCallId: string;
  commandText: string;
  cwd: string;
  startedAt: number;
  terminalTitle?: string;
}>;

export type CommandStreamChunkPayload = Readonly<{
  toolCallId: string;
  chunk: string;
}>;

export type CommandStreamEndPayload = Readonly<{
  toolCallId: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
  background?: boolean;
}>;

export type ApprovalRequestPayload = Readonly<{
  requestId: string;
  approvalKey: string;
  toolName: string;
  title: string;
  message: string;
  details: readonly string[];
}>;

export type HostMessage =
  | Readonly<{ type: 'session-init'; payload: SessionInitPayload }>
  | Readonly<{ type: 'selected-agent-updated'; payload: { selectedAgent: AgentType } }>
  | Readonly<{ type: 'assistant-stream'; payload: { delta: string } }>
  | Readonly<{ type: 'assistant-thinking'; payload: { delta: string } }>
  | Readonly<{ type: 'assistant-message'; payload: ChatMessage }>
  | Readonly<{ type: 'message-added'; payload: ChatMessage }>
  | Readonly<{ type: 'selection-updated'; payload: { selectedFiles: readonly string[] } }>
  | Readonly<{ type: 'files-updated'; payload: { files: readonly FileItem[] } }>
  | Readonly<{ type: 'approval-request'; payload: ApprovalRequestPayload }>
  | Readonly<{ type: 'command-stream-start'; payload: CommandStreamStartPayload }>
  | Readonly<{ type: 'command-stream-chunk'; payload: CommandStreamChunkPayload }>
  | Readonly<{ type: 'command-stream-end'; payload: CommandStreamEndPayload }>
  | Readonly<{ type: 'evidence-context'; payload: EvidenceContextPayload }>
  | Readonly<{ type: 'run-state'; payload: { isRunning: boolean; statusText: string } }>
  | Readonly<{ type: 'logs-updated'; payload: { logs: readonly LogEntry[] } }>
  | Readonly<{ type: 'quality-updated'; payload: QualityDetails }>
  | Readonly<{ type: 'quality-preferences-updated'; payload: QualityPreferences }>
  | Readonly<{ type: 'tool-capabilities-updated'; payload: ToolCapabilities }>
  | Readonly<{ type: 'tool-toggles-updated'; payload: ToolToggles }>
  | Readonly<{ type: 'extension-tool-toggles-updated'; payload: Readonly<Record<string, boolean>> }>
  | Readonly<{ type: 'change-summary-updated'; payload: ChangeSummary }>
  | Readonly<{ type: 'figma-attachment-resolved'; payload: { attachment: FigmaAttachment; purpose: 'attach' | 'preview' } }>
  | Readonly<{ type: 'local-attachment-added'; payload: { attachment: LocalAttachmentPayload } }>
  | Readonly<{ type: 'error'; payload: { message: string } }>;

export type WebviewMessage =
  | Readonly<{ type: 'webview-ready' }>
  | Readonly<{
      type: 'chat-send';
      payload: {
        content: string;
        agent: AgentType;
        selectedFiles: readonly string[];
        figmaImportIds?: readonly string[];
        attachmentIds?: readonly string[];
        reviewEnabled?: boolean;
        validateEnabled?: boolean;
        fullAccessEnabled?: boolean;
      };
    }>
  | Readonly<{ type: 'quality-set'; payload: QualityPreferences }>
  | Readonly<{ type: 'tool-capabilities-set'; payload: ToolCapabilities }>
  | Readonly<{ type: 'tool-toggles-set'; payload: ToolToggles }>
  | Readonly<{ type: 'extension-tool-toggles-set'; payload: Readonly<Record<string, boolean>> }>
  | Readonly<{ type: 'composer-command'; payload: { id: 'config' | 'reset' | 'clear' } }>
  | Readonly<{ type: 'attachment-add-local'; payload: { name: string; mimeType: string; dataUrl: string } }>
  | Readonly<{ type: 'attachment-remove'; payload: { attachmentId: string } }>
  | Readonly<{ type: 'review-open' }>
  | Readonly<{ type: 'review-finding-dismiss'; payload: { findingId: string } }>
  | Readonly<{ type: 'review-finding-apply'; payload: { findingId: string } }>
  | Readonly<{ type: 'revert-all-changes' }>
  | Readonly<{ type: 'revert-file-change'; payload: { filePath: string } }>
  | Readonly<{ type: 'file-toggle'; payload: { filePath: string; selected: boolean } }>
  | Readonly<{ type: 'file-open'; payload: { filePath: string } }>
  | Readonly<{ type: 'file-diff'; payload: { filePath: string } }>
  | Readonly<{ type: 'approval-response'; payload: { requestId: string; decision: ToolApprovalDecision } }>
  | Readonly<{ type: 'resolve-figma-attachment'; payload: { importId: string; purpose: 'attach' | 'preview' } }>
  | Readonly<{ type: 'shell-open-terminal'; payload: { toolCallId: string } }>;
