/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Ambiguity policy and prompt formatting for user clarification.
 */

import type {
  ClarificationAnswer,
  ClarificationDecisionKind,
  ClarificationOption,
  ClarificationRequest,
} from "./runtime";
import {
  buildFallbackTaskUnderstanding,
  type TaskUnderstanding,
} from "./task-understanding";

const CUSTOM_OPTION_ID = "custom";

const DECISION_LABELS: Readonly<Record<ClarificationDecisionKind, string>> = Object.freeze({
  framework: "framework/stack",
  scope: "frontend vs full-stack scope",
  database: "database/data source",
  auth: "authentication",
  payment: "payment/checkout",
  deployment: "deployment target",
});

function buildOptions(): readonly ClarificationOption[] {
  return Object.freeze([
    Object.freeze({
      id: "fullstack_next_mvp",
      label: "Full-stack MVP",
      description: "Next.js + TypeScript, frontend pages plus backend/API where needed, simple database-ready data layer, mock checkout unless payment is explicitly required.",
      recommended: true,
      answerText: "Use a full-stack MVP: Next.js + TypeScript, frontend pages plus backend/API where needed, simple database-ready data layer, basic auth only if the requested flow requires accounts, mock checkout/no real payment integration by default, and no deployment setup unless explicitly requested.",
    }),
    Object.freeze({
      id: "frontend_prototype",
      label: "Frontend prototype",
      description: "React/Vite + TypeScript UI with mock data, no backend, no auth, no real payment, no deployment setup.",
      answerText: "Use a frontend prototype: React/Vite + TypeScript UI, mock data, no backend/API, no authentication, no real payment integration, and no deployment setup.",
    }),
    Object.freeze({
      id: CUSTOM_OPTION_ID,
      label: "Other",
      description: "I will provide the framework, scope, data/auth/payment/deployment choices manually.",
      answerText: "",
    }),
  ]);
}

/** Builds a clarification request from normalized task-understanding slots. */
export function buildClarificationRequestFromUnderstanding(understanding: TaskUnderstanding): ClarificationRequest | null {
  const decisions = understanding.missingDecisions;
  if (decisions.length === 0) {
    return null;
  }

  const missingText = decisions.map((decision) => DECISION_LABELS[decision]).join(", ");
  return Object.freeze({
    id: `clarification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Clarify implementation direction",
    question: `Before implementation, please choose the initial direction. Missing high-impact decisions: ${missingText}.`,
    reason: understanding.reason || "These choices affect project structure, dependencies, data model, security, payment behavior, and deployment files, so the agent should not guess them.",
    decisions,
    options: buildOptions(),
    allowCustomAnswer: true,
    customAnswerPrompt: "Describe the framework, scope, database/data source, auth, payment, and deployment expectations.",
  });
}

/** Builds a clarification request using deterministic task-understanding fallback. */
export function buildClarificationRequest(userContent: string): ClarificationRequest | null {
  return buildClarificationRequestFromUnderstanding(buildFallbackTaskUnderstanding(userContent));
}

/** Creates a typed answer from a selected option or free-form response. */
export function buildClarificationAnswer(
  request: ClarificationRequest,
  optionId: string,
  customAnswer?: string,
): ClarificationAnswer | null {
  const option = request.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    return null;
  }

  const answerText = option.id === CUSTOM_OPTION_ID
    ? (customAnswer ?? "").trim()
    : option.answerText;
  if (!answerText) {
    return null;
  }

  return Object.freeze({
    requestId: request.id,
    decisions: request.decisions,
    selectedOptionId: option.id,
    selectedLabel: option.label,
    answerText,
    answeredAt: Date.now(),
  });
}

/** Formats a clarification prompt for text-only runtimes. */
export function formatClarificationRequest(request: ClarificationRequest): string {
  const optionLines = request.options.map((option, index) => {
    const suffix = option.recommended ? " (recommended)" : "";
    return `${index + 1}. ${option.label}${suffix} - ${option.description}`;
  });
  return [
    request.title,
    "",
    request.question,
    request.reason,
    "",
    ...optionLines,
  ].join("\n");
}

/** Formats the captured answer for downstream agent context. */
export function formatClarificationAnswer(answer: ClarificationAnswer): string {
  return [
    "[USER CLARIFICATION]",
    `Request: ${answer.requestId}`,
    `Decisions: ${answer.decisions.join(", ")}`,
    answer.selectedLabel ? `Selected: ${answer.selectedLabel}` : "",
    "",
    answer.answerText,
  ].filter(Boolean).join("\n");
}
