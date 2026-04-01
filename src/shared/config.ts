/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared configuration entities used by the VS Code extension host, runtime, and validation layers.
 */

import type { AgentType, ExtensionToolGroup, ToolToggles } from './protocol';

/** Provider-specific configuration for one supported agent. */
export interface AgentConfig {
  /** Agent identifier used to select the runtime driver. */
  type: AgentType;
  /** Optional API key used by hosted providers. */
  apiKey?: string;
  /** Optional provider model name override. */
  model?: string;
  /** Optional base URL override for self-hosted providers. */
  baseUrl?: string;
}

/** Quality-gate preferences persisted in user config. */
export interface QualityConfig {
  /** Whether code review runs after an agent turn. */
  review: boolean;
  /** Whether validation runs after an agent turn. */
  test: boolean;
}

/** Tool-safety preferences controlling which powerful tools are allowed. */
export interface ToolSafetyConfig {
  /** Whether git write operations may be used. */
  enableGitWriteTools: boolean;
  /** Whether destructive delete-path operations may be used. */
  enableDeletePathTool: boolean;
  /** Whether scaffold tools may generate new project skeletons. */
  enableProjectScaffoldTool: boolean;
  /** Whether project-command execution is enabled. */
  enableProjectCommandTool: boolean;
  /** Whether git pull always requires explicit approval. */
  requireApprovalForGitPull: boolean;
  /** Whether git push always requires explicit approval. */
  requireApprovalForGitPush: boolean;
  /** Whether git checkout always requires explicit approval. */
  requireApprovalForGitCheckout: boolean;
  /** Whether delete-path operations require explicit approval. */
  requireApprovalForDeletePath: boolean;
  /** Whether scaffold operations require explicit approval. */
  requireApprovalForScaffold: boolean;
  /** Whether project-command execution requires explicit approval. */
  requireApprovalForProjectCommand: boolean;
}

/** High-level capability switches used to enable or disable tool groups. */
export interface ToolCapabilityConfig {
  /** Whether project-reading tools are enabled. */
  readProject: boolean;
  /** Whether file-editing tools are enabled. */
  editFiles: boolean;
  /** Whether command-execution tools are enabled. */
  runCommands: boolean;
  /** Whether web-research tools are enabled. */
  webResearch: boolean;
  /** Whether validation tools are enabled. */
  validation: boolean;
  /** Whether code-review tools are enabled. */
  review: boolean;
  /** Whether VS Code native tools are enabled. */
  vscodeNative: boolean;
  /** Whether Galaxy design tools are enabled. */
  galaxyDesign: boolean;
}

/** Optional project-specific validation command preferences. */
export interface ValidationPreferencesConfig {
  /** Preferred lint command names or scripts. */
  lint: readonly string[];
  /** Preferred static-check or typecheck command names or scripts. */
  staticCheck: readonly string[];
  /** Preferred test command names or scripts. */
  test: readonly string[];
  /** Preferred build command names or scripts. */
  build: readonly string[];
}

/** Complete persisted configuration for the VS Code extension. */
export interface GalaxyConfig {
  /** Agent provider configurations available to the extension. */
  agent: AgentConfig[];
  /** Quality-gate preferences. */
  quality: QualityConfig;
  /** Tool-safety preferences. */
  toolSafety: ToolSafetyConfig;
  /** High-level tool capability switches. */
  toolCapabilities: ToolCapabilityConfig;
  /** Validation command preferences. */
  validation: ValidationPreferencesConfig;
  /** Per-tool toggle state persisted for built-in tools. */
  toolToggles: ToolToggles;
  /** Per-tool toggle state persisted for extension-contributed tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Optional discovered extension tool groups cached in memory. */
  availableExtensionToolGroups?: readonly ExtensionToolGroup[];
  /** Optional limit on tool-call rounds per turn. */
  maxToolRounds: number | null;
}

/** Backward-compatible persisted config shape accepted from disk. */
export type RawGalaxyConfig = Partial<GalaxyConfig> & {
  /** Legacy boolean alias for `quality.review`. */
  review?: boolean;
  /** Legacy boolean alias for `quality.test`. */
  test?: boolean;
  /** Legacy boolean alias for `toolSafety.enableGitWriteTools`. */
  git?: boolean;
};
