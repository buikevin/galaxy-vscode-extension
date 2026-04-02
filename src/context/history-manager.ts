/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-01
 * @desc Session history management, working-turn compaction, and memory persistence.
 */

import path from 'node:path';
import type { ChatMessage } from '../shared/protocol';
import type { ToolCall, ToolResult } from '../tools/entities/file-tools';
import { normalizeActiveProjectPath, resolveEffectiveProjectPath } from './active-project';
import { HARD_PROMPT_TOKENS } from './entities/constants';
import type { SessionMemory, TurnDigest, WorkingTurn } from './entities/history';
import type { HistoryManager } from './entities/history-manager';
import {
  createEmptyActiveTaskMemory,
  deriveCombinedKeyFiles,
  normalizeActiveTaskMemory,
  normalizeProjectMemory,
} from './memory-format';
import { getProjectStorageInfo } from './project-store';
import { appendTaskMemoryEntry } from './rag-metadata/task-memory';
import { createEmptySessionMemory, loadSessionMemory, saveSessionMemory } from './session-store';
import { clearToolEvidence, createToolEvidence, appendToolEvidence as persistToolEvidence } from './tool-evidence-store';
import {
  buildWorkingSessionHandoff,
  collectFilesTouched,
  compactActiveTaskMemory,
  compactProjectMemory,
  createSessionSummaryLine,
  createToolDigest,
  estimateWorkingTurnTokens,
  extractAttachments,
  inferTaskMemoryTurnKind,
  mergeProjectSummary,
  mergeUniqueItems,
  summarizeText,
} from './history/helpers';

/**
 * Creates the history manager bound to one extension workspace session.
 *
 * @param opts Workspace location and optional persisted notes.
 * @returns Stateful history manager used by the runtime and prompt builder.
 */
export function createHistoryManager(opts: { workspacePath: string; notes?: string }): HistoryManager {
  const workspacePath = path.resolve(opts.workspacePath);
  const notes = opts.notes ?? '';

  let workingTurn: WorkingTurn | null = null;
  const defaultSessionMemory = createEmptySessionMemory(workspacePath);
  let sessionMemory: SessionMemory = loadSessionMemory(workspacePath) ?? defaultSessionMemory;
  const workspaceId = sessionMemory.workspaceId;

  /**
   * Normalizes and stores the next persisted session memory snapshot.
   *
   * @param next Next session memory payload before derived fields are recomputed.
   */
  function setSessionMemory(next: Omit<SessionMemory, 'keyFiles'>): void {
    const activeTaskMemory = compactActiveTaskMemory(next.activeTaskMemory);
    const projectMemory = compactProjectMemory(next.projectMemory);
    sessionMemory = Object.freeze({
      ...next,
      activeProjectPath: normalizeActiveProjectPath(workspacePath, next.activeProjectPath),
      activeTaskMemory,
      projectMemory,
      keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    });
  }

  /**
   * Recomputes the cached token estimate for the active working turn.
   *
   * @param next Working-turn payload before tokenEstimate is derived.
   */
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

  /**
   * Returns true when the current user message should open a new active task.
   *
   * @param userMessage User message starting the turn.
   * @returns Whether the message should reset active-task memory.
   */
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

  /**
   * Resets active task memory for a newly started user task.
   *
   * @param userMessage User message starting the new task.
   * @param contextNote Optional context note attached to the turn.
   */
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
      activeProjectPath: undefined,
      activeTaskMemory: nextActiveTask,
      lastUpdatedAt: now,
    });
  }

  /**
   * Merges the finished or compacted working turn into persisted memories.
   *
   * @param turn Working turn to persist.
   * @param assistantText Final assistant text or draft for the turn.
   * @param opts Optional flags controlling conclusion persistence.
   */
  function mergeWorkingSessionIntoMemory(
    turn: WorkingTurn,
    assistantText: string,
    opts?: Readonly<{ commitConclusion?: boolean }>,
  ): void {
    const now = Date.now();
    const filesTouched = collectFilesTouched(turn.toolDigests);
    const completedSteps = turn.toolDigests.filter((digest) => digest.success).map((digest) => digest.summary);
    const blockers = turn.toolDigests.filter((digest) => !digest.success).map((digest) => digest.summary);
    const handoffSummary = buildWorkingSessionHandoff(turn, assistantText);
    const commitConclusion = opts?.commitConclusion ?? true;
    const taskMemory = sessionMemory.activeTaskMemory;
    const projectMemory = sessionMemory.projectMemory;
    const nextActiveProjectPath = normalizeActiveProjectPath(
      workspacePath,
      resolveEffectiveProjectPath({
        workspacePath,
        activeProjectPath: sessionMemory.activeProjectPath,
        candidateFilePaths: filesTouched,
      }),
    );

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
          commitConclusion && assistantText.trim() ? [summarizeText(assistantText, 220)] : [],
          12,
        ),
        keyFiles: mergeUniqueItems(projectMemory.keyFiles, filesTouched, 16),
        lastUpdatedAt: now,
      }),
    );

    setSessionMemory({
      ...sessionMemory,
      activeProjectPath: nextActiveProjectPath,
      activeTaskMemory: nextActiveTask,
      projectMemory: nextProjectMemory,
      lastFinalAssistantConclusion: commitConclusion && assistantText.trim()
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

    compactWorkingTurn(opts?: {
      force?: boolean;
      workingTurnBudget?: number;
      promptTokensEstimate?: number;
    }): boolean {
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

    finalizeTurn(opts: { assistantText: string; commitConclusion?: boolean }): TurnDigest | null {
      if (!workingTurn) {
        return null;
      }

      const finalAssistantText = opts.assistantText || workingTurn.assistantDraft || workingTurn.compactSummary || '';
      const commitConclusion = opts.commitConclusion ?? true;
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

      mergeWorkingSessionIntoMemory(workingTurn, finalAssistantText, { commitConclusion });
      if (commitConclusion && finalAssistantText.trim()) {
        const taskMemoryWorkspacePath = sessionMemory.activeProjectPath ?? sessionMemory.workspacePath;
        appendTaskMemoryEntry(taskMemoryWorkspacePath, {
          workspaceId: getProjectStorageInfo(taskMemoryWorkspacePath).workspaceId,
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
      const nextActiveProjectPath = normalizeActiveProjectPath(
        workspacePath,
        resolveEffectiveProjectPath({
          workspacePath,
          activeProjectPath: sessionMemory.activeProjectPath,
          candidateFilePaths: filesTouched,
        }),
      );
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
        activeProjectPath: nextActiveProjectPath,
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
