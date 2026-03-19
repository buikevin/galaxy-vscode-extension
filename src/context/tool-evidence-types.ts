export type ToolEvidenceBase = Readonly<{
  evidenceId: string;
  workspaceId: string;
  turnId: string;
  toolCallId?: string;
  toolName: string;
  summary: string;
  success: boolean;
  capturedAt: number;
  stale: boolean;
  tags: readonly string[];
}>;

export type DirectoryEntry = Readonly<{
  name: string;
  path: string;
  kind: 'file' | 'dir';
}>;

export type ListDirEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'list_dir';
  directoryPath: string;
  entryCount: number;
  entries: readonly DirectoryEntry[];
  truncated: boolean;
}>;

export type GrepEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'grep';
  targetPath: string;
  pattern: string;
  matches: number;
  contentPreview: string;
  truncated: boolean;
}>;

export type FileReadEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'read_file' | 'head' | 'tail' | 'read_document';
  filePath: string;
  readMode: 'full' | 'partial' | 'head' | 'tail' | 'document';
  startLine?: number;
  endLine?: number;
  requestedOffset?: number;
  requestedMaxLines?: number;
  totalLines?: number;
  bytesRead?: number;
  contentPreview: string;
  truncated: boolean;
}>;

export type FileWriteEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'write_file' | 'edit_file';
  filePath: string;
  operation: 'create' | 'overwrite' | 'edit';
  existedBefore: boolean;
  changedLineRanges: readonly Readonly<{
    startLine: number;
    endLine: number;
  }>[];
  replaceAll?: boolean;
  occurrencesChanged?: number;
  recursive?: boolean;
}>;

export type ToolReportEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'validate_code';
  filePath: string;
  reportKind: 'validation';
  reportSummary: string;
  contentPreview: string;
  truncated: boolean;
}>;

export type WebResearchEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'search_web' | 'extract_web' | 'map_web' | 'crawl_web';
  reportKind: 'web_search' | 'web_extract' | 'web_map' | 'web_crawl';
  query?: string;
  baseUrl?: string;
  urls: readonly string[];
  resultCount: number;
  contentPreview: string;
  truncated: boolean;
}>;

export type ProjectCommandEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'run_project_command';
  commandId: string;
  commandLabel: string;
  category: 'build' | 'test' | 'lint' | 'typecheck' | 'format-check';
  cwd: string;
  exitCode: number;
  outputPreview: string;
  truncated: boolean;
}>;

export type GalaxyDesignKnowledgeEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'galaxy_design_project_info' | 'galaxy_design_registry';
  framework?: string;
  packageManager?: string;
  targetPath?: string;
  initialized?: boolean;
  query?: string;
  component?: string;
  group?: string;
  resultCount?: number;
  sampleComponents: readonly string[];
  truncated: boolean;
}>;

export type GalaxyDesignActionEvidence = ToolEvidenceBase & Readonly<{
  toolName: 'galaxy_design_init' | 'galaxy_design_add';
  framework: string;
  packageManager: string;
  runnerPackageManager: string;
  targetPath: string;
  commandPreview: string;
  components: readonly string[];
  exitCode: number;
  outputPreview: string;
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
