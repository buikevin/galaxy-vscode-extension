import type { GalaxyConfig } from '../config/types';
import type { AgentType, ChatMessage } from '../shared/protocol';

const CODER_SUB_AGENT_MODEL = 'qwen3-coder-next:cloud';
const ENABLE_SELECTIVE_MULTI_AGENT = false;

type SubtaskScope = 'backend' | 'frontend' | 'integration';

export type SelectiveMultiAgentSubtask = Readonly<{
  id: SubtaskScope;
  title: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  scopeNotes?: readonly string[];
}>;

export type SelectiveMultiAgentPlan = Readonly<{
  reason: string;
  summary: string;
  subtasks: readonly SelectiveMultiAgentSubtask[];
}>;

function hasAnyKeyword(input: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => input.includes(keyword));
}

function detectTaskFacets(input: string): Readonly<{
  backend: boolean;
  frontend: boolean;
  integration: boolean;
}> {
  const normalized = input.toLowerCase();
  const backend = hasAnyKeyword(normalized, [
    'backend',
    'api',
    'server',
    'database',
    'db',
    'schema',
    'endpoint',
    'auth',
    'controller',
    'service',
    'route',
  ]);
  const frontend = hasAnyKeyword(normalized, [
    'frontend',
    'front-end',
    'ui',
    'ux',
    'react',
    'vue',
    'angular',
    'component',
    'page',
    'screen',
    'layout',
    'style',
    'css',
    'tailwind',
  ]);
  const integration = hasAnyKeyword(normalized, [
    'test',
    'tests',
    'spec',
    'integration',
    'e2e',
    'wire',
    'connect',
    'hook up',
    'full stack',
    'full-stack',
    'cả backend lẫn front-end',
    'cả backend và frontend',
  ]);

  return Object.freeze({ backend, frontend, integration });
}

export function maybeBuildSelectiveMultiAgentPlan(
  agentType: AgentType,
  userContent: string,
): SelectiveMultiAgentPlan | null {
  if (!ENABLE_SELECTIVE_MULTI_AGENT) {
    return null;
  }

  if (agentType !== 'manual') {
    return null;
  }

  const trimmed = userContent.trim();
  if (!trimmed) {
    return null;
  }

  const facets = detectTaskFacets(trimmed);
  const facetCount = Number(facets.backend) + Number(facets.frontend) + Number(facets.integration);
  const broadImplementationTask =
    /implement|xây|làm|create|build|thiết kế|refactor|overhaul|rewrite|làm lại/i.test(trimmed) &&
    trimmed.length >= 120;

  if (facetCount < 2 && !broadImplementationTask) {
    return null;
  }

  const subtasks: SelectiveMultiAgentSubtask[] = [];

  if (facets.backend || (!facets.frontend && broadImplementationTask)) {
    subtasks.push(Object.freeze({
      id: 'backend',
      title: 'Backend implementation',
      objective: 'Implement only the minimal backend scaffold, API contracts, and runtime wiring required by the request so the frontend can proceed.',
      acceptanceCriteria: Object.freeze([
        'Touch backend-facing files only when possible.',
        'Keep interfaces explicit for downstream consumers.',
        'Avoid rewriting unrelated modules.',
      ]),
      scopeNotes: Object.freeze([
        'Stop once the core backend contract exists for the requested feature slice.',
        'Prefer source files, config files, and minimal runtime scripts over project documentation.',
      ]),
    }));
  }

  if (facets.frontend || broadImplementationTask) {
    subtasks.push(Object.freeze({
      id: 'frontend',
      title: 'Frontend implementation',
      objective: 'Implement the requested UI, component wiring, and client-side integration against the current backend contract.',
      acceptanceCriteria: Object.freeze([
        'Consume existing or newly added backend interfaces correctly.',
        'Preserve local UI conventions unless the request requires change.',
        'Avoid broad unrelated styling churn.',
      ]),
      scopeNotes: Object.freeze([
        'Prioritize the currently requested user-facing flow before secondary polish.',
        'Do not pause to write project summary documents.',
      ]),
    }));
  }

  if (facets.integration || (subtasks.length >= 2 && /test|validate|wire|connect|end-to-end|integration/i.test(trimmed))) {
    subtasks.push(Object.freeze({
      id: 'integration',
      title: 'Integration and verification',
      objective: 'Wire backend and frontend changes together, then cover the highest-risk validation points.',
      acceptanceCriteria: Object.freeze([
        'Verify contracts between touched layers.',
        'Add or adjust minimal validation or test coverage when practical.',
        'Do not reopen already settled implementation areas without evidence.',
      ]),
      scopeNotes: Object.freeze([
        'Keep this phase focused on connecting existing work, not rewriting completed scopes.',
      ]),
    }));
  }

  if (subtasks.length < 2) {
    return null;
  }

  const summary =
    'Main agent will coordinate a selective multi-agent implementation plan:\n' +
    subtasks
      .map((subtask, index) => `${index + 1}. ${subtask.title}: ${subtask.objective}`)
      .join('\n');

  return Object.freeze({
    reason: `Detected a multi-surface implementation task (${subtasks.map((subtask) => subtask.id).join(', ')}).`,
    summary,
    subtasks: Object.freeze(subtasks),
  });
}

export function buildSelectiveMultiAgentPlanMessage(plan: SelectiveMultiAgentPlan): string {
  return [
    '[PHASE 4 PLAN]',
    plan.reason,
    '',
    plan.summary,
    '',
    'Main agent will keep orchestration, while coder sub-agents execute scoped implementation turns sequentially.',
  ].join('\n');
}

export function buildSelectiveMultiAgentSubtaskMessage(opts: {
  originalUserMessage: ChatMessage;
  subtask: SelectiveMultiAgentSubtask;
}): ChatMessage {
  const acceptanceLines = opts.subtask.acceptanceCriteria.map((line) => `- ${line}`).join('\n');
  const scopeNoteLines = (opts.subtask.scopeNotes ?? []).map((line) => `- ${line}`).join('\n');

  return Object.freeze({
    id: `${opts.subtask.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [
      '[SYSTEM SUBTASK EXECUTION]',
      `You are the coder sub-agent for the "${opts.subtask.title}" scope.`,
      '',
      '[ORIGINAL USER REQUEST]',
      opts.originalUserMessage.content,
      '',
      '[YOUR SCOPE FOR THIS TURN]',
      opts.subtask.objective,
      '',
      '[ACCEPTANCE CRITERIA]',
      acceptanceLines,
      ...(scopeNoteLines
        ? [
            '',
            '[SCOPE NOTES]',
            scopeNoteLines,
          ]
        : []),
      '',
      '[RULES]',
      '- Work only inside this scope unless a tiny integration adjustment is unavoidable.',
      '- Do not rewrite unrelated files.',
      '- If this scope is already complete, avoid unnecessary edits.',
      '- Leave clean interfaces for the next scoped turn.',
      '- Do not create README, CHANGELOG, SECURITY, SUMMARY, MANIFEST, VALIDATION, STARTUP, or other markdown documentation unless the user explicitly asked for documentation.',
      '- Prefer code, configuration, and runtime files over explanatory project documents.',
      '- If you need to summarize progress, do it in the assistant response, not by creating new markdown files.',
      '- When backend and frontend are both planned, finish only the smallest viable slice for this scope, then stop so the next scoped turn can proceed.',
    ].join('\n'),
    ...(opts.originalUserMessage.images?.length ? { images: [...opts.originalUserMessage.images] } : {}),
    ...(opts.originalUserMessage.attachments?.length ? { attachments: [...opts.originalUserMessage.attachments] } : {}),
    ...(opts.originalUserMessage.figmaAttachments?.length ? { figmaAttachments: [...opts.originalUserMessage.figmaAttachments] } : {}),
    timestamp: Date.now(),
  });
}

export function buildCoderSubAgentConfig(config: GalaxyConfig): GalaxyConfig {
  const nextAgent = [...config.agent];
  const manualIndex = nextAgent.findIndex((agent) => agent.type === 'manual');

  if (manualIndex >= 0) {
    const existingManualAgent = nextAgent[manualIndex]!;
    nextAgent[manualIndex] = {
      type: 'manual',
      model: CODER_SUB_AGENT_MODEL,
      baseUrl: existingManualAgent.baseUrl ?? 'https://ollama.com',
      ...(existingManualAgent.apiKey ? { apiKey: existingManualAgent.apiKey } : {}),
    };
  } else {
    nextAgent.unshift({
      type: 'manual',
      model: CODER_SUB_AGENT_MODEL,
      baseUrl: 'https://ollama.com',
      apiKey: '',
    });
  }

  return {
    ...config,
    agent: nextAgent,
  };
}
