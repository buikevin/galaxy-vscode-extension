/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-05-09
 * @desc Build role-aware sub-agent execution plans for implementation requests.
 */

import type { GalaxyConfig } from "../shared/config";
import type { AgentType, ChatMessage } from "../shared/protocol";
import { ENABLE_SELECTIVE_MULTI_AGENT } from "../shared/constants";
import {
  buildSubagentRoleConfig,
  getSubagentRoleDefinition,
} from "../shared/subagents";
import type {
  SelectiveMultiAgentPlan,
  SelectiveMultiAgentSubtask,
  SubagentRoleId,
  SubtaskScope,
} from "../shared/runtime";
import {
  buildTaskUnderstanding,
  type TaskComplexity,
  type TaskUnderstanding,
} from "../shared/task-understanding";

type TaskFacets = Readonly<{
  backend: boolean;
  frontend: boolean;
  integration: boolean;
  testing: boolean;
  review: boolean;
  newProduct: boolean;
}>;

function codingScope(facets: TaskFacets): SubtaskScope {
  if (facets.backend && !facets.frontend) {
    return "backend";
  }
  if (facets.frontend && !facets.backend) {
    return "frontend";
  }
  if (facets.integration) {
    return "integration";
  }
  return "coding";
}

function facetsFromUnderstanding(understanding: TaskUnderstanding): TaskFacets {
  const backend = understanding.scope.backend || understanding.scope.data || understanding.scope.auth || understanding.scope.payment;
  const architecturalRisk =
    understanding.requiresArchitectureApproval ||
    understanding.architectureImpact === "system" ||
    understanding.architectureImpact === "module_boundary" ||
    understanding.complexity === "complex";
  return Object.freeze({
    backend,
    frontend: understanding.scope.frontend,
    integration: (backend && understanding.scope.frontend) || understanding.complexity === "complex",
    testing: understanding.scope.tests,
    review: understanding.scope.review || understanding.intent === "review" || architecturalRisk,
    newProduct: understanding.targetSurface === "new_product",
  });
}

function shouldProfileProject(understanding: TaskUnderstanding): boolean {
  if (!["implement", "validate", "plan"].includes(understanding.intent)) {
    return false;
  }
  return understanding.projectKnowledgeNeeded || understanding.validationTopologyNeeded;
}

function rolesFromUnderstanding(understanding: TaskUnderstanding, facets: TaskFacets): readonly SubagentRoleId[] {
  const roles = understanding.intent === "review" && understanding.selectedRoles.length === 0
    ? ["review"] as readonly SubagentRoleId[]
    : understanding.selectedRoles;
  const selected = new Set<SubagentRoleId>(roles.filter((role) => role !== "main" && role !== "ba"));
  if (understanding.intent === "validate") {
    selected.delete("planning");
    selected.delete("sa");
    selected.delete("coding");
    if (shouldProfileProject(understanding)) {
      selected.add("profiler");
    }
    selected.add("testing");
    if (facets.review) {
      selected.add("review");
    }
    return Object.freeze((["profiler", "testing", "review"] as readonly SubagentRoleId[]).filter((role) => selected.has(role)));
  }
  const architecturePlanningNeeded =
    understanding.requiresArchitectureApproval ||
    understanding.architectureImpact === "system" ||
    understanding.architectureImpact === "module_boundary" ||
    understanding.complexity === "complex";
  if (
    selected.has("coding") &&
    architecturePlanningNeeded
  ) {
    selected.add("planning");
    selected.add("sa");
  }
  if (selected.has("coding") && shouldProfileProject(understanding)) {
    selected.add("profiler");
  }
  if (
    selected.has("coding") &&
    understanding.targetSurface === "existing_code" &&
    understanding.complexity === "simple" &&
    !understanding.requiresArchitectureApproval &&
    (understanding.architectureImpact === "none" || understanding.architectureImpact === "local")
  ) {
    selected.delete("planning");
    selected.delete("sa");
  }
  if (facets.testing) {
    selected.add("testing");
  }
  if (facets.review) {
    selected.add("review");
  }
  return Object.freeze([...selected]);
}

function makeSubtask(
  id: SubtaskScope,
  role: SubagentRoleId,
  title: string,
  objective: string,
  acceptanceCriteria: readonly string[],
  scopeNotes: readonly string[] = [],
): SelectiveMultiAgentSubtask {
  return Object.freeze({
    id,
    role,
    title,
    objective,
    acceptanceCriteria: Object.freeze([...acceptanceCriteria]),
    ...(scopeNotes.length ? { scopeNotes: Object.freeze([...scopeNotes]) } : {}),
  });
}

function reviewSubtask(): SelectiveMultiAgentSubtask {
  return makeSubtask(
    "review",
    "review",
    "Code leader review",
    "Review the requested files or changed surface for correctness, risk, and completion quality without editing files.",
    [
      "Report actionable issues before summaries.",
      "Do not edit files during review.",
      "Base findings on current workspace evidence.",
    ],
  );
}

function profilerSubtask(kind: "initial" | "post_coding"): SelectiveMultiAgentSubtask {
  if (kind === "post_coding") {
    return makeSubtask(
      "profiler",
      "profiler",
      "Post-coding environment profiling",
      "Refresh the ProjectProfile after Coding so Testing knows which workspace units are ready, partial, or blocked by missing local environment/dependencies.",
      [
        "Inspect changed or newly-created manifests/configs/scripts and relevant dependency directories before Testing starts.",
        "Use read-only evidence plus inspect_workspace_environment for OS, path, environment-variable, and command availability/version checks.",
        "Do not install dependencies, run validation commands, or edit files.",
        "Persist a ProjectProfile/environment-readiness handoff with ready, partial, or not_ready validation scopes and exact blockers.",
      ],
    );
  }
  return makeSubtask(
    "profiler",
    "profiler",
    "Project profiling",
    "Build an evidence-based ProjectProfile for the current or planned project so later roles share the same language, framework, architecture, validation, and environment context.",
    [
      "Use open strings plus file/script/config evidence; do not force the project into a fixed language or framework enum.",
      "Identify workspace units, architecture style, declared validation/build commands, environment requirements, confidence, and uncertainties.",
      "Use inspect_workspace_environment only for read-only OS, path, environment-variable, and command availability/version evidence.",
      "Do not edit files, install dependencies, or run validation during profiling.",
      "Persist the ProjectProfile with write_agent_handoff for Planning, SA, Coding, Testing, and Review.",
    ],
  );
}

function buildSubtasksFromRoles(
  facets: TaskFacets,
  roles: readonly SubagentRoleId[],
  complexity: TaskComplexity,
): readonly SelectiveMultiAgentSubtask[] {
  const selected = new Set(roles.filter((role) => role !== "main" && role !== "ba"));
  const subtasks: SelectiveMultiAgentSubtask[] = [];

  if (
    selected.has("profiler") ||
    selected.has("planning") ||
    selected.has("sa") ||
    selected.has("coding") ||
    selected.has("testing")
  ) {
    subtasks.push(profilerSubtask("initial"));
  }

  if (selected.has("planning")) {
    subtasks.push(makeSubtask(
      "planning",
      "planning",
      "Implementation planning",
      "Break the request into a short execution sequence, identify dependencies, and define the handoff for architecture and coding.",
      [
        "Use current project evidence instead of generic assumptions.",
        "Keep the plan concise and execution-oriented.",
        "Do not edit files during planning.",
      ],
    ));
  }

  if (selected.has("sa")) {
    subtasks.push(makeSubtask(
      "sa",
      "sa",
      "Solution architecture",
      "Decide the technical approach, file/module boundaries, contracts, and integration points for the requested change.",
      [
        "Prefer existing project conventions, framework choices, and local helper APIs.",
        "Call out risky assumptions that coding must verify.",
        "Do not edit files during architecture analysis.",
      ],
    ));
  }

  if (selected.has("coding")) {
    const scope = codingScope(facets);
    const complex = complexity === "complex";
    subtasks.push(makeSubtask(
      scope,
      "coding",
      scope === "backend"
        ? "Backend coding"
        : scope === "frontend"
          ? "Frontend coding"
          : scope === "integration"
            ? "Integration coding"
            : "Coding implementation",
      "Implement the requested code changes inside the assigned scope, preserving existing project behavior outside the touched surface.",
      [
        "Read only the files needed for the current implementation decision.",
        "Use targeted edits and keep unrelated files unchanged.",
        facets.newProduct
          ? "Create the requested runnable project skeleton and required source/test/config files; do not hand off with zero files when the workspace is empty."
          : "Modify the existing requested files or modules when implementation is needed.",
        "If the user names required source, test, config, or documentation files, create or update those files before handoff instead of spending the whole turn on one partial file.",
        "Leave clear interfaces for validation, testing, and review.",
      ],
      [
        facets.newProduct
          ? "This is a new-product scaffold request: implement the concrete project files requested by the user after architecture approval."
          : "",
        complex
          ? "Use the planning and architecture handoff already present in the transcript as the execution boundary."
          : "This is a simple implementation path: avoid creating planning documents or broad redesigns.",
      ].filter(Boolean),
    ));
  }

  if (selected.has("coding") && selected.has("testing")) {
    subtasks.push(profilerSubtask("post_coding"));
  }

  if (selected.has("testing")) {
    subtasks.push(makeSubtask(
      "testing",
      "testing",
      "Testing and validation",
      "Run or add focused validation for the changed behavior and fix defects that are directly related to this request.",
      [
        "Prefer existing project validation commands and nearby test patterns.",
        "For multi-package workspaces, validate each package with its own runner and keep root tests scoped to root-owned test files.",
        "If a user-requested test/config/doc file is missing after Coding, create or repair it before validation unless doing so would change the approved scope.",
        "Avoid broad test-suite rewrites.",
        "Report any validation that cannot be run and why.",
      ],
    ));
  }

  if (selected.has("review")) {
    subtasks.push(reviewSubtask());
  }

  return Object.freeze(subtasks);
}

function buildUnderstandingSubtasks(understanding: TaskUnderstanding): readonly SelectiveMultiAgentSubtask[] {
  if (understanding.intent === "question") {
    return Object.freeze([]);
  }
  if (understanding.missingDecisions.length > 0 || understanding.intent === "clarify") {
    return Object.freeze([
      makeSubtask(
        "ba",
        "ba",
        "Clarify product requirements",
        "Identify blocking requirement gaps before implementation starts and ask the user for the missing choices.",
        [
          "Ask only for decisions that cannot be inferred safely from workspace evidence or the user request.",
          "Offer 2-3 concrete recommended options and leave room for another answer.",
          "Do not choose framework, database, auth, payment, or deployment defaults for a new product build without user confirmation.",
        ],
      ),
    ]);
  }
  const facets = facetsFromUnderstanding(understanding);
  const roles = rolesFromUnderstanding(understanding, facets);
  return buildSubtasksFromRoles(facets, roles, understanding.complexity);
}

function buildPlanFromSubtasks(
  reason: string,
  subtasks: readonly SelectiveMultiAgentSubtask[],
  understanding?: TaskUnderstanding,
): SelectiveMultiAgentPlan | null {
  if (subtasks.length === 0) {
    return null;
  }
  const summary =
    "Main agent will coordinate a role-aware sub-agent plan:\n" +
    subtasks
      .map((subtask, index) => {
        const role = getSubagentRoleDefinition(subtask.role);
        return `${index + 1}. ${subtask.title} (${role.title}, ${role.model.model}): ${subtask.objective}`;
      })
      .join("\n");

  return Object.freeze({
    reason,
    summary,
    subtasks,
    ...(understanding
      ? {
          architectureImpact: understanding.architectureImpact,
          requiresArchitectureApproval: understanding.requiresArchitectureApproval,
          ...(understanding.architectureApprovalReason
            ? { architectureApprovalReason: understanding.architectureApprovalReason }
            : {}),
        }
      : {}),
  });
}

export function maybeBuildSelectiveMultiAgentPlan(
  agentType: AgentType,
  userContent: string,
  subagentEnabled = true,
): SelectiveMultiAgentPlan | null {
  if (!ENABLE_SELECTIVE_MULTI_AGENT || !subagentEnabled) {
    return null;
  }

  if (agentType !== "manual") {
    return null;
  }

  const trimmed = userContent.trim();
  if (!trimmed) {
    return null;
  }

  return null;
}

export async function buildSelectiveMultiAgentPlanWithRouter(
  config: GalaxyConfig,
  agentType: AgentType,
  userContent: string,
): Promise<SelectiveMultiAgentPlan | null> {
  if (!ENABLE_SELECTIVE_MULTI_AGENT || !config.subagent || agentType !== "manual") {
    return null;
  }
  const trimmed = userContent.trim();
  if (!trimmed) {
    return null;
  }

  const understanding = await buildTaskUnderstanding(config, trimmed);
  if (understanding.source !== "model") {
    return null;
  }
  if (understanding.missingDecisions.length > 0 || understanding.intent === "clarify" || understanding.intent === "question") {
    return null;
  }

  const facets = facetsFromUnderstanding(understanding);
  const roles = rolesFromUnderstanding(understanding, facets);
  const subtasks = buildSubtasksFromRoles(facets, roles, understanding.complexity);
  return buildPlanFromSubtasks(
    `Structured task understanding selected role(s): ${subtasks.map((subtask) => subtask.role).join(", ")}. ${understanding.reason}`,
    subtasks,
    understanding,
  );
}

export function buildSelectiveMultiAgentPlanMessage(plan: SelectiveMultiAgentPlan): string {
  return [
    "[SUBAGENT PLAN]",
    plan.reason,
    "",
    plan.summary,
    "",
    "Sub-agents run sequentially by default. Set subagent:false to use the existing single-agent flow.",
  ].join("\n");
}

export function buildSelectiveMultiAgentSubtaskMessage(opts: {
  config: GalaxyConfig;
  originalUserMessage: ChatMessage;
  subtask: SelectiveMultiAgentSubtask;
}): ChatMessage {
  const role = getSubagentRoleDefinition(opts.subtask.role);
  const acceptanceLines = opts.subtask.acceptanceCriteria.map((line) => `- ${line}`).join("\n");
  const scopeNoteLines = (opts.subtask.scopeNotes ?? []).map((line) => `- ${line}`).join("\n");
  const content = [
    "[SUBAGENT TASK]",
    `Role: ${role.title} (${opts.subtask.role})`,
    `Subtask: ${opts.subtask.title}`,
    "",
    "[ORIGINAL USER REQUEST]",
    opts.originalUserMessage.content,
    "",
    "[ASSIGNED SCOPE]",
    opts.subtask.objective,
    "",
    "[ACCEPTANCE CRITERIA]",
    acceptanceLines || "- Complete the assigned scope.",
    ...(scopeNoteLines
      ? [
          "",
          "[SCOPE NOTES]",
          scopeNoteLines,
        ]
      : []),
  ].join("\n");

  return Object.freeze({
    id: `${opts.subtask.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content,
    memoryContent: content,
    ...(opts.originalUserMessage.images?.length ? { images: [...opts.originalUserMessage.images] } : {}),
    ...(opts.originalUserMessage.attachments?.length ? { attachments: [...opts.originalUserMessage.attachments] } : {}),
    ...(opts.originalUserMessage.figmaAttachments?.length ? { figmaAttachments: [...opts.originalUserMessage.figmaAttachments] } : {}),
    timestamp: Date.now(),
  });
}

export function buildSubAgentConfig(config: GalaxyConfig, roleId: SubagentRoleId = "coding"): GalaxyConfig {
  return buildSubagentRoleConfig(config, roleId);
}

export function buildCoderSubAgentConfig(config: GalaxyConfig): GalaxyConfig {
  return buildSubAgentConfig(config, "coding");
}
