/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-12
 * @modify date 2026-05-12
 * @desc Human approval checkpoint before architecture-impacting subagent plans start coding.
 */

import type {
  ArchitectureApprovalDecision,
  ArchitectureApprovalRequest,
  SelectiveMultiAgentPlan,
  SubagentHandoffRecord,
} from "./runtime";

export function needsArchitectureApproval(plan: SelectiveMultiAgentPlan): boolean {
  if (typeof plan.requiresArchitectureApproval === "boolean") {
    return plan.requiresArchitectureApproval;
  }
  const roles = new Set(plan.subtasks.map((subtask) => subtask.role));
  return roles.has("coding") && (roles.has("planning") || roles.has("sa"));
}

export function buildArchitectureApprovalRequest(opts: {
  plan: SelectiveMultiAgentPlan;
  completedHandoffs: readonly SubagentHandoffRecord[];
}): ArchitectureApprovalRequest {
  const handoffLines = opts.completedHandoffs.map((handoff) =>
    `${handoff.index}. ${handoff.roleTitle}: ${handoff.summary}`,
  );
  return Object.freeze({
    id: `architecture-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Approve architecture before coding",
    question: "Planning/architecture work is complete. Should Galaxy continue into Coding Agent with this plan?",
    reason: opts.plan.architectureApprovalReason ||
      "This request affects architecture or multiple implementation phases, so file edits should wait for explicit user approval.",
    planSummary: opts.plan.summary,
    completedHandoffs: Object.freeze(handoffLines),
    options: Object.freeze([
      Object.freeze({
        id: "approve",
        label: "Approve and continue",
        description: "Continue into Coding/Testing/Review using the current plan and handoff.",
        decision: "approve" as const,
      }),
      Object.freeze({
        id: "revise",
        label: "Revise plan",
        description: "Stop before coding so the user can provide changes to the design or scope.",
        decision: "revise" as const,
      }),
      Object.freeze({
        id: "cancel",
        label: "Cancel",
        description: "Stop the subagent workflow without coding.",
        decision: "cancel" as const,
      }),
    ]),
  });
}

export function formatArchitectureApprovalRequest(request: ArchitectureApprovalRequest): string {
  const handoffLines = request.completedHandoffs.length > 0
    ? request.completedHandoffs.map((line) => `- ${line}`)
    : ["- No planning handoff was captured."];
  const optionLines = request.options.map((option, index) =>
    `${index + 1}. ${option.label} - ${option.description}`,
  );
  return [
    request.title,
    "",
    request.question,
    request.reason,
    "",
    "[PROPOSED SUBAGENT PLAN]",
    request.planSummary,
    "",
    "[COMPLETED DESIGN HANDOFFS]",
    ...handoffLines,
    "",
    ...optionLines,
  ].join("\n");
}

export function resolveArchitectureApprovalDecisionFromText(
  request: ArchitectureApprovalRequest,
  input: string,
): ArchitectureApprovalDecision | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const selectedIndex = Number.parseInt(trimmed, 10);
  const byNumber = Number.isFinite(selectedIndex)
    ? request.options[selectedIndex - 1]
    : undefined;
  const byText = request.options.find(
    (option) =>
      option.id.toLowerCase() === trimmed ||
      option.label.toLowerCase() === trimmed,
  );
  const selected = byNumber ?? byText;
  if (selected) {
    return selected.decision;
  }
  if (["y", "yes", "approve", "approved", "ok", "continue", "go"].includes(trimmed)) {
    return "approve";
  }
  if (["r", "revise", "change", "edit", "adjust"].includes(trimmed)) {
    return "revise";
  }
  if (["n", "no", "cancel", "stop"].includes(trimmed)) {
    return "cancel";
  }
  return null;
}
