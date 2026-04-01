/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for workspace tooling wrappers extracted from the extension entrypoint.
 */

import type { ToolResult } from "../tools/entities/file-tools";
import type { ExtensionToolGroup, HostMessage, LogEntry } from "./protocol";

/** Optional line range used when revealing one file in the editor. */
export type WorkspaceFileRevealRange = Readonly<{
  /** One-based first line to reveal. */
  startLine: number;
  /** One-based last line to reveal. */
  endLine: number;
}>;

/** Formats an absolute file path into a workspace-relative label. */
export type RelativePathFormatter = (filePath: string) => string;

/** Writes one runtime log entry originating from a workspace tooling action. */
export type HostLogWriter = (level: LogEntry["kind"], message: string) => void;

/** Parameters required to open one tracked diff and route failures back into the webview. */
export type OpenTrackedDiffRequest = Readonly<{
  /** Absolute file path whose tracked diff should be opened. */
  filePath: string;
  /** Formats absolute paths for user-facing logs and errors. */
  asWorkspaceRelative: RelativePathFormatter;
  /** Appends one runtime log line for the diff action. */
  appendLog: HostLogWriter;
  /** Posts one host error message when no tracked snapshot exists. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Parameters required to expose tracked diff opening through a tool result wrapper. */
export type OpenTrackedDiffToolRequest = Readonly<{
  /** Absolute workspace path used to resolve relative input paths. */
  workspacePath: string;
  /** Relative or absolute file path requested by the tool call. */
  filePath: string;
  /** Formats absolute paths for user-facing tool output. */
  asWorkspaceRelative: RelativePathFormatter;
  /** Opens the tracked diff after the file path has been resolved. */
  openTrackedDiff: (filePath: string) => Promise<void>;
}>;

/** Parameters required to summarize diagnostics in the Problems panel. */
export type ShowProblemsRequest = Readonly<{
  /** Absolute workspace path used to resolve an optional target file path. */
  workspacePath: string;
  /** Optional relative or absolute file path to scope diagnostics to one file. */
  filePath?: string;
  /** Formats absolute paths for user-facing tool output. */
  asWorkspaceRelative: RelativePathFormatter;
}>;

/** Search options forwarded to the native workspace search wrapper. */
export type WorkspaceSearchOptions = Readonly<{
  /** Optional glob include pattern forwarded to VS Code search. */
  includes?: string;
  /** Upper bound on returned matches. */
  maxResults?: number;
  /** Whether the search query should be treated as a regular expression. */
  isRegex?: boolean;
  /** Whether the search should be case-sensitive. */
  isCaseSensitive?: boolean;
  /** Whether whole-word matching should be enabled. */
  matchWholeWord?: boolean;
}>;

/** Parameters required to run one workspace search through the native search UI. */
export type WorkspaceSearchRequest = Readonly<{
  /** Absolute workspace path used to resolve result labels. */
  workspacePath: string;
  /** Search query text or regular expression. */
  query: string;
  /** Formats absolute paths for user-facing tool output. */
  asWorkspaceRelative: RelativePathFormatter;
  /** Optional search execution settings. */
  options?: WorkspaceSearchOptions;
}>;

/** Optional symbol-location hints used by the native references wrapper. */
export type FindReferencesOptions = Readonly<{
  /** One-based line number used to derive the reference position. */
  line?: number;
  /** One-based character number used to derive the reference position. */
  character?: number;
  /** Fallback symbol text used when no explicit line and character are provided. */
  symbol?: string;
  /** Upper bound on returned references. */
  maxResults?: number;
}>;

/** Parameters required to find references through the native VS Code provider. */
export type FindReferencesRequest = Readonly<{
  /** Absolute workspace path used to resolve relative input paths. */
  workspacePath: string;
  /** Relative or absolute file path containing the symbol. */
  filePath: string;
  /** Formats absolute paths for user-facing tool output. */
  asWorkspaceRelative: RelativePathFormatter;
  /** Optional symbol-location hints used to resolve the position. */
  options?: FindReferencesOptions;
}>;

/** Parameters required to invoke one public VS Code extension command. */
export type ExecuteExtensionCommandRequest = Readonly<{
  /** Command id exposed by the target extension. */
  commandId: string;
  /** Human-readable command title used in result text. */
  title: string;
  /** Extension id that owns the command. */
  extensionId: string;
  /** Appends one runtime log line for the command execution. */
  appendLog: HostLogWriter;
}>;

/** Parameters required to invoke one VS Code language-model tool. */
export type InvokeLanguageModelToolRequest = Readonly<{
  /** Tool name exposed by the target extension. */
  toolName: string;
  /** Human-readable tool title used in result text. */
  title: string;
  /** Extension id that owns the tool. */
  extensionId: string;
  /** Structured input payload forwarded to the LM tool. */
  input: Readonly<Record<string, unknown>>;
  /** Appends one runtime log line for the tool invocation. */
  appendLog: HostLogWriter;
}>;

/** Provider-owned callbacks and state accessors required to build workspace tooling actions. */
export type ProviderWorkspaceToolActionBindings = Readonly<{
  /** Absolute workspace path used to resolve relative file paths and load tool state. */
  workspacePath: string;
  /** Extension id used to discover locally contributed extension tools. */
  extensionId: string;
  /** Returns the latest extension tool toggle map from provider state. */
  getExtensionToolToggles: () => Readonly<Record<string, boolean>>;
  /** Stores the refreshed extension tool groups back into provider state. */
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
  /** Applies the next extension tool toggle map into provider state. */
  applyExtensionToolToggles: (
    next: Readonly<Record<string, boolean>>,
    opts?: Readonly<{ logMessage?: string }>,
  ) => Promise<void>;
  /** Formats absolute file paths into workspace-relative labels. */
  asWorkspaceRelative: RelativePathFormatter;
  /** Appends one runtime log entry for workspace-tool actions. */
  appendLog: HostLogWriter;
  /** Posts one host-side message back into the webview. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Provider-bound workspace tooling actions exposed by extracted host helpers. */
export type ProviderWorkspaceToolActions = Readonly<{
  /** Resolves a relative workspace file path against the active workspace root. */
  resolveWorkspaceFilePath: (filePath: string) => string;
  /** Opens one workspace file in the editor. */
  openWorkspaceFile: (filePath: string) => Promise<void>;
  /** Reveals one workspace file and optionally focuses a range. */
  revealFile: (
    filePath: string,
    range?: WorkspaceFileRevealRange,
  ) => Promise<void>;
  /** Opens one tracked diff in the native VS Code diff viewer. */
  openTrackedDiff: (filePath: string) => Promise<void>;
  /** Wraps tracked diff opening in the normalized tool-result contract. */
  openTrackedDiffTool: (filePath: string) => Promise<ToolResult>;
  /** Returns current diagnostics in the Problems panel. */
  showProblemsTool: (filePath?: string) => Promise<ToolResult>;
  /** Runs one workspace search through the native VS Code search UI. */
  workspaceSearchTool: (
    query: string,
    options?: WorkspaceSearchOptions,
  ) => Promise<ToolResult>;
  /** Finds symbol references using the native VS Code provider. */
  findReferencesTool: (
    filePath: string,
    options?: FindReferencesOptions,
  ) => Promise<ToolResult>;
  /** Executes one public command exposed by another VS Code extension. */
  executeExtensionCommandTool: (
    commandId: string,
    title: string,
    extensionId: string,
  ) => Promise<ToolResult>;
  /** Invokes one VS Code language-model tool exposed by another extension. */
  invokeLanguageModelToolTool: (
    toolName: string,
    title: string,
    extensionId: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<ToolResult>;
  /** Refreshes the cached extension tool catalog stored in provider state. */
  refreshExtensionToolGroups: () => void;
  /** Searches locally contributed extension tools and refreshes provider state. */
  searchExtensionToolsTool: (
    query: string,
    maxResults?: number,
  ) => Promise<ToolResult>;
  /** Activates locally contributed extension tools and refreshes provider state. */
  activateExtensionToolsTool: (
    toolKeys: readonly string[],
  ) => Promise<ToolResult>;
}>;
