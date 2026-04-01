/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for persisted tool evidence records.
 */

export type ToolEvidenceBase = Readonly<{
  /** Stable evidence identifier. */
  evidenceId: string;
  /** Workspace id the evidence belongs to. */
  workspaceId: string;
  /** Turn id that produced the evidence. */
  turnId: string;
  /** Optional tool-call id emitted by the model/provider. */
  toolCallId?: string;
  /** Tool name that produced the evidence. */
  toolName: string;
  /** Short summary used in retrieval and prompt blocks. */
  summary: string;
  /** Whether the tool execution succeeded. */
  success: boolean;
  /** Timestamp when the evidence was captured. */
  capturedAt: number;
  /** Whether the evidence has been marked stale. */
  stale: boolean;
  /** Retrieval tags attached to the evidence record. */
  tags: readonly string[];
}>;

export type DirectoryEntry = Readonly<{
  /** Basename of the entry. */
  name: string;
  /** Path of the entry relative to workspace/root context. */
  path: string;
  /** Entry kind distinguishing files from directories. */
  kind: 'file' | 'dir';
}>;

export type ListDirEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'list_dir';
  /** Directory path that was listed. */
  directoryPath: string;
  /** Number of entries returned by the listing. */
  entryCount: number;
  /** Typed directory entries returned by the tool. */
  entries: readonly DirectoryEntry[];
  /** Whether the listing output was truncated. */
  truncated: boolean;
}>;

export type GrepEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'grep';
  /** File or directory path searched by grep. */
  targetPath: string;
  /** Pattern used for the search. */
  pattern: string;
  /** Number of matches reported by grep. */
  matches: number;
  /** Short preview of matching content. */
  contentPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type FileReadEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'read_file' | 'head' | 'tail' | 'read_document';
  /** File path read by the tool. */
  filePath: string;
  /** Normalized read mode used to obtain the content. */
  readMode: 'full' | 'partial' | 'head' | 'tail' | 'document' | 'document_semantic';
  /** Optional one-based start line included in the read. */
  startLine?: number;
  /** Optional one-based end line included in the read. */
  endLine?: number;
  /** Optional byte/character offset requested for the read. */
  requestedOffset?: number;
  /** Optional max-lines limit requested by the caller. */
  requestedMaxLines?: number;
  /** Optional total line count of the source file. */
  totalLines?: number;
  /** Optional byte count returned by the read. */
  bytesRead?: number;
  /** Short preview of the returned content. */
  contentPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type FileWriteEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'write_file' | 'edit_file' | 'edit_file_range' | 'multi_edit_file_ranges';
  /** File path modified by the tool. */
  filePath: string;
  /** Normalized write operation kind. */
  operation: 'create' | 'overwrite' | 'edit';
  /** Whether the file existed before the write. */
  existedBefore: boolean;
  changedLineRanges: readonly Readonly<{
    /** One-based start line of the changed range. */
    startLine: number;
    /** One-based end line of the changed range. */
    endLine: number;
  }>[];
  /** Whether replace-all mode was used. */
  replaceAll?: boolean;
  /** Optional number of occurrences changed by the edit. */
  occurrencesChanged?: number;
  /** Whether the write acted recursively. */
  recursive?: boolean;
}>;

export type ToolReportEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'validate_code';
  /** File path associated with the report. */
  filePath: string;
  /** Report subtype used for retrieval and UI. */
  reportKind: 'validation';
  /** Human-readable summary of the validation report. */
  reportSummary: string;
  /** Short preview of the report content. */
  contentPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type WebResearchEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'search_web' | 'extract_web' | 'map_web' | 'crawl_web';
  /** Web-research subtype used for retrieval and UI. */
  reportKind: 'web_search' | 'web_extract' | 'web_map' | 'web_crawl';
  /** Optional free-text query submitted to the web tool. */
  query?: string;
  /** Optional base URL used for extract/map/crawl operations. */
  baseUrl?: string;
  /** URLs returned or traversed by the operation. */
  urls: readonly string[];
  /** Number of results included in the response. */
  resultCount: number;
  /** Short preview of the research content. */
  contentPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type ProjectCommandEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'run_project_command';
  /** Stable command identifier selected for execution. */
  commandId: string;
  /** Human-readable command label. */
  commandLabel: string;
  /** Command category used for validation and filtering. */
  category: 'build' | 'test' | 'lint' | 'typecheck' | 'format-check' | 'custom';
  /** Working directory used when running the command. */
  cwd: string;
  /** Exit code reported by the command. */
  exitCode: number;
  /** Short preview of command output. */
  outputPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type GalaxyDesignKnowledgeEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'galaxy_design_project_info' | 'galaxy_design_registry';
  /** Optional detected framework name. */
  framework?: string;
  /** Optional detected package manager name. */
  packageManager?: string;
  /** Optional target path associated with the query. */
  targetPath?: string;
  /** Optional initialized flag for Galaxy Design state. */
  initialized?: boolean;
  /** Optional free-text query executed against the registry. */
  query?: string;
  /** Optional component name used in the query. */
  component?: string;
  /** Optional component group used in the query. */
  group?: string;
  /** Optional count of results returned. */
  resultCount?: number;
  /** Sample component names returned for preview. */
  sampleComponents: readonly string[];
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type GalaxyDesignActionEvidence = ToolEvidenceBase & Readonly<{
  /** Concrete tool discriminator. */
  toolName: 'galaxy_design_init' | 'galaxy_design_add';
  /** Framework selected for the action. */
  framework: string;
  /** Package manager selected for the action. */
  packageManager: string;
  /** Package manager actually used to run generated commands. */
  runnerPackageManager: string;
  /** Target path modified by the action. */
  targetPath: string;
  /** Command preview shown to the user. */
  commandPreview: string;
  /** Components affected by the action. */
  components: readonly string[];
  /** Exit code reported by the action. */
  exitCode: number;
  /** Short preview of action output. */
  outputPreview: string;
  /** Whether the preview/content was truncated. */
  truncated: boolean;
}>;

export type ToolEvidence =
  | ListDirEvidence
  | GrepEvidence
  | FileReadEvidence
  | FileWriteEvidence
  | ToolReportEvidence
  | WebResearchEvidence
  | ProjectCommandEvidence
  | GalaxyDesignKnowledgeEvidence
  | GalaxyDesignActionEvidence;
