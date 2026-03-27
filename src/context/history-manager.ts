import path from 'node:path';
import type { ChatMessage } from '../shared/protocol';
import type { ToolCall, ToolResult } from '../tools/file-tools';
import { estimateTokens, HARD_PROMPT_TOKENS } from './compaction';
import type {
  ActiveTaskMemory,
  ProjectMemory,
  SessionMemory,
  ToolDigest,
  TurnDigest,
  WorkingTurn,
} from './history-types';
import {
  buildActiveTaskMemoryContent,
  buildProjectMemoryContent,
  createEmptyActiveTaskMemory,
  createEmptyProjectMemory,
  deriveCombinedKeyFiles,
  estimateActiveTaskMemoryTokens,
  estimateProjectMemoryTokens,
  normalizeActiveTaskMemory,
  normalizeProjectMemory,
} from './memory-format';
import { appendTaskMemoryEntry } from './rag-metadata-store';
import { createEmptySessionMemory, loadSessionMemory, saveSessionMemory } from './session-store';
import { clearToolEvidence, createToolEvidence, appendToolEvidence as persistToolEvidence } from './tool-evidence-store';

const ACTIVE_TASK_MEMORY_SOFT_LIMIT = 32_000;
const PROJECT_MEMORY_SOFT_LIMIT = 24_000;

export interface HistoryManager {
  getNotes(): string;
  getWorkspaceId(): string;
  getSessionMemory(): SessionMemory;
  getWorkingTurn(): WorkingTurn | null;
  startTurn(userMessage: ChatMessage, contextNote?: string): WorkingTurn;
  appendAssistantDraft(text: string): void;
  appendContextMessage(message: ChatMessage): void;
  appendToolMessage(message: ChatMessage): void;
  appendToolEvidence(opts: { call: ToolCall; result: ToolResult; toolCallId?: string }): void;
  incrementRound(): void;
  compactWorkingTurn(opts?: {
    force?: boolean;
    workingTurnBudget?: number;
    promptTokensEstimate?: number;
  }): boolean;
  finalizeTurn(opts: { assistantText: string }): TurnDigest | null;
  recordExternalEvent(summary: string, filesTouched?: readonly string[]): void;
  clearCurrentTurn(): void;
  clearAll(): void;
  save(): void;
}

function summarizeText(text: string, maxChars = 400): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function getStringParam(message: ChatMessage, key: string): string {
  const params = message.toolParams as Record<string, unknown> | undefined;
  const value = params?.[key];
  return typeof value === 'string' ? value : '';
}

function mergeUniqueItems(existing: readonly string[], incoming: readonly string[], maxItems: number): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return Object.freeze(merged.slice(-maxItems));
}

function createToolDigest(message: ChatMessage): ToolDigest {
  const toolName = message.toolName ?? 'unknown_tool';
  const pathParam = getStringParam(message, 'path');
  const patternParam = getStringParam(message, 'pattern');
  const success = message.toolSuccess ?? false;

  const filesRead =
    ['read_file', 'head', 'tail', 'read_document', 'validate_code'].includes(toolName) && pathParam
      ? Object.freeze([pathParam])
      : ['galaxy_design_project_info', 'galaxy_design_registry'].includes(toolName) && pathParam
        ? Object.freeze([pathParam])
        : toolName === 'grep' && pathParam
          ? Object.freeze([pathParam])
          : toolName === 'list_dir' && pathParam
            ? Object.freeze([pathParam])
            : Object.freeze([]);
  const filesWritten =
    ['write_file', 'edit_file', 'edit_file_range', 'multi_edit_file_ranges', 'galaxy_design_init', 'galaxy_design_add'].includes(toolName) && pathParam
      ? Object.freeze([pathParam])
      : Object.freeze([]);
  const filesReverted = Object.freeze([]);

  const summaryByTool: Record<string, string> = {
    read_file: `Read ${pathParam || 'file'}`,
    read_document: `Read document ${pathParam || ''}`.trim(),
    search_web: `Searched web for ${getStringParam(message, 'query') || 'query'}`,
    extract_web: 'Extracted web content from URLs',
    map_web: `Mapped website ${getStringParam(message, 'url') || ''}`.trim(),
    crawl_web: `Crawled website ${getStringParam(message, 'url') || ''}`.trim(),
    head: `Read file head ${pathParam || ''}`.trim(),
    tail: `Read file tail ${pathParam || ''}`.trim(),
    grep: `Searched ${pathParam || '.'} for ${patternParam || 'pattern'}`,
    list_dir: `Listed directory ${pathParam || '.'}`,
    write_file: `Wrote ${pathParam || 'file'}`,
    edit_file: `Edited ${pathParam || 'file'}`,
    edit_file_range: `Edited ${pathParam || 'file'} by line range`,
    multi_edit_file_ranges: `Edited ${pathParam || 'file'} with multiple line ranges`,
    validate_code: `${success ? 'Validated' : 'Validation failed for'} ${pathParam || 'file'}`,
    run_project_command: `Ran project command ${getStringParam(message, 'command') || getStringParam(message, 'commandId') || ''}`.trim(),
    galaxy_design_project_info: `Inspected Galaxy Design project ${pathParam || '.'}`,
    galaxy_design_registry: `Inspected Galaxy Design registry ${getStringParam(message, 'component') || getStringParam(message, 'group') || getStringParam(message, 'query') || getStringParam(message, 'framework') || ''}`.trim(),
    galaxy_design_init: `Initialized Galaxy Design in ${pathParam || '.'}`,
    galaxy_design_add: 'Added Galaxy Design components',
    request_code_review: success ? 'Ran code review' : 'Code review failed',
  };

  return Object.freeze({
    name: toolName,
    success,
    summary:
      summaryByTool[toolName] ??
      summarizeText(message.content, 140) ??
      `${toolName} ${success ? 'ok' : 'failed'}`,
    filesRead,
    filesWritten,
    filesReverted,
  });
}

function collectFilesTouched(toolDigests: readonly ToolDigest[]): readonly string[] {
  const files = new Set<string>();
  for (const digest of toolDigests) {
    digest.filesRead.forEach((file) => files.add(file));
    digest.filesWritten.forEach((file) => files.add(file));
    digest.filesReverted.forEach((file) => files.add(file));
  }
  return Object.freeze([...files]);
}

function extractAttachments(userMessage: ChatMessage, contextNote?: string): readonly string[] {
  const fromMessage = [
    ...(userMessage.attachments?.map((attachment) => attachment.label) ?? []),
    ...(userMessage.figmaAttachments?.map((attachment) => attachment.label) ?? []),
  ];
  const fromContext = Array.from((contextNote ?? '').matchAll(/Read (?:file|document) with path "([^"]+)"/g)).map(
    (match) => match[1]!,
  );
  return mergeUniqueItems([], [...fromMessage, ...fromContext], 10);
}

function buildWorkingSessionHandoff(turn: WorkingTurn, assistantText: string): string {
  const lines: string[] = ['[WORKING SESSION HANDOFF]'];
  lines.push(`User request: ${summarizeText(turn.userMessage.content, 260) || 'N/A'}`);

  if (turn.contextNote?.trim()) {
    lines.push(`Context note: ${summarizeText(turn.contextNote, 220)}`);
  }

  if (assistantText.trim()) {
    lines.push(`Latest assistant state: ${summarizeText(assistantText, 320)}`);
  }

  const completed = turn.toolDigests.filter((digest) => digest.success).map((digest) => digest.summary);
  const blockers = turn.toolDigests.filter((digest) => !digest.success).map((digest) => digest.summary);

  if (completed.length > 0) {
    lines.push('Completed actions:');
    completed.slice(-8).forEach((item) => lines.push(`- ${item}`));
  }

  if (blockers.length > 0) {
    lines.push('Blockers:');
    blockers.slice(-6).forEach((item) => lines.push(`- ${item}`));
  }

  const filesTouched = collectFilesTouched(turn.toolDigests);
  if (filesTouched.length > 0) {
    lines.push(`Files touched: ${filesTouched.join(', ')}`);
  }

  return lines.join('\n');
}

function inferTaskMemoryTurnKind(turn: WorkingTurn, assistantText: string): 'analysis' | 'implementation' | 'review' | 'validation' | 'repair' {
  const toolNames = new Set(turn.toolDigests.map((digest) => digest.name));
  const lowerAssistantText = assistantText.toLowerCase();

  if (toolNames.has('request_code_review') || lowerAssistantText.includes('review finding')) {
    return 'review';
  }
  if (toolNames.has('validate_code')) {
    return 'validation';
  }
  if (toolNames.has('edit_file_range') || toolNames.has('multi_edit_file_ranges') || toolNames.has('write_file') || toolNames.has('edit_file')) {
    return lowerAssistantText.includes('fix') || lowerAssistantText.includes('repair') ? 'repair' : 'implementation';
  }
  return 'analysis';
}

function estimateWorkingTurnTokens(turn: WorkingTurn | null): number {
  if (!turn) {
    return 0;
  }

  return (
    estimateTokens(turn.userMessage.content) +
    estimateTokens(turn.contextNote ?? '') +
    estimateTokens(turn.compactSummary ?? '') +
    turn.contextMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  );
}

function mergeProjectSummary(existing: string, next: string): string {
  const merged = [existing.trim(), next.trim()].filter(Boolean).join('\n\n').trim();
  return summarizeText(merged, 3_200);
}

function compactActiveTaskMemory(memory: ActiveTaskMemory): ActiveTaskMemory {
  if (estimateActiveTaskMemoryTokens(memory) <= ACTIVE_TASK_MEMORY_SOFT_LIMIT) {
    return normalizeActiveTaskMemory(memory);
  }

  return normalizeActiveTaskMemory(
    Object.freeze({
      ...memory,
      completedSteps: Object.freeze(memory.completedSteps.slice(-6)),
      pendingSteps: Object.freeze(memory.pendingSteps.slice(-6)),
      blockers: Object.freeze(memory.blockers.slice(-4)),
      filesTouched: Object.freeze(memory.filesTouched.slice(-10)),
      keyFiles: Object.freeze(memory.keyFiles.slice(-10)),
      attachments: Object.freeze(memory.attachments.slice(-8)),
      deniedCommands: Object.freeze(memory.deniedCommands.slice(-8)),
      recentTurnSummaries: Object.freeze(
        memory.recentTurnSummaries.slice(-4).map((item) => summarizeText(item, 180)),
      ),
      handoffSummary: summarizeText(memory.handoffSummary, 700),
    }),
  );
}

function compactProjectMemory(memory: ProjectMemory): ProjectMemory {
  if (estimateProjectMemoryTokens(memory) <= PROJECT_MEMORY_SOFT_LIMIT) {
    return normalizeProjectMemory(memory);
  }

  return normalizeProjectMemory(
    Object.freeze({
      ...memory,
      summary: summarizeText(memory.summary, 2_400),
      conventions: Object.freeze(memory.conventions.slice(-6)),
      recurringPitfalls: Object.freeze(memory.recurringPitfalls.slice(-6)),
      recentDecisions: Object.freeze(memory.recentDecisions.slice(-8)),
      keyFiles: Object.freeze(memory.keyFiles.slice(-10)),
    }),
  );
}

function createSessionSummaryLine(digest: TurnDigest): string {
  const parts = [
    summarizeText(digest.userMessage, 120),
    summarizeText(digest.assistantSummary, 180),
    digest.filesTouched.length > 0 ? `Files: ${digest.filesTouched.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

export function createHistoryManager(opts: { workspacePath: string; notes?: string }): HistoryManager {
  const workspacePath = path.resolve(opts.workspacePath);
  const notes = opts.notes ?? '';

  let workingTurn: WorkingTurn | null = null;
  const defaultSessionMemory = createEmptySessionMemory(workspacePath);
  let sessionMemory: SessionMemory = loadSessionMemory(workspacePath) ?? defaultSessionMemory;
  const workspaceId = sessionMemory.workspaceId;

  function setSessionMemory(next: Omit<SessionMemory, 'keyFiles'>): void {
    const activeTaskMemory = compactActiveTaskMemory(next.activeTaskMemory);
    const projectMemory = compactProjectMemory(next.projectMemory);
    sessionMemory = Object.freeze({
      ...next,
      activeTaskMemory,
      projectMemory,
      keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    });
  }

  function setWorkingTurn(next: Omit<WorkingTurn, 'tokenEstimate'>): void {
    const frozen = Object.freeze({
      ...next,
      contextMessages: Object.freeze([...next.contextMessages]),
      toolDigests: Object.freeze([...next.toolDigests]),
      tokenEstimate: 0,
    });

    workingTurn = Object.freeze({
      ...frozen,
      tokenEstimate: estimateWorkingTurnTokens(frozen),
    });
  }

  function shouldBeginNewActiveTask(userMessage: ChatMessage): boolean {
    const normalized = userMessage.content.trim().toLowerCase();
    if (normalized === 'continued') {
      return false;
    }
    if (normalized.startsWith('[system continuation]')) {
      return false;
    }
    if (normalized.startsWith('[system validation feedback]')) {
      return false;
    }
    if (normalized.startsWith('[system code review feedback]')) {
      return false;
    }
    return true;
  }

  function beginNewActiveTask(userMessage: ChatMessage, contextNote?: string): void {
    const now = Date.now();
    const nextActiveTask = normalizeActiveTaskMemory(
      Object.freeze({
        ...createEmptyActiveTaskMemory(now),
        taskId: `task-${now}`,
        originalUserGoal: userMessage.content,
        currentObjective: userMessage.content,
        attachments: extractAttachments(userMessage, contextNote),
        lastUpdatedAt: now,
      }),
    );

    setSessionMemory({
      ...sessionMemory,
      activeTaskMemory: nextActiveTask,
      lastUpdatedAt: now,
    });
  }

  function mergeWorkingSessionIntoMemory(turn: WorkingTurn, assistantText: string): void {
    const now = Date.now();
    const filesTouched = collectFilesTouched(turn.toolDigests);
    const completedSteps = turn.toolDigests.filter((digest) => digest.success).map((digest) => digest.summary);
    const blockers = turn.toolDigests.filter((digest) => !digest.success).map((digest) => digest.summary);
    const handoffSummary = buildWorkingSessionHandoff(turn, assistantText);
    const taskMemory = sessionMemory.activeTaskMemory;
    const projectMemory = sessionMemory.projectMemory;

    const nextActiveTask = normalizeActiveTaskMemory(
      Object.freeze({
        ...taskMemory,
        currentObjective: summarizeText(turn.userMessage.content, 500) || taskMemory.currentObjective,
        completedSteps: mergeUniqueItems(taskMemory.completedSteps, completedSteps, 12),
        blockers: mergeUniqueItems(taskMemory.blockers, blockers, 8),
        filesTouched: mergeUniqueItems(taskMemory.filesTouched, filesTouched, 16),
        keyFiles: mergeUniqueItems(taskMemory.keyFiles, filesTouched, 16),
        attachments: mergeUniqueItems(taskMemory.attachments, extractAttachments(turn.userMessage, turn.contextNote), 12),
        recentTurnSummaries: mergeUniqueItems(
          taskMemory.recentTurnSummaries,
          [createSessionSummaryLine(
            Object.freeze({
              turnId: turn.turnId,
              userMessage: turn.userMessage.content,
              assistantSummary: assistantText || turn.assistantDraft || handoffSummary,
              toolDigests: turn.toolDigests,
              keyDecisions: Object.freeze([]),
              pendingItems: Object.freeze([]),
              filesTouched,
              tokenEstimate: turn.tokenEstimate,
              createdAt: now,
            }),
          )],
          8,
        ),
        handoffSummary,
        lastUpdatedAt: now,
      }),
    );

    const nextProjectMemory = normalizeProjectMemory(
      Object.freeze({
        ...projectMemory,
        summary: mergeProjectSummary(projectMemory.summary, handoffSummary),
        recentDecisions: mergeUniqueItems(
          projectMemory.recentDecisions,
          assistantText.trim() ? [summarizeText(assistantText, 220)] : [],
          12,
        ),
        keyFiles: mergeUniqueItems(projectMemory.keyFiles, filesTouched, 16),
        lastUpdatedAt: now,
      }),
    );

    setSessionMemory({
      ...sessionMemory,
      activeTaskMemory: nextActiveTask,
      projectMemory: nextProjectMemory,
      lastFinalAssistantConclusion: assistantText.trim()
        ? summarizeText(assistantText, 2_400)
        : sessionMemory.lastFinalAssistantConclusion,
      lastUpdatedAt: now,
    });
  }

  return {
    getNotes(): string {
      return notes;
    },

    getWorkspaceId(): string {
      return workspaceId;
    },

    getSessionMemory(): SessionMemory {
      return sessionMemory;
    },

    getWorkingTurn(): WorkingTurn | null {
      return workingTurn;
    },

    startTurn(userMessage: ChatMessage, contextNote?: string): WorkingTurn {
      if (shouldBeginNewActiveTask(userMessage)) {
        beginNewActiveTask(userMessage, contextNote);
      }

      setWorkingTurn({
        turnId: `turn-${Date.now()}`,
        userMessage,
        ...(contextNote ? { contextNote } : {}),
        assistantDraft: '',
        contextMessages: [],
        toolDigests: [],
        roundCount: 0,
        startedAt: Date.now(),
        compacted: false,
        droppedContextMessages: 0,
      });
      return workingTurn!;
    },

    appendAssistantDraft(text: string): void {
      if (!workingTurn || !text.trim()) {
        return;
      }

      setWorkingTurn({
        ...workingTurn,
        assistantDraft: `${workingTurn.assistantDraft}${text}`,
      });
    },

    appendContextMessage(message: ChatMessage): void {
      if (!workingTurn) {
        return;
      }

      setWorkingTurn({
        ...workingTurn,
        contextMessages: [...workingTurn.contextMessages, message],
      });
    },

    appendToolMessage(message: ChatMessage): void {
      if (!workingTurn) {
        return;
      }

      const digest = createToolDigest(message);
      setWorkingTurn({
        ...workingTurn,
        contextMessages: [...workingTurn.contextMessages, message],
        toolDigests: [...workingTurn.toolDigests, digest],
      });
    },

    appendToolEvidence(opts: { call: ToolCall; result: ToolResult; toolCallId?: string }): void {
      if (!workingTurn) {
        return;
      }

      const evidence = createToolEvidence({
        workspaceId,
        turnId: workingTurn.turnId,
        toolCallId: opts.toolCallId,
        call: opts.call,
        result: opts.result,
      });

      if (evidence) {
        persistToolEvidence(workspacePath, evidence);
      }
    },

    incrementRound(): void {
      if (!workingTurn) {
        return;
      }

      setWorkingTurn({
        ...workingTurn,
        roundCount: workingTurn.roundCount + 1,
      });
    },

    compactWorkingTurn(opts): boolean {
      if (!workingTurn) {
        return false;
      }

      const force = opts?.force ?? false;
      const promptNearCap =
        typeof opts?.promptTokensEstimate === 'number' && opts.promptTokensEstimate >= HARD_PROMPT_TOKENS;
      const budgetReached =
        typeof opts?.workingTurnBudget === 'number' && workingTurn.tokenEstimate >= opts.workingTurnBudget;
      const emergencyCompact = workingTurn.tokenEstimate >= HARD_PROMPT_TOKENS;

      if (!force && !promptNearCap && !budgetReached && !emergencyCompact) {
        return false;
      }

      mergeWorkingSessionIntoMemory(workingTurn, workingTurn.assistantDraft);
      saveSessionMemory(sessionMemory);

      const handoffSummary = buildWorkingSessionHandoff(workingTurn, workingTurn.assistantDraft);
      setWorkingTurn({
        turnId: `turn-${Date.now()}`,
        userMessage: workingTurn.userMessage,
        ...(workingTurn.contextNote ? { contextNote: workingTurn.contextNote } : {}),
        assistantDraft: '',
        contextMessages: [],
        toolDigests: [],
        roundCount: workingTurn.roundCount,
        startedAt: Date.now(),
        compacted: true,
        compactSummary: handoffSummary,
        droppedContextMessages: workingTurn.droppedContextMessages + workingTurn.contextMessages.length,
      });

      return true;
    },

    finalizeTurn(opts: { assistantText: string }): TurnDigest | null {
      if (!workingTurn) {
        return null;
      }

      const finalAssistantText = opts.assistantText || workingTurn.assistantDraft || workingTurn.compactSummary || '';
      const filesTouched = collectFilesTouched(workingTurn.toolDigests);
      const assistantSummary = summarizeText(
        finalAssistantText || 'No final assistant response.',
      );

      const digest: TurnDigest = Object.freeze({
        turnId: workingTurn.turnId,
        userMessage: workingTurn.userMessage.content,
        assistantSummary,
        toolDigests: Object.freeze([...workingTurn.toolDigests]),
        keyDecisions: Object.freeze([]),
        pendingItems: Object.freeze([]),
        filesTouched,
        tokenEstimate: workingTurn.tokenEstimate,
        createdAt: Date.now(),
      });

      mergeWorkingSessionIntoMemory(workingTurn, finalAssistantText);
      if (finalAssistantText.trim()) {
        appendTaskMemoryEntry(sessionMemory.workspacePath, {
          workspaceId: sessionMemory.workspaceId,
          turnId: workingTurn.turnId,
          turnKind: inferTaskMemoryTurnKind(workingTurn, finalAssistantText),
          userIntent: summarizeText(workingTurn.userMessage.content, 1_200),
          assistantConclusion: summarizeText(finalAssistantText, 2_400),
          filesJson: JSON.stringify(filesTouched),
          attachmentsJson: JSON.stringify(extractAttachments(workingTurn.userMessage, workingTurn.contextNote)),
          confidence: 0.8,
          freshnessScore: 1,
          createdAt: Date.now(),
        });
      }
      saveSessionMemory(sessionMemory);
      workingTurn = null;
      return digest;
    },

    recordExternalEvent(summary: string, filesTouched?: readonly string[]): void {
      const trimmed = summary.trim();
      if (!trimmed) {
        return;
      }

      const now = Date.now();
      const nextActiveTask = normalizeActiveTaskMemory(
        Object.freeze({
          ...sessionMemory.activeTaskMemory,
          recentTurnSummaries: mergeUniqueItems(
            sessionMemory.activeTaskMemory.recentTurnSummaries,
            [summarizeText(trimmed, 220)],
            8,
          ),
          filesTouched: mergeUniqueItems(sessionMemory.activeTaskMemory.filesTouched, filesTouched ?? [], 16),
          keyFiles: mergeUniqueItems(sessionMemory.activeTaskMemory.keyFiles, filesTouched ?? [], 16),
          lastUpdatedAt: now,
        }),
      );
      const nextProjectMemory = normalizeProjectMemory(
        Object.freeze({
          ...sessionMemory.projectMemory,
          summary: mergeProjectSummary(sessionMemory.projectMemory.summary, `[EXTERNAL EVENT]\n${trimmed}`),
          keyFiles: mergeUniqueItems(sessionMemory.projectMemory.keyFiles, filesTouched ?? [], 16),
          recentDecisions: mergeUniqueItems(
            sessionMemory.projectMemory.recentDecisions,
            [summarizeText(trimmed, 220)],
            12,
          ),
          lastUpdatedAt: now,
        }),
      );

      setSessionMemory({
        ...sessionMemory,
        activeTaskMemory: nextActiveTask,
        projectMemory: nextProjectMemory,
        lastUpdatedAt: now,
      });

      saveSessionMemory(sessionMemory);
    },

    clearCurrentTurn(): void {
      workingTurn = null;
    },

    clearAll(): void {
      workingTurn = null;
      sessionMemory = createEmptySessionMemory(workspacePath);
      saveSessionMemory(sessionMemory);
      clearToolEvidence(workspacePath);
    },

    save(): void {
      saveSessionMemory(sessionMemory);
    },
  };
}
