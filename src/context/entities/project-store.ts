/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for workspace project storage metadata.
 */

export type ProjectMeta = Readonly<{
  /** Stable workspace id used for storage and indexing. */
  workspaceId: string;
  /** Display name derived from the workspace folder. */
  workspaceName: string;
  /** Absolute path of the workspace root. */
  workspacePath: string;
  /** Sanitized directory name used under ~/.galaxy/projects. */
  projectDirName: string;
  /** Timestamp when the project metadata was first created. */
  createdAt: number;
  /** Timestamp when the workspace was last opened. */
  lastOpenedAt: number;
  /** Storage schema version for migrations. */
  storageVersion: number;
  toolCapabilities?: Readonly<{
    /** Whether read-only project inspection tools are enabled. */
    readProject?: boolean;
    /** Whether file-editing tools are enabled. */
    editFiles?: boolean;
    /** Whether shell or project-command execution is enabled. */
    runCommands?: boolean;
    /** Whether web-research tools are enabled. */
    webResearch?: boolean;
    /** Whether validation tools are enabled. */
    validation?: boolean;
    /** Whether code-review tools are enabled. */
    review?: boolean;
    /** Whether VS Code native tools are enabled. */
    vscodeNative?: boolean;
    /** Whether Galaxy Design tools are enabled. */
    galaxyDesign?: boolean;
  }>;
  /** Per-tool toggle map overriding default enablement. */
  toolToggles?: Readonly<Record<string, boolean>>;
  /** Per-extension-tool toggle map overriding default enablement. */
  extensionToolToggles?: Readonly<Record<string, boolean>>;
  latestTestFailure?: Readonly<{
    /** Timestamp when the failing run was captured. */
    capturedAt: number;
    /** Human-readable summary of the failing run. */
    summary: string;
    /** Command that produced the failure. */
    command: string;
    /** Validation profile used for the run. */
    profile: string;
    /** High-level category like lint/test/typecheck. */
    category: string;
    issues: readonly Readonly<{
      /** Optional file path associated with the issue. */
      filePath?: string;
      /** Optional one-based line number. */
      line?: number;
      /** Optional one-based column number. */
      column?: number;
      /** Severity level reported by the validator. */
      severity: 'error' | 'warning';
      /** Human-readable issue message. */
      message: string;
      /** Source tool or parser that emitted the issue. */
      source: string;
    }>[];
  }>;
  latestReviewFindings?: Readonly<{
    /** Timestamp when the review summary was captured. */
    capturedAt: number;
    /** Human-readable summary of the review pass. */
    summary: string;
    findings: readonly Readonly<{
      /** Stable id assigned to the finding. */
      id: string;
      /** Severity assigned to the finding. */
      severity: 'critical' | 'warning' | 'info';
      /** File or logical location of the finding. */
      location: string;
      /** Human-readable finding message. */
      message: string;
      /** Optional workflow status of the finding. */
      status?: 'open' | 'dismissed';
    }>[];
  }>;
}>;

export type ProjectStorageInfo = Readonly<{
  /** Stable workspace id used for storage and indexing. */
  workspaceId: string;
  /** Display name derived from the workspace folder. */
  workspaceName: string;
  /** Absolute path of the workspace root. */
  workspacePath: string;
  /** Sanitized directory name used under ~/.galaxy/projects. */
  projectDirName: string;
  /** Absolute path to the project storage directory. */
  projectDirPath: string;
  /** Chroma persistence directory for the workspace. */
  chromaDirPath: string;
  /** Log file written by the local Chroma manager. */
  chromaLogPath: string;
  /** JSON state file tracking the local Chroma process. */
  chromaStatePath: string;
  /** Workspace-local .galaxy directory inside the project root. */
  localGalaxyDirPath: string;
  /** Workspace-local settings file path. */
  localSettingsPath: string;
  /** Project metadata JSON path. */
  projectMetaPath: string;
  /** Debug log path used by the extension runtime. */
  debugLogPath: string;
  /** Session memory JSON path. */
  sessionMemoryPath: string;
  /** UI transcript JSONL path. */
  uiTranscriptPath: string;
  /** Action-approval JSON path. */
  actionApprovalsPath: string;
  /** Project-command profile JSON path. */
  projectCommandsPath: string;
  /** Tool-evidence JSONL path. */
  toolEvidencePath: string;
  /** Raw telemetry JSONL path. */
  telemetryPath: string;
  /** Aggregated telemetry summary JSON path. */
  telemetrySummaryPath: string;
  /** Command-context snapshot path. */
  commandContextPath: string;
  /** Persisted syntax-index snapshot path. */
  syntaxIndexPath: string;
  /** Persisted semantic-index snapshot path. */
  semanticIndexPath: string;
  /** SQLite database path for RAG metadata. */
  ragMetadataDbPath: string;
  /** Persisted Figma import metadata path. */
  figmaImportsPath: string;
  /** Directory for copied Figma asset files. */
  figmaAssetsDirPath: string;
  /** Root directory for attachment persistence. */
  attachmentsDirPath: string;
  /** Attachment index JSON path. */
  attachmentsIndexPath: string;
  /** Directory holding binary document attachments. */
  attachmentsFilesDirPath: string;
  /** Directory holding extracted text caches for attachments. */
  attachmentsTextDirPath: string;
  /** Directory holding image attachments. */
  attachmentsImagesDirPath: string;
  /** Directory holding Figma-related attachment artifacts. */
  attachmentsFigmaDirPath: string;
}>;
