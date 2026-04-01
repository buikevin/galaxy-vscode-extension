/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared constants reused by document readers and cross-runtime helpers.
 */

import type { CuratedExtensionSubset } from "./extension-tools";
import type { GalaxyConfig } from "./config";
import type { AgentType } from "./protocol";

/** Default maximum number of characters returned by one sequential document read. */
export const DEFAULT_DOCUMENT_MAX_CHARS = 20_000;
/** Mapping from file extension to user-facing language labels used in session tracking and review prompts. */
export const SESSION_LANGUAGE_LABELS = Object.freeze<Record<string, string>>({
  ts: "TypeScript",
  tsx: "TypeScript (React)",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript (React)",
  py: "Python",
  pyw: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  cpp: "C++",
  c: "C",
  h: "C/C++ Header",
  swift: "Swift",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  md: "Markdown",
  mdx: "MDX",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "SASS",
  sql: "SQL",
  xml: "XML",
  dart: "Dart",
  lua: "Lua",
  r: "R",
  ex: "Elixir",
  exs: "Elixir",
  hs: "Haskell",
  clj: "Clojure",
  scala: "Scala",
  tf: "Terraform",
});
/** Maximum number of table rows emitted when converting spreadsheet-like documents. */
export const MAX_DOCUMENT_TABLE_ROWS = 120;
/** Maximum number of table columns emitted when converting spreadsheet-like documents. */
export const MAX_DOCUMENT_TABLE_COLS = 16;
/** Maximum number of characters preserved for one rendered spreadsheet cell. */
export const MAX_DOCUMENT_CELL_CHARS = 120;
/** Maximum number of validation output characters retained while streaming command results. */
export const MAX_VALIDATION_CAPTURE_CHARS = 20_000;
/** Candidate UI primitive directories checked when identifying shadcn/radix-style projects. */
export const BASE_COMPONENT_UI_DIRECTORY_CANDIDATES = Object.freeze([
  "components/ui",
  "src/components/ui",
  "app/components/ui",
]);
/** Maximum number of selected files converted into one attached context note. */
export const MAX_SELECTED_CONTEXT_FILES = 6;
/** Maximum number of characters read from one selected file when building context. */
export const MAX_SELECTED_CONTEXT_FILE_CHARS = 4_000;
/** Maximum number of terminal transcript characters retained for one command tab. */
export const MAX_TERMINAL_BUFFER_CHARS = 200_000;
/** Timeout in milliseconds used when probing command availability on PATH. */
export const COMMAND_AVAILABILITY_TIMEOUT_MS = 5_000;
/** Hosted model used for scoped coder sub-agent turns. */
export const CODER_SUB_AGENT_MODEL = "qwen3-coder-next:cloud";
/** Feature flag controlling whether selective multi-agent planning is active. */
export const ENABLE_SELECTIVE_MULTI_AGENT = false;
/** Number of retry attempts for the manual driver when transient network errors occur. */
export const MANUAL_DRIVER_RETRY_ATTEMPTS = 2;
/** Base delay in milliseconds between manual driver retries. */
export const MANUAL_DRIVER_RETRY_DELAY_MS = 800;
/** Maximum number of characters per file passed to the reviewer. */
export const REVIEWER_MAX_FILE_CHARS = 6_000;
/** Maximum number of files reviewed in one batch request. */
export const REVIEWER_MAX_BATCH_FILES = 4;
/** Maximum number of characters allowed in one reviewer request payload. */
export const REVIEWER_MAX_REQUEST_CHARS = 18_000;
/** Maximum number of validation-summary characters prepended to review prompts. */
export const REVIEWER_MAX_VALIDATION_SUMMARY_CHARS = 2_500;
/** Host used by the dedicated review model client. */
export const REVIEWER_HOST = "https://ollama.com";
/** Default hosted reviewer model. */
export const REVIEWER_MODEL = "qwen3-coder-next:cloud";
/** API key currently used for the hosted reviewer service. */
export const REVIEWER_API_KEY =
  "073a6aa5975f4cc5a68fe6c4a7f702f8.vhWYaW8O4o9JX-O-FLZatUGF";
/** Keep-alive duration for the hosted reviewer connection. */
export const REVIEWER_KEEP_ALIVE = "10m";
/** Decoder options used by the hosted reviewer model. */
export const REVIEWER_OPTIONS = Object.freeze({
  temperature: 0.1,
  top_p: 0.85,
  repeat_penalty: 1.05,
  num_predict: 4096,
});
/** System prompt used by the hosted code-review model. */
export const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer with 15+ years of experience across all programming languages.

Your job is to review code that was just written or modified, and provide clear, actionable feedback.

Only report issues that are directly supported by the provided code and validation context.
If you are unsure, omit the issue instead of speculating.
Do not propose unnecessary rewrites when a smaller fix would be enough.

For each file, check for:
1. Logic errors and bugs
2. Missing edge cases
3. Security vulnerabilities
4. Type/runtime errors
5. Code quality
6. Cross-file consistency

Output format:
- [CRITICAL] \`filename:line\` - Clear description and how to fix
- [WARNING] \`filename:line\` - Clear description and suggestion
- [INFO] \`filename\` - General observation or improvement

At the end, write one of:
- ✅ LGTM
- ⚠️ Issues found - N critical, M warnings

Be specific and concise. Skip trivial style comments.
Respond in the same language as the code comments/strings.`;
/** Bridge host used by the local Figma import server. */
export const FIGMA_BRIDGE_HOST = "127.0.0.1";
/** Bridge port used by the local Figma import server. */
export const FIGMA_BRIDGE_PORT = 47123;
/** Prefix used to encode imported Figma ids into clipboard text. */
export const FIGMA_CLIPBOARD_PREFIX = "[[galaxy-code:figma-import:";
/** Suffix used to encode imported Figma ids into clipboard text. */
export const FIGMA_CLIPBOARD_SUFFIX = "]]";
/** Maximum number of nodes serialized into prompt-safe raw Figma HTML. */
export const FIGMA_MAX_PROMPT_NODES = 260;
/** Maximum number of characters preserved in prompt-safe raw Figma HTML. */
export const FIGMA_MAX_PROMPT_HTML_CHARS = 18_000;
/** Maximum number of text snippets collected from one imported design tree. */
export const FIGMA_MAX_TEXT_SNIPPETS = 24;
/** Maximum number of metadata lines emitted for one attached Figma record. */
export const FIGMA_MAX_METADATA_LINES = 32;
/** Maximum number of non-Figma attachments included in one prompt context block. */
export const MAX_CONTEXT_ATTACHMENTS = 4;
/** Maximum number of attachment characters preserved in fallback prompt snippets. */
export const MAX_ATTACHMENT_CHARS = 6_000;
/** Maximum number of semantic snippets returned per attachment query. */
export const MAX_ATTACHMENT_SNIPPETS = 2;
/** Target chunk size used when splitting attachment text for semantic indexing. */
export const ATTACHMENT_CHUNK_TARGET_CHARS = 1_400;
/** Minimum chunk size retained before rolling content into the next semantic chunk. */
export const ATTACHMENT_CHUNK_MIN_CHARS = 240;
/** Character overlap preserved between adjacent attachment chunks. */
export const ATTACHMENT_CHUNK_OVERLAP_CHARS = 180;
/** Timeout in milliseconds for Chroma attachment indexing and query operations. */
export const ATTACHMENT_CHROMA_TIMEOUT_MS = 2_500;
/** Manual embedding function placeholder required by Chroma when embeddings are supplied explicitly. */
export const MANUAL_EMBEDDING_FUNCTION = Object.freeze({
  name: "galaxy-manual-embedding",
  async generate(): Promise<number[][]> {
    throw new Error("Manual embeddings only. Provide embeddings explicitly.");
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error(
      "Manual embeddings only. Provide query embeddings explicitly.",
    );
  },
});
/** File extensions treated as directly readable text attachments without document conversion. */
export const TEXT_ATTACHMENT_EXTENSIONS = Object.freeze(
  new Set([
    ".txt",
    ".md",
    ".mdx",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".css",
    ".scss",
    ".html",
    ".htm",
    ".sql",
    ".sh",
    ".py",
    ".java",
    ".kt",
    ".go",
    ".rs",
    ".php",
    ".rb",
    ".cs",
    ".swift",
    ".dart",
  ]),
);
/** Curated extension subsets that remain exposed while some extensions lack LM-tool registry coverage. */
export const CURATED_MCP_EXTENSION_SUBSETS: Readonly<
  Record<string, CuratedExtensionSubset>
> = Object.freeze({
  "eamodio.gitlens": Object.freeze({
    label: "GitKraken / GitLens MCP",
    description:
      "Curated Git workflows from GitLens, preferred as a compact fallback while Galaxy waits for VS Code to surface MCP-backed tools through the public LM tool registry.",
    commands: Object.freeze([
      "gitlens.git.status",
      "gitlens.git.checkout",
      "gitlens.git.branch",
      "gitlens.git.merge",
      "gitlens.git.rebase",
      "gitlens.startWork",
      "gitlens.startReview",
      "gitlens.openPullRequestOnRemote",
      "gitlens.createPullRequestOnRemote",
    ]),
  }),
  "nrwl.angular-console": Object.freeze({
    label: "Nx MCP Server",
    description:
      "Curated Nx workspace tools from Nx Console. These remain a compact fallback until Nx surfaces runtime LM tools through MCP discovery.",
    commands: Object.freeze([
      "nx.run",
      "nx.run-many",
      "nx.generate.ui",
      "nx.affected.test",
      "nx.affected.build",
      "nx.affected.lint",
      "nxConsole.showProblems",
      "nx.configureMcpServer",
    ]),
  }),
  "mongodb.mongodb-vscode": Object.freeze({
    label: "MongoDB MCP Server",
    description:
      "Curated MongoDB MCP management tools from the MongoDB extension. These are used until MongoDB LM tools are surfaced in the runtime registry.",
    commands: Object.freeze([
      "mdb.startMCPServer",
      "mdb.stopMCPServer",
      "mdb.getMCPServerConfig",
    ]),
  }),
});

/** Default persisted configuration used when the extension boots without a saved config file. */
export const DEFAULT_CONFIG: GalaxyConfig = {
  agent: [
    { type: "manual", apiKey: "" },
    { type: "claude", model: "claude-sonnet-4-5-20250929", apiKey: "" },
    { type: "gemini", model: "gemini-2.5-flash", apiKey: "" },
    { type: "codex", model: "gpt-4o", apiKey: "" },
    { type: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" },
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
  validation: {
    lint: [],
    staticCheck: [],
    test: [],
    build: [],
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

/** Maximum number of automatic validation-driven repair attempts per turn. */
export const MAX_AUTO_REPAIR_ATTEMPTS = 2;
/** Maximum number of automatic review-driven repair attempts per turn. */
export const MAX_AUTO_REVIEW_REPAIR_ATTEMPTS = 1;
/** Maximum number of auto-continue attempts after an empty assistant result. */
export const MAX_EMPTY_CONTINUE_ATTEMPTS = 3;
/** Maximum number of runtime log entries retained in memory. */
export const MAX_LOG_ENTRIES = 120;
/** Maximum number of characters persisted for one debug block dump. */
export const MAX_DEBUG_BLOCK_CHARS = 20_000;
/** Maximum number of command-output characters preserved in command context. */
export const MAX_COMMAND_CONTEXT_OUTPUT_CHARS = 12_000;
/** Maximum number of transcript messages mirrored to the webview on init. */
export const MAX_WEBVIEW_MESSAGE_COUNT = 160;
/** Maximum number of tool-content characters preserved when mirroring transcript messages. */
export const MAX_WEBVIEW_TOOL_CONTENT_CHARS = 12_000;
/** Maximum number of characters preserved for one tool param string in the webview. */
export const MAX_WEBVIEW_PARAM_STRING_CHARS = 1_200;
/** Maximum number of array items mirrored from tool metadata into the webview. */
export const MAX_WEBVIEW_META_ARRAY_ITEMS = 24;
/** View-container id that owns the Galaxy sidebar contributions. */
export const GALAXY_VIEW_CONTAINER_ID = "galaxy-code-sidebar";
/** Tree view id used for selectable context files. */
export const CONTEXT_FILES_VIEW_ID = "galaxy-code.contextFilesView";
/** Tree view id used for tracked changed files. */
export const CHANGED_FILES_VIEW_ID = "galaxy-code.changedFilesView";
/** Internal command id used to open one context file from the native tree. */
export const OPEN_CONTEXT_FILE_COMMAND_ID =
  "galaxy-code.internal.openContextFile";
/** Internal command id used to open one tracked diff from the native tree. */
export const OPEN_CHANGED_FILE_DIFF_COMMAND_ID =
  "galaxy-code.internal.openChangedFileDiff";
/** Command id used to toggle code review in the command palette. */
export const TOGGLE_REVIEW_COMMAND_ID = "galaxy-code.toggleReview";
/** Command id used to toggle validation in the command palette. */
export const TOGGLE_VALIDATION_COMMAND_ID = "galaxy-code.toggleValidation";
/** Root VS Code configuration section for the extension. */
export const GALAXY_CONFIGURATION_SECTION = "galaxyCode";
/** Setting key storing whether review is enabled. */
export const QUALITY_REVIEW_SETTING_KEY = "quality.reviewEnabled";
/** Setting key storing whether validation is enabled. */
export const QUALITY_VALIDATE_SETTING_KEY = "quality.validateEnabled";
/** Setting key storing whether full-access mode is enabled. */
export const QUALITY_FULL_ACCESS_SETTING_KEY = "quality.fullAccessEnabled";
/** Workspace-state key storing the currently selected agent. */
export const SELECTED_AGENT_STORAGE_KEY = "galaxy-code.selectedAgent";
/** Supported agent ids exposed in quick pick and runtime routing. */
export const AGENT_TYPES: readonly AgentType[] = Object.freeze([
  "manual",
  "ollama",
  "gemini",
  "claude",
  "codex",
]);
