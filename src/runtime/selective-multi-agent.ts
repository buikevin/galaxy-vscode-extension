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
  formatSubagentToolProfile,
  getSubagentRoleDefinition,
} from "../shared/subagents";
import type {
  SelectiveMultiAgentPlan,
  SelectiveMultiAgentSubtask,
  SubagentRoleId,
  SubtaskScope,
} from "../shared/runtime";

type TaskFacets = Readonly<{
  backend: boolean;
  frontend: boolean;
  integration: boolean;
  testing: boolean;
  review: boolean;
}>;

function hasAnyKeyword(input: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => input.includes(keyword));
}

function detectTaskFacets(input: string): TaskFacets {
  const normalized = input.toLowerCase();
  const backend = hasAnyKeyword(normalized, [
    "backend",
    "api",
    "server",
    "database",
    "db",
    "schema",
    "endpoint",
    "auth",
    "controller",
    "service",
    "route",
    "payment",
    "cache",
  ]);
  const frontend = hasAnyKeyword(normalized, [
    "frontend",
    "front-end",
    "ui",
    "ux",
    "react",
    "vue",
    "angular",
    "component",
    "page",
    "screen",
    "layout",
    "style",
    "css",
    "tailwind",
    "webview",
  ]);
  const integration = hasAnyKeyword(normalized, [
    "integration",
    "e2e",
    "wire",
    "connect",
    "hook up",
    "full stack",
    "full-stack",
    "cả backend lẫn front-end",
    "cả backend và frontend",
    "tích hợp",
  ]);
  const testing = hasAnyKeyword(normalized, [
    "test",
    "tests",
    "spec",
    "kiểm thử",
    "validate",
    "validation",
    "typecheck",
    "lint",
  ]);
  const review = hasAnyKeyword(normalized, [
    "review",
    "code review",
    "đánh giá",
    "kiểm tra lại",
    "leader",
  ]);

  return Object.freeze({ backend, frontend, integration, testing, review });
}

function isActionableImplementationRequest(input: string): boolean {
  return /implement|build|create|add|fix|repair|refactor|rewrite|update|modify|migrate|scaffold|xây|làm|tạo|thêm|sửa|cài|phát triển|nâng cấp|triển khai|viết|xử lý/i.test(input);
}

function needsBusinessClarification(input: string, facets: TaskFacets): boolean {
  const normalized = input.toLowerCase();
  const asksForProductBuild = /web|website|app|ứng dụng|hệ thống|trang web|e-?commerce|bán hàng|bán điện thoại|shop|saas|crm|dashboard/.test(normalized);
  const hasExplicitStack = /react|next|vue|nuxt|angular|svelte|vite|node|express|nestjs|laravel|django|fastapi|spring|flutter|react native|framework|typescript|javascript|python|java|php|postgres|mysql|mongodb|sqlite/.test(normalized);
  const pointsAtExistingCode = /repo|codebase|dự án hiện tại|project hiện tại|trong src|file|component|api|backend|frontend|extension|cli/.test(normalized);
  return asksForProductBuild && !hasExplicitStack && !pointsAtExistingCode && !facets.backend && !facets.frontend;
}

function isComplexImplementation(input: string, facets: TaskFacets): boolean {
  const facetCount = Number(facets.backend) + Number(facets.frontend) + Number(facets.integration);
  const broadImplementationTask =
    isActionableImplementationRequest(input) &&
    (input.trim().length >= 120 ||
      /architecture|orchestration|workflow|multi-agent|subagent|rag|graphrag|hybridrag|long-term memory|bộ nhớ|phức tạp|full stack|full-stack|database|auth|payment|admin|dashboard|nhiều màn|nhiều chức năng/i.test(input));
  return facetCount >= 2 || broadImplementationTask;
}

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

function buildRoleAwareSubtasks(input: string, facets: TaskFacets): readonly SelectiveMultiAgentSubtask[] {
  if (!isActionableImplementationRequest(input)) {
    return Object.freeze([]);
  }

  if (needsBusinessClarification(input, facets)) {
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
        [
          'For requests like "build a phone-selling website", ask for framework/stack, scope, data source, checkout/payment, and admin needs before coding.',
          "Stop after the clarification question; the next user answer should resume planning or coding.",
        ],
      ),
    ]);
  }

  const complex = isComplexImplementation(input, facets);
  const subtasks: SelectiveMultiAgentSubtask[] = [];

  if (complex) {
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

  const scope = codingScope(facets);
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
      "Leave clear interfaces for validation, testing, and review.",
    ],
    [
      complex
        ? "Use the planning and architecture handoff already present in the transcript as the execution boundary."
        : "This is a simple implementation path: avoid creating planning documents or broad redesigns.",
    ],
  ));

  if (complex || facets.testing) {
    subtasks.push(makeSubtask(
      "testing",
      "testing",
      "Testing and validation",
      "Run or add focused validation for the changed behavior and fix defects that are directly related to this request.",
      [
        "Prefer existing project validation commands and nearby test patterns.",
        "Avoid broad test-suite rewrites.",
        "Report any validation that cannot be run and why.",
      ],
    ));
  }

  if (complex || facets.review) {
    subtasks.push(makeSubtask(
      "review",
      "review",
      "Code leader review",
      "Review the changed surface for correctness, missing requirements, integration risk, and completion quality.",
      [
        "Review only evidence from the current request and changed files.",
        "Report actionable issues before summaries.",
        "Do not edit files during review.",
      ],
    ));
  }

  return Object.freeze(subtasks);
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

  const facets = detectTaskFacets(trimmed);
  const subtasks = buildRoleAwareSubtasks(trimmed, facets);
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
    reason: `Detected an implementation task routed through sub-agent role(s): ${subtasks.map((subtask) => subtask.role).join(", ")}.`,
    summary,
    subtasks,
  });
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
  originalUserMessage: ChatMessage;
  subtask: SelectiveMultiAgentSubtask;
}): ChatMessage {
  const role = getSubagentRoleDefinition(opts.subtask.role);
  const acceptanceLines = opts.subtask.acceptanceCriteria.map((line) => `- ${line}`).join("\n");
  const scopeNoteLines = (opts.subtask.scopeNotes ?? []).map((line) => `- ${line}`).join("\n");
  const toolProfileLines = formatSubagentToolProfile(opts.subtask.role);

  return Object.freeze({
    id: `${opts.subtask.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: [
      "[SYSTEM SUBTASK EXECUTION]",
      `You are the ${role.title}.`,
      "",
      "[ROLE MISSION]",
      role.mission,
      "",
      "[ALLOWED TOOL GROUPS]",
      toolProfileLines || "- none",
      "",
      "[ORIGINAL USER REQUEST]",
      opts.originalUserMessage.content,
      "",
      "[YOUR SCOPE FOR THIS TURN]",
      opts.subtask.objective,
      "",
      "[ACCEPTANCE CRITERIA]",
      acceptanceLines,
      ...(scopeNoteLines
        ? [
            "",
            "[SCOPE NOTES]",
            scopeNoteLines,
          ]
        : []),
      "",
      "[HANDOFF OUTPUT CONTRACT]",
      "- End your response with a concise handoff for the next role.",
      "- Include completed work, files touched, unresolved blockers, and what the next role should verify.",
      "- If you need user input, ask the question clearly and do not continue implementation.",
      "",
      "[RULES]",
      "- Work only inside this role and scope.",
      role.canEditFiles
        ? "- Make focused code/config/test edits only when they are needed for this scope."
        : "- Do not create, edit, or delete project files in this role.",
      role.canAskUser
        ? "- If a blocking requirement cannot be inferred, ask the user a concise question with recommended options and stop."
        : "- Do not ask the user for non-blocking preferences; make conservative decisions from project evidence.",
      "- Do not rewrite unrelated files.",
      "- If this scope is already complete, avoid unnecessary edits.",
      "- Leave concise handoff notes in the assistant response for the next role.",
    ].join("\n"),
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
