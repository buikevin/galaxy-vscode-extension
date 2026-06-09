/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-10
 * @modify date 2026-05-10
 * @desc Shared task-understanding classifier used by clarification and sub-agent routing.
 */

import { Ollama } from "ollama";
import type { GalaxyConfig } from "./config";
import type { ClarificationDecisionKind, SubagentRoleId } from "./runtime";

export type TaskIntent = "question" | "review" | "implement" | "validate" | "plan" | "clarify";
export type TaskTargetSurface = "existing_code" | "new_product" | "docs" | "config" | "unknown";
export type TaskComplexity = "simple" | "moderate" | "complex";
export type TaskArchitectureImpact = "none" | "local" | "module_boundary" | "system";

export type TaskScope = Readonly<{
  frontend: boolean;
  backend: boolean;
  data: boolean;
  auth: boolean;
  payment: boolean;
  deployment: boolean;
  tests: boolean;
  review: boolean;
}>;

export type TaskUnderstandingEvidence = Readonly<{
  source: "user" | "workspace" | "memory" | "fallback";
  text: string;
}>;

export type TaskUnderstanding = Readonly<{
  intent: TaskIntent;
  targetSurface: TaskTargetSurface;
  complexity: TaskComplexity;
  scope: TaskScope;
  missingDecisions: readonly ClarificationDecisionKind[];
  explicitConstraints: readonly string[];
  negatedConstraints: readonly string[];
  selectedRoles: readonly SubagentRoleId[];
  architectureImpact: TaskArchitectureImpact;
  requiresArchitectureApproval: boolean;
  architectureApprovalReason?: string;
  projectKnowledgeNeeded: boolean;
  validationTopologyNeeded: boolean;
  projectKnowledgeReason?: string;
  confidence: number;
  reason: string;
  evidence: readonly TaskUnderstandingEvidence[];
  source: "model" | "fallback";
}>;

const ROUTER_MODEL = "gemini-3-flash-preview:cloud";
const ROUTER_TIMEOUT_MS = 20_000;
const DECISION_ORDER: readonly ClarificationDecisionKind[] = Object.freeze([
  "framework",
  "scope",
  "database",
  "auth",
  "payment",
  "deployment",
]);

function uniqueRoles(roles: readonly unknown[]): readonly SubagentRoleId[] {
  const allowed = new Set<SubagentRoleId>(["ba", "profiler", "planning", "sa", "coding", "testing", "review"]);
  const order: readonly SubagentRoleId[] = Object.freeze(["ba", "profiler", "planning", "sa", "coding", "testing", "review"]);
  const selected = new Set<SubagentRoleId>();
  for (const role of roles) {
    if (typeof role === "string" && allowed.has(role as SubagentRoleId)) {
      selected.add(role as SubagentRoleId);
    }
  }
  return Object.freeze(order.filter((role) => selected.has(role)));
}

function uniqueDecisions(values: readonly unknown[]): readonly ClarificationDecisionKind[] {
  const selected = new Set<ClarificationDecisionKind>();
  for (const value of values) {
    if (typeof value === "string" && (DECISION_ORDER as readonly string[]).includes(value)) {
      selected.add(value as ClarificationDecisionKind);
    }
  }
  return Object.freeze(DECISION_ORDER.filter((decision) => selected.has(decision)));
}

function stringList(value: unknown): readonly string[] {
  return Object.freeze(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12)
    : []);
}

function normalizeScope(raw: unknown): TaskScope {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return Object.freeze({
    frontend: record.frontend === true,
    backend: record.backend === true,
    data: record.data === true,
    auth: record.auth === true,
    payment: record.payment === true,
    deployment: record.deployment === true,
    tests: record.tests === true,
    review: record.review === true,
  });
}

function completeMissingDecisions(opts: {
  intent: TaskIntent;
  targetSurface: TaskTargetSurface;
  scope: TaskScope;
  explicitConstraints: readonly string[];
  missingDecisions: readonly ClarificationDecisionKind[];
}): readonly ClarificationDecisionKind[] {
  const decisions = new Set<ClarificationDecisionKind>(opts.missingDecisions);
  const highImpactScope =
    opts.scope.frontend ||
    opts.scope.backend ||
    opts.scope.data ||
    opts.scope.auth ||
    opts.scope.payment ||
    opts.scope.deployment;
  if (
    opts.targetSurface === "new_product" &&
    opts.intent !== "question" &&
    opts.intent !== "review" &&
    opts.explicitConstraints.length === 0 &&
    highImpactScope
  ) {
    decisions.add("framework");
  }
  return Object.freeze([...decisions]);
}

function normalizeUnderstanding(raw: Record<string, unknown>): TaskUnderstanding | null {
  const intent = typeof raw.intent === "string" ? raw.intent : "";
  const targetSurface = typeof raw.targetSurface === "string" ? raw.targetSurface : "";
  const complexity = typeof raw.complexity === "string" ? raw.complexity : "";
  const rawArchitectureImpact = typeof raw.architectureImpact === "string" ? raw.architectureImpact : "";
  const architectureImpact = ["none", "local", "module_boundary", "system"].includes(rawArchitectureImpact)
    ? rawArchitectureImpact
    : "none";
  if (!["question", "review", "implement", "validate", "plan", "clarify"].includes(intent)) return null;
  if (!["existing_code", "new_product", "docs", "config", "unknown"].includes(targetSurface)) return null;
  if (!["simple", "moderate", "complex"].includes(complexity)) return null;
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => Object.freeze({
          source: ["user", "workspace", "memory", "fallback"].includes(String(item.source)) ? item.source as TaskUnderstandingEvidence["source"] : "user",
          text: typeof item.text === "string" ? item.text.slice(0, 500) : "",
        }))
        .filter((item) => item.text)
        .slice(0, 8)
    : [];
  const normalizedIntent = intent as TaskIntent;
  const normalizedTargetSurface = targetSurface as TaskTargetSurface;
  const scope = normalizeScope(raw.scope);
  const explicitConstraints = stringList(raw.explicitConstraints);
  const baseMissingDecisions = normalizedTargetSurface === "new_product"
    ? uniqueDecisions(Array.isArray(raw.missingDecisions) ? raw.missingDecisions : [])
    : Object.freeze([]);
  const missingDecisions = completeMissingDecisions({
    intent: normalizedIntent,
    targetSurface: normalizedTargetSurface,
    scope,
    explicitConstraints,
    missingDecisions: baseMissingDecisions,
  });
  return Object.freeze({
    intent: normalizedIntent,
    targetSurface: normalizedTargetSurface,
    complexity: complexity as TaskComplexity,
    scope,
    missingDecisions,
    explicitConstraints,
    negatedConstraints: stringList(raw.negatedConstraints),
    selectedRoles: uniqueRoles(Array.isArray(raw.selectedRoles) ? raw.selectedRoles : []),
    architectureImpact: architectureImpact as TaskArchitectureImpact,
    requiresArchitectureApproval: raw.requiresArchitectureApproval === true,
    ...(typeof raw.architectureApprovalReason === "string" && raw.architectureApprovalReason.trim()
      ? { architectureApprovalReason: raw.architectureApprovalReason.trim().slice(0, 500) }
      : {}),
    projectKnowledgeNeeded: raw.projectKnowledgeNeeded === true,
    validationTopologyNeeded: raw.validationTopologyNeeded === true,
    ...(typeof raw.projectKnowledgeReason === "string" && raw.projectKnowledgeReason.trim()
      ? { projectKnowledgeReason: raw.projectKnowledgeReason.trim().slice(0, 500) }
      : {}),
    confidence,
    reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "Task understanding model decision.",
    evidence: Object.freeze(evidence),
    source: "model",
  });
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = init?.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      if (!controller.signal.aborted) clearTimeout(timeout);
    }
  }) as typeof fetch;
}

function buildUnderstandingPrompt(userContent: string): string {
  return [
    "You classify a user request for an AI coding assistant. Return only one JSON object.",
    "Do not make routing decisions by keyword matching. Use the whole request, explicit negations, and whether the user points at existing code.",
    "",
    "Schema:",
    '{"intent":"question|review|implement|validate|plan|clarify","targetSurface":"existing_code|new_product|docs|config|unknown","complexity":"simple|moderate|complex","architectureImpact":"none|local|module_boundary|system","requiresArchitectureApproval":false,"architectureApprovalReason":"short reason when true","projectKnowledgeNeeded":false,"validationTopologyNeeded":false,"projectKnowledgeReason":"short reason when projectKnowledgeNeeded or validationTopologyNeeded is true","scope":{"frontend":false,"backend":false,"data":false,"auth":false,"payment":false,"deployment":false,"tests":false,"review":false},"missingDecisions":["framework"],"explicitConstraints":[],"negatedConstraints":[],"selectedRoles":["profiler","coding"],"confidence":0.0,"reason":"short reason","evidence":[{"source":"user","text":"quoted short evidence"}]}',
    "",
    "Guidance:",
    "- Existing code/file/module requests should usually be targetSurface existing_code, not new_product.",
    "- New product/app/site requests may need clarification when framework/scope/data/auth/payment/deployment choices are missing.",
    "- Specific implementation requests with enough file/scope/test details should go directly to coding/testing, not planning or sa.",
    "- Respect explicit negations. If the user says not to change architecture/design/structure, represent that meaning in negatedConstraints, set architectureImpact to none or local, and do not require architecture approval.",
    "- Use architectureImpact none for pure questions/docs/config not affecting code architecture, local for changes within existing modules/contracts, module_boundary for new or changed module/API boundaries, and system for broad framework/data/auth/deployment architecture changes.",
    "- Set requiresArchitectureApproval=true only when the user explicitly asks for approval before coding or architectureImpact is system; otherwise prefer false.",
    "- If the user asks to run/check/audit existing tests, validation, type checks, or QA evidence, set intent validate, scope.tests=true, and select testing first. Do not select coding for conditional repair wording such as fix errors if any; Testing Agent will decide whether a later Coding repair is needed from evidence.",
    "- If the user asks to implement source changes and also asks for tests, set intent implement, include coding, and include testing after coding.",
    "- If the user explicitly asks for planning, solution architecture, SA, architecture approval, or design approval before coding, include planning and sa before coding.",
    "- Complex multi-surface work should include planning and sa before coding.",
    "- Set projectKnowledgeNeeded=true when later roles need fresh language/framework/architecture/workspace-unit/environment facts that are not already explicit in the user request.",
    "- Set validationTopologyNeeded=true when later roles need fresh package/test/build command topology or local validation-readiness facts before validation can be planned safely.",
    "- Include profiler only when projectKnowledgeNeeded or validationTopologyNeeded is true, or when the user explicitly asks to profile/inspect the project. Do not include profiler merely because tests are requested.",
    "- Include review only for explicit review/risk/completion review requests or complex work that needs code-leader review.",
    "- Review-only requests should select review only and never coding.",
    "- Pure questions should select no roles.",
    "",
    "[USER REQUEST]",
    userContent,
  ].join("\n");
}

async function runModelUnderstanding(config: GalaxyConfig, userContent: string): Promise<TaskUnderstanding | null> {
  const manualAgent = config.agent.find((agent) => agent.type === "manual");
  if (!manualAgent?.apiKey) return null;
  const client = new Ollama({
    host: (manualAgent.baseUrl ?? "https://ollama.com").replace(/\/$/, ""),
    headers: { Authorization: `Bearer ${manualAgent.apiKey}` },
    fetch: createTimeoutFetch(ROUTER_TIMEOUT_MS),
  });
  try {
    const response = await client.chat({
      model: ROUTER_MODEL,
      messages: [{ role: "user", content: buildUnderstandingPrompt(userContent) }],
      stream: false,
      format: "json",
      think: false,
    } as never) as { message?: { content?: string } };
    const parsed = extractJsonObject(response.message?.content ?? "");
    return parsed ? normalizeUnderstanding(parsed) : null;
  } catch {
    return null;
  }
}

export function buildFallbackTaskUnderstanding(userContent: string): TaskUnderstanding {
  const scope: TaskScope = Object.freeze({
    frontend: false,
    backend: false,
    data: false,
    auth: false,
    payment: false,
    deployment: false,
    tests: false,
    review: false,
  });
  return Object.freeze({
    intent: "question",
    targetSurface: "unknown",
    complexity: "simple",
    scope,
    missingDecisions: Object.freeze([]),
    explicitConstraints: Object.freeze([]),
    negatedConstraints: Object.freeze([]),
    selectedRoles: Object.freeze([]),
    architectureImpact: "none",
    requiresArchitectureApproval: false,
    projectKnowledgeNeeded: false,
    validationTopologyNeeded: false,
    confidence: 0,
    reason: "Task understanding model was unavailable or below confidence; deterministic keyword fallback is disabled for user intent.",
    evidence: Object.freeze([{ source: "fallback" as const, text: userContent.slice(0, 500) }]),
    source: "fallback",
  });
}

export async function buildTaskUnderstanding(config: GalaxyConfig, userContent: string): Promise<TaskUnderstanding> {
  const model = await runModelUnderstanding(config, userContent);
  if (model && model.confidence >= 0.7) {
    return model;
  }
  return buildFallbackTaskUnderstanding(userContent);
}
