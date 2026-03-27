import type { AgentType, ExtensionToolGroup, ToolToggles } from '../shared/protocol';

export interface AgentConfig {
  type: AgentType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface QualityConfig {
  review: boolean;
  test: boolean;
}

export interface ToolSafetyConfig {
  enableGitWriteTools: boolean;
  enableDeletePathTool: boolean;
  enableProjectScaffoldTool: boolean;
  enableProjectCommandTool: boolean;
  requireApprovalForGitPull: boolean;
  requireApprovalForGitPush: boolean;
  requireApprovalForGitCheckout: boolean;
  requireApprovalForDeletePath: boolean;
  requireApprovalForScaffold: boolean;
  requireApprovalForProjectCommand: boolean;
}

export interface ToolCapabilityConfig {
  readProject: boolean;
  editFiles: boolean;
  runCommands: boolean;
  webResearch: boolean;
  validation: boolean;
  review: boolean;
  vscodeNative: boolean;
  galaxyDesign: boolean;
}

export interface GalaxyConfig {
  agent: AgentConfig[];
  quality: QualityConfig;
  toolSafety: ToolSafetyConfig;
  toolCapabilities: ToolCapabilityConfig;
  toolToggles: ToolToggles;
  extensionToolToggles: Readonly<Record<string, boolean>>;
  availableExtensionToolGroups?: readonly ExtensionToolGroup[];
  maxToolRounds: number | null;
}

export const DEFAULT_CONFIG: GalaxyConfig = {
  agent: [
    { type: 'manual', apiKey: '' },
    { type: 'claude', model: 'claude-sonnet-4-5-20250929', apiKey: '' },
    { type: 'gemini', model: 'gemini-2.5-flash', apiKey: '' },
    { type: 'codex', model: 'gpt-4o', apiKey: '' },
    { type: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434' },
  ],
  quality: {
    review: true,
    test: true,
  },
  toolCapabilities: {
    readProject: true,
    editFiles: true,
    runCommands: true,
    webResearch: true,
    validation: true,
    review: true,
    vscodeNative: true,
    galaxyDesign: true,
  },
  toolToggles: {
    read_file: true,
    find_test_files: true,
    get_latest_test_failure: true,
    get_latest_review_findings: true,
    get_next_review_finding: true,
    dismiss_review_finding: true,
    write_file: true,
    insert_file_at_line: true,
    edit_file_range: true,
    multi_edit_file_ranges: true,
    grep: true,
    list_dir: true,
    head: true,
    tail: true,
    read_document: true,
    search_web: true,
    extract_web: true,
    map_web: true,
    crawl_web: true,
    run_terminal_command: true,
    await_terminal_command: true,
    get_terminal_output: true,
    kill_terminal_command: true,
    git_status: true,
    git_diff: true,
    git_add: true,
    git_commit: true,
    git_push: true,
    git_pull: true,
    git_checkout: true,
    run_project_command: true,
    validate_code: true,
    request_code_review: true,
    vscode_open_diff: true,
    vscode_show_problems: true,
    vscode_workspace_search: true,
    vscode_find_references: true,
    search_extension_tools: true,
    activate_extension_tools: true,
    galaxy_design_project_info: true,
    galaxy_design_registry: true,
    galaxy_design_init: true,
    galaxy_design_add: true,
  },
  extensionToolToggles: {},
  maxToolRounds: null,
  toolSafety: {
    enableGitWriteTools: true,
    enableDeletePathTool: false,
    enableProjectScaffoldTool: true,
    enableProjectCommandTool: true,
    requireApprovalForGitPull: true,
    requireApprovalForGitPush: true,
    requireApprovalForGitCheckout: true,
    requireApprovalForDeletePath: true,
    requireApprovalForScaffold: true,
    requireApprovalForProjectCommand: false,
  },
};
