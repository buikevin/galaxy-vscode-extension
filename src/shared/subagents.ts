/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Role registry, default model routing, and tool profiles for sub-agent orchestration.
 */

import type { GalaxyConfig } from "./config";
import {
  BA_SUB_AGENT_MODEL,
  CODER_SUB_AGENT_MODEL,
  MAIN_SUB_AGENT_MODEL,
  PLANNING_SUB_AGENT_MODEL,
  PROFILER_SUB_AGENT_MODEL,
  REVIEW_SUB_AGENT_MODEL,
  SA_SUB_AGENT_MODEL,
  TESTING_SUB_AGENT_MODEL,
} from "./constants";
import type {
  SelectiveMultiAgentSubtask,
  SubagentHandoffRecord,
  SubagentHandoffStatus,
  SubagentMemoryProfile,
  SubagentRoleDefinition,
  SubagentRoleId,
  SubagentToolProfile,
  TaskMemoryTurnKind,
} from "./runtime";

const HOSTED_OLLAMA_BASE_URL = "https://ollama.com";

const SUBAGENT_MAX_TOOL_ROUNDS: Readonly<Record<SubagentRoleId, number | null>> = Object.freeze({
  main: null,
  ba: 2,
  profiler: 4,
  planning: 5,
  sa: 6,
  coding: 18,
  testing: 8,
  review: 5,
});

const SUBAGENT_CHAT_TIMEOUT_MS: Readonly<Record<SubagentRoleId, number | null>> = Object.freeze({
  main: null,
  ba: 120_000,
  profiler: 150_000,
  planning: 180_000,
  sa: 180_000,
  coding: 240_000,
  testing: 180_000,
  review: 180_000,
});

const SUBAGENT_FALLBACK_MODELS: Readonly<Record<SubagentRoleId, readonly string[]>> = Object.freeze({
  main: Object.freeze([]),
  ba: Object.freeze(["gpt-oss:120b-cloud", "gemma4:31b-cloud"]),
  profiler: Object.freeze(["gpt-oss:120b-cloud", "gemma4:31b-cloud"]),
  planning: Object.freeze(["gpt-oss:120b-cloud", "gemma4:31b-cloud"]),
  sa: Object.freeze(["gpt-oss:120b-cloud", "deepseek-v4-pro:cloud", "gemma4:31b-cloud"]),
  coding: Object.freeze(["qwen3-coder-next:cloud", "gpt-oss:120b-cloud"]),
  testing: Object.freeze(["qwen3-coder-next:cloud", "gpt-oss:120b-cloud"]),
  review: Object.freeze(["gemma4:31b-cloud", "gpt-oss:120b-cloud"]),
});

const FULL_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: true,
  webResearch: true,
  validation: true,
  review: true,
  vscodeNative: true,
  galaxyDesign: true,
});

const DISCOVERY_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: false,
  webResearch: false,
  validation: false,
  review: false,
  vscodeNative: false,
  galaxyDesign: false,
});

const ARCHITECTURE_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: false,
  webResearch: false,
  validation: false,
  review: false,
  vscodeNative: false,
  galaxyDesign: false,
});

const CODING_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: false,
  webResearch: false,
  validation: false,
  review: false,
  vscodeNative: false,
  galaxyDesign: false,
});

const TESTING_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: true,
  webResearch: false,
  validation: true,
  review: false,
  vscodeNative: false,
  galaxyDesign: false,
});

const REVIEW_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: false,
  webResearch: false,
  validation: false,
  review: true,
  vscodeNative: false,
  galaxyDesign: false,
});

const READ_AND_MEMORY_TOOLS = Object.freeze([
  "read_file",
  "grep",
  "list_dir",
  "head",
  "tail",
  "read_document",
  "query_shared_memory",
  "query_workflow_graph",
  "write_agent_handoff",
]);

const SUBAGENT_ALLOWED_TOOL_NAMES: Readonly<Record<SubagentRoleId, readonly string[] | null>> = Object.freeze({
  main: null,
  ba: Object.freeze([
    "read_file",
    "grep",
    "list_dir",
    "read_document",
    "query_shared_memory",
    "query_workflow_graph",
    "write_agent_handoff",
  ]),
  profiler: Object.freeze([
    ...READ_AND_MEMORY_TOOLS,
    "find_test_files",
    "inspect_workspace_environment",
  ]),
  planning: Object.freeze([
    "read_file",
    "grep",
    "list_dir",
    "read_document",
    "query_shared_memory",
    "query_workflow_graph",
    "write_agent_handoff",
  ]),
  sa: Object.freeze([
    ...READ_AND_MEMORY_TOOLS,
    "find_test_files",
  ]),
  coding: Object.freeze([
    ...READ_AND_MEMORY_TOOLS,
    "find_test_files",
    "get_latest_test_failure",
    "claim_file_scope",
    "write_file",
    "insert_file_at_line",
    "multi_edit_file_ranges",
    "diff_file",
  ]),
  testing: Object.freeze([
    ...READ_AND_MEMORY_TOOLS,
    "find_test_files",
    "get_latest_test_failure",
    "claim_file_scope",
    "write_file",
    "insert_file_at_line",
    "multi_edit_file_ranges",
    "diff_file",
    "validate_code",
    "run_validation_suite",
    "run_in_terminal",
    "run_project_command",
    "run_terminal_command",
    "await_terminal_command",
    "get_terminal_output",
    "kill_terminal_command",
  ]),
  review: Object.freeze([
    ...READ_AND_MEMORY_TOOLS,
    "get_change_summary",
    "diff_file",
    "get_latest_review_findings",
    "request_code_review",
  ]),
});

export const TASK_MEMORY_TURN_KINDS: readonly TaskMemoryTurnKind[] = Object.freeze([
  "analysis",
  "implementation",
  "review",
  "validation",
  "repair",
  "subagent_handoff",
  "clarification",
]);

const ALL_MEMORY_TURN_KINDS = TASK_MEMORY_TURN_KINDS;

function memoryProfile(
  readableTurnKinds: readonly TaskMemoryTurnKind[],
  guidance: string,
): SubagentMemoryProfile {
  return Object.freeze({
    readableTurnKinds: Object.freeze([...readableTurnKinds]),
    mustVerifyWorkspaceEvidence: true,
    guidance,
  });
}

const MAIN_MEMORY_PROFILE = memoryProfile(
  ALL_MEMORY_TURN_KINDS,
  "Read any prior project decision, handoff, validation, review, or implementation memory needed to orchestrate the turn.",
);

const DISCOVERY_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "analysis"],
  "Prioritize requirement decisions, user clarifications, and previous planning context before asking the user again.",
);

const PROFILER_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "analysis", "implementation", "validation", "review", "repair"],
  "Reuse prior ProjectProfile handoffs when fresh, but verify manifest/config/CI evidence before downstream roles depend on it.",
);

const PLANNING_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "analysis", "implementation", "review", "validation"],
  "Use decisions, previous handoffs, and recent validation/review outcomes to plan the next execution boundary.",
);

const ARCHITECTURE_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "analysis", "implementation", "review", "validation"],
  "Read decisions, prior architecture notes, implementation handoffs, and verification outcomes before selecting boundaries.",
);

const CODING_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "implementation", "review", "validation", "repair"],
  "Use accepted decisions and handoffs as implementation constraints, then verify referenced files before editing.",
);

const TESTING_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "implementation", "validation", "repair"],
  "Focus on implementation handoffs, known failures, repair attempts, and validation memory relevant to the changed surface.",
);

const REVIEW_MEMORY_PROFILE = memoryProfile(
  ["clarification", "subagent_handoff", "implementation", "review", "validation", "repair"],
  "Read implementation, validation, prior review, and repair memory before deciding whether the work is complete.",
);

function manualModel(model: string): SubagentRoleDefinition["model"] {
  return Object.freeze({
    agentType: "manual",
    model,
    baseUrl: HOSTED_OLLAMA_BASE_URL,
  });
}

/** Registry of every first-class sub-agent role supported by the runtime. */
export const SUBAGENT_ROLE_REGISTRY: Readonly<Record<SubagentRoleId, SubagentRoleDefinition>> = Object.freeze({
  main: Object.freeze({
    id: "main",
    title: "Main Agent",
    mission: "Own turn-level orchestration, decide whether to delegate, and keep the final response coherent.",
    model: manualModel(MAIN_SUB_AGENT_MODEL),
    toolProfile: FULL_TOOL_PROFILE,
    memoryProfile: MAIN_MEMORY_PROFILE,
    canAskUser: true,
    canEditFiles: true,
  }),
  ba: Object.freeze({
    id: "ba",
    title: "Business Analyst Agent",
    mission: "Clarify requirements, user flows, constraints, acceptance criteria, and blocking product decisions before implementation starts.",
    model: manualModel(BA_SUB_AGENT_MODEL),
    toolProfile: DISCOVERY_TOOL_PROFILE,
    memoryProfile: DISCOVERY_MEMORY_PROFILE,
    canAskUser: true,
    canEditFiles: false,
  }),
  profiler: Object.freeze({
    id: "profiler",
    title: "Project Profiler Agent",
    mission: "Build an evidence-based ProjectProfile covering languages, frameworks, architecture style, validation units, commands, environment needs, uncertainty, and confidence without editing files.",
    model: manualModel(PROFILER_SUB_AGENT_MODEL),
    toolProfile: DISCOVERY_TOOL_PROFILE,
    memoryProfile: PROFILER_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
  planning: Object.freeze({
    id: "planning",
    title: "Planning Agent",
    mission: "Break the request into an execution plan, sequencing, risks, and handoff notes without editing project files.",
    model: manualModel(PLANNING_SUB_AGENT_MODEL),
    toolProfile: DISCOVERY_TOOL_PROFILE,
    memoryProfile: PLANNING_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
  sa: Object.freeze({
    id: "sa",
    title: "Solution Architect Agent",
    mission: "Choose the technical approach, module boundaries, contracts, and integration strategy using current project evidence.",
    model: manualModel(SA_SUB_AGENT_MODEL),
    toolProfile: ARCHITECTURE_TOOL_PROFILE,
    memoryProfile: ARCHITECTURE_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
  coding: Object.freeze({
    id: "coding",
    title: "Coding Agent",
    mission: "Implement the scoped code changes with the smallest practical blast radius and preserve existing project conventions.",
    model: manualModel(CODER_SUB_AGENT_MODEL),
    toolProfile: CODING_TOOL_PROFILE,
    memoryProfile: CODING_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: true,
  }),
  testing: Object.freeze({
    id: "testing",
    title: "Testing Agent",
    mission: "Run or add focused validation for the changed surface and fix test-related defects within the assigned scope.",
    model: manualModel(TESTING_SUB_AGENT_MODEL),
    toolProfile: TESTING_TOOL_PROFILE,
    memoryProfile: TESTING_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: true,
  }),
  review: Object.freeze({
    id: "review",
    title: "Review Agent",
    mission: "Review changed code as a code leader, identify correctness gaps, and decide whether the work is complete.",
    model: manualModel(REVIEW_SUB_AGENT_MODEL),
    toolProfile: REVIEW_TOOL_PROFILE,
    memoryProfile: REVIEW_MEMORY_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
});

/** Returns true when an unknown value is a supported sub-agent role id. */
export function isSubagentRoleId(value: unknown): value is SubagentRoleId {
  return typeof value === "string" && value in SUBAGENT_ROLE_REGISTRY;
}

/** Returns the static definition for one sub-agent role. */
export function getSubagentRoleDefinition(roleId: SubagentRoleId): SubagentRoleDefinition {
  return SUBAGENT_ROLE_REGISTRY[roleId];
}

/** Returns the effective model profile for one role after config overrides. */
export function resolveSubagentModelProfile(
  config: GalaxyConfig,
  roleId: SubagentRoleId,
): SubagentRoleDefinition["model"] {
  const role = getSubagentRoleDefinition(roleId);
  const override = config.subagentRoles?.[roleId];
  const model = override?.model?.trim() || role.model.model;
  const baseUrl = override?.baseUrl?.trim() || role.model.baseUrl;
  return Object.freeze({
    ...role.model,
    model,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

/** Returns a config copy whose model and available tool surface are narrowed for one role. */
export function buildSubagentRoleConfig(config: GalaxyConfig, roleId: SubagentRoleId): GalaxyConfig {
  const role = getSubagentRoleDefinition(roleId);
  const modelProfile = resolveSubagentModelProfile(config, roleId);
  const nextAgent = [...config.agent];
  const manualIndex = nextAgent.findIndex((agent) => agent.type === "manual");
  const baseUrl = modelProfile.baseUrl ?? HOSTED_OLLAMA_BASE_URL;

  if (manualIndex >= 0) {
    const existingManualAgent = nextAgent[manualIndex]!;
    nextAgent[manualIndex] = {
      type: "manual",
      model: modelProfile.model,
      baseUrl: config.subagentRoles?.[roleId]?.baseUrl?.trim()
        ? baseUrl
        : existingManualAgent.baseUrl ?? baseUrl,
      ...(existingManualAgent.apiKey ? { apiKey: existingManualAgent.apiKey } : {}),
    };
  } else {
    nextAgent.unshift({
      type: "manual",
      model: modelProfile.model,
      baseUrl,
      apiKey: "",
    });
  }

  return {
    ...config,
    activeSubagentRole: roleId,
    maxToolRounds: config.maxToolRounds ?? SUBAGENT_MAX_TOOL_ROUNDS[roleId],
    agent: nextAgent,
    toolCapabilities: Object.freeze({
      readProject: config.toolCapabilities.readProject && role.toolProfile.readProject,
      editFiles: config.toolCapabilities.editFiles && role.toolProfile.editFiles,
      runCommands: config.toolCapabilities.runCommands && role.toolProfile.runCommands,
      webResearch: config.toolCapabilities.webResearch && role.toolProfile.webResearch,
      validation: config.toolCapabilities.validation && role.toolProfile.validation,
      review: config.toolCapabilities.review && role.toolProfile.review,
      vscodeNative: config.toolCapabilities.vscodeNative && role.toolProfile.vscodeNative,
      galaxyDesign: config.toolCapabilities.galaxyDesign && role.toolProfile.galaxyDesign,
    }),
  };
}

/** Returns the provider chat timeout for the active role, or null when unrestricted. */
export function getSubagentChatTimeoutMs(config: Pick<GalaxyConfig, "activeSubagentRole">): number | null {
  return config.activeSubagentRole ? SUBAGENT_CHAT_TIMEOUT_MS[config.activeSubagentRole] : null;
}

/** Returns ordered retry models for one active sub-agent, preserving user/model override first. */
export function getSubagentRetryModels(
  config: Pick<GalaxyConfig, "activeSubagentRole">,
  primaryModel: string,
): readonly string[] {
  const primary = primaryModel.trim();
  if (!config.activeSubagentRole || !primary) {
    return primary ? Object.freeze([primary]) : Object.freeze([]);
  }
  const candidates = [primary, ...SUBAGENT_FALLBACK_MODELS[config.activeSubagentRole]];
  return Object.freeze([...new Set(candidates.filter((model) => model.trim()))]);
}

/** Returns the role-specific shared-memory read profile. */
export function getSubagentMemoryProfile(roleId: SubagentRoleId): SubagentMemoryProfile {
  return getSubagentRoleDefinition(roleId).memoryProfile;
}

/** Returns task-memory turn kinds the role may read by default. */
export function getAllowedMemoryTurnKinds(roleId: SubagentRoleId): readonly TaskMemoryTurnKind[] {
  return getSubagentMemoryProfile(roleId).readableTurnKinds;
}

/** Returns the exact agent-facing tool names allowed for one sub-agent role. */
export function getSubagentAllowedToolNames(roleId: SubagentRoleId): readonly string[] | null {
  return SUBAGENT_ALLOWED_TOOL_NAMES[roleId];
}

/** Formats shared-memory guidance for scoped sub-agent prompts. */
export function formatSubagentMemoryProfile(roleId: SubagentRoleId): string {
  const profile = getSubagentMemoryProfile(roleId);
  return [
    `- Readable memory kinds: ${profile.readableTurnKinds.join(", ")}`,
    `- ${profile.guidance}`,
    profile.mustVerifyWorkspaceEvidence
      ? "- Treat shared memory as advisory. If it references files or contradicts current workspace evidence, verify with read_file/grep/query_workflow_graph before acting."
      : "",
  ].filter(Boolean).join("\n");
}

/** Formats the role's allowed high-level tool groups for scoped prompts. */
export function formatSubagentToolProfile(roleId: SubagentRoleId): string {
  const profile = getSubagentRoleDefinition(roleId).toolProfile;
  return Object.entries(profile)
    .filter(([, enabled]) => enabled)
    .map(([name]) => `- ${name}`)
    .join("\n");
}

/** Formats role-specific quality guidance that belongs in the system prompt. */
export function formatSubagentQualityGuidance(roleId: SubagentRoleId): string {
  const lines: string[] = [];
  if (roleId === "profiler") {
    lines.push(
      "Produce a ProjectProfile handoff using open strings and explicit evidence; do not force languages, frameworks, or architecture styles into a fixed enum.",
      "Inspect only enough workspace evidence to profile the project: manifests/configs, scripts, CI files, source/test directories, service boundaries, lockfiles, and prior ProjectProfile memory.",
      "Use inspect_workspace_environment for read-only OS, path, environment-variable, and command availability/version evidence when downstream Coding or Testing depends on local environment readiness.",
      "Include languages, frameworks/libraries, architecture style, workspace units, declared validation/build commands, environment readiness, setup blockers, confidence, and uncertainties.",
      "For each validation unit, classify readiness as ready, partial, or not_ready. If dependencies or local binaries are missing, name the blocked scope and required setup without installing anything.",
      "For a new project that does not exist yet, mark the profile as planned and base it on approved user/SA decisions; for existing code, mark it as observed and cite file evidence.",
      "Do not edit files, install tools, run validation, or make architecture decisions. If evidence is weak, record uncertainty for BA/SA/Main instead of guessing.",
      "Finish with write_agent_handoff and include a JSON-like ProjectProfile section plus a concise narrative summary.",
    );
  }
  if (roleId === "testing") {
    lines.push(
      "Use run_validation_suite when project-level lint/typecheck/test/build evidence is needed; use validate_code only as a file-level fallback.",
      "When adding or repairing tests, mirror nearby test files for runner imports, async declarations, fixtures, reset hooks, and assertion style before claiming validation success.",
      "Ensure tests are isolated from shared module state: reset mutable stores between cases, use beforeEach when available, or design APIs so each test can create a fresh instance.",
      "Preserve user-stated test contracts: if expected values must come from current fixtures, runtime summaries, captured initial state, or public APIs, do not replace them with fixed literals.",
      "For project-level validation, prefer the available validation tool first; use available project command tools when validation needs an explicit script or setup command.",
      "For multi-package or apps/ workspaces, first map the validation topology: root package, each app/package root, its test/build script, and which files each runner owns. Validate framework app tests with their app-local script/config, and keep root validation scoped to root-owned tests.",
      "Before full validation, read the latest ProjectProfile/environment readiness handoff. If readiness is ready, run full validation. If partial, run only ready scopes and hand off blocked scopes. If not_ready, do not repeat setup or test commands; write a blocker handoff with the required setup.",
      "If an app-local validation cannot run because dependencies, framework runtime, or environment setup are missing, record the exact blocker and required setup in the handoff after one focused repair attempt; continue with other available validations instead of repeating the same failing command.",
      "If the same validation command in the same package fails twice after repair, stop repeating it. Either make one coherent fresh-read repair with current evidence or hand off the remaining blocker with the command output.",
      "Use the available project command tools for executable test/build checks and keep any environment inspection safe and read-only.",
      "If a targeted edit fails because the file changed, read the current file again. Then either retry multi_edit_file_ranges with fresh expected_range_content/anchors or use write_file with overwrite_existing=true for a coherent whole-file repair.",
      "When many failures come from source/test API mismatch in generated code, establish one consistent contract, repair the affected source and tests directly, then rerun validation until it passes or a real blocker is proven.",
      "When repairing generated tests, preserve existing source/module contracts and nearby test expectations unless the user explicitly requested a behavior change.",
    );
  }
  if (roleId === "review") {
    lines.push(
      "Use get_change_summary before judging changed code, then report only findings supported by current workspace evidence.",
    );
  }
  if (roleId === "coding") {
    lines.push(
      "If you create tests, mirror the project's existing test runner setup, imports, fixtures, and assertion style instead of inventing a parallel test style.",
      "When tests touch mutable in-memory state, add a reset helper or use isolated instances so tests do not depend on execution order.",
      "Preserve user-stated test contracts: if expected values must be derived from fixtures, runtime outputs, captured state, or public APIs, keep them derived instead of fixed literals.",
      "Use multi_edit_file_ranges for targeted changes in existing files, including one-change edits with a single-element edits array. Keep related same-file edits in one multi_edit_file_ranges call.",
      "If an existing generated file needs a coherent full rewrite, read it first and use write_file with overwrite_existing=true instead of repeated stale range edits.",
      "Tests should stay within behavior explicitly requested by the user or already present in nearby tests.",
      "For a simple or frontend-prototype scope without an approved architecture handoff, prefer the smallest helper/component/data changes that satisfy the request.",
      "If a Testing Agent is in the plan, create the requested code/tests and record recommended validation commands or known failure evidence in the handoff for Testing Agent.",
      "Completion requires successful edit tool calls that actually create or modify the workspace files.",
    );
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

/** Builds the role-specific system prompt section for an active sub-agent. */
export function formatSubagentSystemPromptSection(roleId: SubagentRoleId): string {
  const role = getSubagentRoleDefinition(roleId);
  const qualityGuidance = formatSubagentQualityGuidance(roleId);
  const roleRules = [
    "- Work inside the assigned role and scope.",
    role.canEditFiles
      ? "- Before editing planned files, use claim_file_scope with the file list so later subagents can detect same-file conflicts."
      : "- Produce planning, analysis, review, clarification, or handoff output within this role.",
    role.canEditFiles
      ? "- Make focused code/config/test edits only when they are needed for this scope."
      : "",
    role.canAskUser
      ? "- If a blocking requirement cannot be inferred, ask the user a concise question with recommended options and stop."
      : "- Resolve non-blocking preferences with conservative decisions from project evidence.",
    "- Use query_shared_memory for prior decisions/handoffs and query_workflow_graph for project flow context when those would reduce rereading.",
    role.id !== "profiler"
      ? "- If a ProjectProfile handoff exists, use it as shared project context after verifying any file evidence that affects your decision."
      : "",
    "- If memory is stale, missing, or conflicts with the workspace, trust current workspace evidence after verifying it.",
    "- Keep edits scoped to files required by this role.",
  ].filter(Boolean).join("\n");

  return [
    "## Active Subagent Role",
    `Role: ${role.title} (${role.id})`,
    `Mission: ${role.mission}`,
    "",
    "### Role Tool Contract",
    "- The provider tool schema and Available Tools section are the complete tool contract for this role.",
    "- Use only the tools currently exposed for this role.",
    "",
    "### Shared Memory Profile",
    formatSubagentMemoryProfile(roleId),
    qualityGuidance
      ? ["", "### Role Quality Guidance", qualityGuidance].join("\n")
      : "",
    "",
    "### Handoff Output Contract",
    "- End with a concise handoff for the next role or final response.",
    "- Include completed work, files touched, unresolved blockers, and what the next role should verify.",
    "- Use write_agent_handoff when it is available and the handoff should be persisted for later roles or future turns.",
    "- If user input is needed, ask the question clearly and wait before implementation continues.",
    "",
    "### Role Rules",
    roleRules,
  ].filter(Boolean).join("\n");
}

/** Builds a structured handoff record after one sub-agent role finishes. */
export function buildSubagentHandoffRecord(opts: {
  planId: string;
  index: number;
  total: number;
  subtask: SelectiveMultiAgentSubtask;
  status: SubagentHandoffStatus;
  filesWritten: readonly string[];
  startedAt: number;
  completedAt: number;
  nextRole?: SubagentRoleId;
  model?: string;
}): SubagentHandoffRecord {
  const role = getSubagentRoleDefinition(opts.subtask.role);
  const filesText = opts.filesWritten.length > 0
    ? opts.filesWritten.join(", ")
    : "No files written.";
  const summary = [
    `${role.title} finished "${opts.subtask.title}" with status ${opts.status}.`,
    `Objective: ${opts.subtask.objective}`,
    `Files: ${filesText}`,
    opts.nextRole ? `Next role: ${opts.nextRole}` : "Next role: none",
  ].join("\n");

  return Object.freeze({
    planId: opts.planId,
    handoffId: `${opts.planId}-${opts.index}-${opts.subtask.id}-${opts.subtask.role}`,
    index: opts.index,
    total: opts.total,
    subtaskId: opts.subtask.id,
    role: opts.subtask.role,
    roleTitle: role.title,
    model: opts.model ?? role.model.model,
    title: opts.subtask.title,
    objective: opts.subtask.objective,
    status: opts.status,
    acceptanceCriteria: Object.freeze([...opts.subtask.acceptanceCriteria]),
    ...(opts.subtask.scopeNotes?.length ? { scopeNotes: Object.freeze([...opts.subtask.scopeNotes]) } : {}),
    filesWritten: Object.freeze([...opts.filesWritten]),
    ...(opts.nextRole ? { nextRole: opts.nextRole } : {}),
    summary,
    startedAt: opts.startedAt,
    completedAt: opts.completedAt,
  });
}

/** Formats a handoff record as retrieval-friendly task memory text. */
export function formatSubagentHandoffForMemory(handoff: SubagentHandoffRecord): string {
  return [
    "[SUBAGENT HANDOFF]",
    `Plan: ${handoff.planId}`,
    `Step: ${handoff.index}/${handoff.total}`,
    `Role: ${handoff.roleTitle} (${handoff.role})`,
    `Model: ${handoff.model}`,
    `Scope: ${handoff.subtaskId}`,
    `Status: ${handoff.status}`,
    `Title: ${handoff.title}`,
    `Objective: ${handoff.objective}`,
    handoff.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${handoff.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
      : "",
    handoff.scopeNotes?.length
      ? `Scope notes:\n${handoff.scopeNotes.map((line) => `- ${line}`).join("\n")}`
      : "",
    handoff.filesWritten.length > 0
      ? `Files written:\n${handoff.filesWritten.map((filePath) => `- ${filePath}`).join("\n")}`
      : "Files written: none",
    handoff.nextRole ? `Next role: ${handoff.nextRole}` : "Next role: none",
    "",
    handoff.summary,
  ].filter(Boolean).join("\n");
}

/** Formats a concise handoff message for user-visible logs or transcripts. */
export function formatSubagentHandoffForTranscript(handoff: SubagentHandoffRecord): string {
  return [
    "[SUBAGENT HANDOFF]",
    `Phase: ${handoff.index}/${handoff.total}`,
    `Role: ${handoff.roleTitle} (${handoff.role})`,
    `Model: ${handoff.model}`,
    `Status: ${handoff.status}`,
    `Scope: ${handoff.title}`,
    handoff.filesWritten.length > 0
      ? `Files: ${handoff.filesWritten.join(", ")}`
      : "Files: none",
    handoff.nextRole ? `Next: ${handoff.nextRole}` : "Next: final quality gate",
  ].join("\n");
}
