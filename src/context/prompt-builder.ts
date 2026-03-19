import type { ChatMessage } from '../shared/protocol';
import { countContextTokens, estimateTokens } from './compaction';
import type { PromptBuildResult, SessionMemory, WorkingTurn } from './history-types';
import { buildActiveTaskMemoryContent, buildProjectMemoryContent } from './memory-format';
import { buildRelevantToolEvidenceBlock } from './tool-evidence-selector';

function buildContextMessage(content: string, id: string): ChatMessage | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  return Object.freeze({
    id,
    role: 'user',
    content: trimmed,
    timestamp: Date.now(),
  });
}

export function buildPromptContext(opts: {
  notes: string;
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
}): PromptBuildResult {
  const messages: ChatMessage[] = [];

  const notesContent = opts.notes.trim() ? `[NOTES]\n${opts.notes.trim()}` : '';
  const projectMemoryContent = buildProjectMemoryContent(opts.sessionMemory.projectMemory);
  const activeTaskMemoryContent = buildActiveTaskMemoryContent(opts.sessionMemory.activeTaskMemory);
  const evidenceBlock = buildRelevantToolEvidenceBlock({
    sessionMemory: opts.sessionMemory,
    workingTurn: opts.workingTurn,
  });
  const contextNoteContent = opts.workingTurn?.contextNote?.trim() ?? '';
  const compactSummaryContent = opts.workingTurn?.compactSummary?.trim() ?? '';

  const notesMessage = buildContextMessage(notesContent, `ctx-notes-${Date.now()}`);
  if (notesMessage) {
    messages.push(notesMessage);
  }

  const projectMemoryMessage = buildContextMessage(projectMemoryContent, `ctx-project-memory-${Date.now()}`);
  if (projectMemoryMessage) {
    messages.push(projectMemoryMessage);
  }

  const activeTaskMessage = buildContextMessage(activeTaskMemoryContent, `ctx-active-task-${Date.now()}`);
  if (activeTaskMessage) {
    messages.push(activeTaskMessage);
  }

  const evidenceMessage = buildContextMessage(evidenceBlock.content, `ctx-evidence-${Date.now()}`);
  if (evidenceMessage) {
    messages.push(evidenceMessage);
  }

  const contextNoteMessage = buildContextMessage(contextNoteContent, `ctx-working-${Date.now()}`);
  if (contextNoteMessage) {
    messages.push(contextNoteMessage);
  }

  const summaryMessage = buildContextMessage(compactSummaryContent, `ctx-working-summary-${Date.now()}`);
  if (summaryMessage) {
    messages.push(summaryMessage);
  }

  if (opts.workingTurn) {
    messages.push(opts.workingTurn.userMessage);
    messages.push(...opts.workingTurn.contextMessages);
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    notesTokens: estimateTokens(notesContent),
    activeTaskMemoryTokens: estimateTokens(activeTaskMemoryContent),
    projectMemoryTokens: estimateTokens(projectMemoryContent),
    sessionMemoryTokens: estimateTokens(activeTaskMemoryContent) + estimateTokens(projectMemoryContent),
    evidenceTokens: evidenceBlock.tokens,
    workingSessionTokens: opts.workingTurn
      ? countContextTokens([opts.workingTurn.userMessage, ...opts.workingTurn.contextMessages]) +
        estimateTokens(opts.workingTurn.assistantDraft) +
        estimateTokens(compactSummaryContent)
      : 0,
    workingTurnTokens: opts.workingTurn
      ? countContextTokens([opts.workingTurn.userMessage, ...opts.workingTurn.contextMessages]) +
        estimateTokens(opts.workingTurn.assistantDraft) +
        estimateTokens(compactSummaryContent)
      : 0,
    finalPromptTokens: countContextTokens(messages),
    compactedWorkingTurn: Boolean(opts.workingTurn?.compacted),
    droppedRawToolMessages: opts.workingTurn?.droppedContextMessages ?? 0,
    evidenceContent: evidenceBlock.content,
    evidenceEntryCount: evidenceBlock.entryCount,
  });
}
