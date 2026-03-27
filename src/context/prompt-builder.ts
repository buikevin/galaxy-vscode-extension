import type { AgentType, ChatMessage } from '../shared/protocol';
import { countContextTokens, estimateTokens } from './compaction';
import type { PromptBuildResult, ReadPlanProgressItem, SessionMemory, WorkingTurn } from './history-types';
import { buildActiveTaskMemoryContent, buildProjectMemoryContent } from './memory-format';
import { queryRagHintPaths, queryRelevantTaskMemory } from './rag-metadata-store';
import { buildSemanticRetrievalContext } from './semantic-index';
import { buildSyntaxIndexContext, type ManualReadPlanStep, type SyntaxContextRecordSummary } from './syntax-index';
import { appendTelemetryEvent } from './telemetry';
import { buildRelevantToolEvidenceBlock } from './tool-evidence-selector';
import { resolveShellProfile } from '../runtime/shell-resolver';

const MAX_HYBRID_FILES = 4;
const MAX_SKELETON_SYMBOLS = 3;

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

function buildTaskMemoryContent(opts: {
  entries: readonly Readonly<{
    turnKind: string;
    userIntent: string;
    assistantConclusion: string;
    files: readonly string[];
  }>[];
  findings: readonly Readonly<{
    kind: string;
    summary: string;
    filePath?: string;
    line?: number;
    status: string;
  }>[];
}): string {
  if (opts.entries.length === 0 && opts.findings.length === 0) {
    return '';
  }

  const lines: string[] = ['[RELEVANT PRIOR TASK MEMORY]'];
  opts.entries.slice(0, 3).forEach((entry, index) => {
    lines.push(`${index + 1}. [${entry.turnKind}] User intent: ${entry.userIntent}`);
    lines.push(`   Conclusion: ${entry.assistantConclusion}`);
    if (entry.files.length > 0) {
      lines.push(`   Files: ${entry.files.join(', ')}`);
    }
  });

  const openFindings = opts.findings.filter((finding) => finding.status !== 'dismissed').slice(0, 8);
  if (openFindings.length > 0) {
    lines.push('');
    lines.push('[OPEN FINDINGS TO CONTINUE]');
    openFindings.forEach((finding) => {
      const location = finding.filePath
        ? `${finding.filePath}${typeof finding.line === 'number' ? `:${finding.line}` : ''}`
        : '';
      lines.push(`- [${finding.kind}] ${location ? `${location} - ` : ''}${finding.summary}`);
    });
  }

  lines.push('');
  lines.push('Use this memory as high-priority continuity context.');
  lines.push('Do not ask the user to restate or re-derive these points unless the current workspace state, new attachments, review findings, or validation output contradict them.');
  lines.push('If you reopen the analysis, explain briefly what changed or what evidence is now missing.');
  return lines.join('\n').trim();
}

function buildSystemPlatformContent(): string {
  const platformLabel =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform;
  const shell = resolveShellProfile();
  return [
    '[SYSTEM PLATFORM CONTEXT]',
    `Operating system: ${platformLabel} (${process.platform})`,
    `Preferred shell for tool execution: ${shell.kind} via ${shell.executable}`,
    'Choose commands, quoting, path separators, and shell syntax that match this platform.',
    'Do not default to bash/zsh syntax on Windows unless the shell context explicitly supports it.',
  ].join('\n');
}

function extractMentionedPaths(text: string): readonly string[] {
  const matches = text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Object.freeze(matches);
}

function extractQueryIdentifiers(text: string): readonly string[] {
  const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
  return Object.freeze([...new Set(matches.map((item) => item.toLowerCase()))].slice(0, 24));
}

function buildPathTokens(relativePath: string): readonly string[] {
  const normalized = relativePath.toLowerCase();
  const segments = normalized.split('/').flatMap((segment) => segment.split(/[^a-z0-9_]+/));
  return Object.freeze([...new Set(segments.filter((segment) => segment.length >= 2))]);
}

function scorePathAffinity(relativePath: string, candidates: readonly string[]): number {
  if (candidates.length === 0) {
    return 0;
  }

  const lowerPath = relativePath.toLowerCase();
  const basename = lowerPath.split('/').at(-1) ?? lowerPath;
  let score = 0;

  candidates.forEach((candidate) => {
    const normalized = candidate.toLowerCase();
    if (lowerPath === normalized) {
      score += 12;
      return;
    }
    if (basename === normalized.split('/').at(-1)) {
      score += 8;
      return;
    }
    if (lowerPath.includes(normalized) || normalized.includes(lowerPath)) {
      score += 5;
      return;
    }

    const candidateTokens = buildPathTokens(normalized);
    const tokenHits = candidateTokens.filter((token) => lowerPath.includes(token)).length;
    if (tokenHits > 0) {
      score += Math.min(tokenHits, 2) * 2;
    }
  });

  return score;
}

function scoreQueryIdentifierHits(opts: {
  record: SyntaxContextRecordSummary;
  queryIdentifiers: readonly string[];
}): Readonly<{
  score: number;
  reasons: readonly string[];
}> {
  const reasons: string[] = [];
  let score = 0;
  const lowerPath = opts.record.relativePath.toLowerCase();
  const basename = lowerPath.split('/').at(-1) ?? lowerPath;

  const addReason = (reason: string, points: number): void => {
    score += points;
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  opts.queryIdentifiers.forEach((identifier) => {
    if (basename === identifier || basename.startsWith(`${identifier}.`) || basename.includes(`${identifier}.`)) {
      addReason(`query basename hit ${identifier}`, 6);
      return;
    }

    if (lowerPath.includes(`/${identifier}/`) || lowerPath.endsWith(`/${identifier}`)) {
      addReason(`query segment hit ${identifier}`, 5);
      return;
    }

    if (lowerPath.includes(identifier)) {
      addReason(`query path hit ${identifier}`, 3);
    }

    if (
      opts.record.symbols.some((symbol) => symbol.name.toLowerCase() === identifier) ||
      opts.record.exports.some((item) => item.toLowerCase() === identifier)
    ) {
      addReason(`query exact symbol ${identifier}`, 5);
      return;
    }

    if (
      opts.record.symbols.some((symbol) => symbol.name.toLowerCase().includes(identifier)) ||
      opts.record.exports.some((item) => item.toLowerCase().includes(identifier)) ||
      opts.record.imports.some((item) => item.toLowerCase().includes(identifier))
    ) {
      addReason(`query symbol hit ${identifier}`, 2);
    }
  });

  return Object.freeze({
    score,
    reasons: Object.freeze(reasons),
  });
}

function uniquePaths(paths: readonly string[], maxItems?: number): readonly string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  paths.forEach((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    next.push(trimmed);
  });
  return Object.freeze(
    typeof maxItems === 'number' ? next.slice(0, maxItems) : next,
  );
}

function takeRecentPaths(paths: readonly string[], maxItems: number): readonly string[] {
  return uniquePaths(paths.slice(-maxItems));
}

function selectProjectHintPaths(
  queryText: string,
  projectKeyFiles: readonly string[],
): readonly string[] {
  const identifiers = extractQueryIdentifiers(queryText);
  if (projectKeyFiles.length === 0) {
    return Object.freeze([]);
  }

  if (identifiers.length === 0) {
    return takeRecentPaths(projectKeyFiles, 2);
  }

  const matched = projectKeyFiles.filter((filePath) => {
    const lowered = filePath.toLowerCase();
    return identifiers.some((identifier) => lowered.includes(identifier));
  });

  if (matched.length > 0) {
    return takeRecentPaths(matched, 3);
  }

  return takeRecentPaths(projectKeyFiles, 1);
}

function buildCodeMapCandidatesContent(opts: {
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
}): string {
  const lines: string[] = [];
  if (opts.primaryPaths.length > 0) {
    lines.push('[CODE MAP CANDIDATES]');
    lines.push(`Primary files: ${opts.primaryPaths.join(', ')}`);
  }
  if (opts.definitionPaths.length > 0) {
    lines.push(`Definition candidates: ${opts.definitionPaths.join(', ')}`);
  }
  if (opts.referencePaths.length > 0) {
    lines.push(`Reference candidates: ${opts.referencePaths.join(', ')}`);
  }
  return lines.join('\n').trim();
}

function buildSymbolMapCandidatesContent(opts: {
  focusSymbols: readonly string[];
  primaryCandidates: readonly Readonly<{ description: string }>[]; 
  definitionCandidates: readonly Readonly<{ description: string }>[]; 
  referenceCandidates: readonly Readonly<{ description: string }>[]; 
}): string {
  const lines: string[] = [];
  if (opts.focusSymbols.length > 0) {
    lines.push('[SYMBOL MAP CANDIDATES]');
    lines.push(`Focus symbols: ${opts.focusSymbols.join(', ')}`);
  }
  if (opts.primaryCandidates.length > 0) {
    lines.push('Primary symbol candidates:');
    opts.primaryCandidates.slice(0, 4).forEach((candidate) => lines.push(`- ${candidate.description}`));
  }
  if (opts.definitionCandidates.length > 0) {
    lines.push('Definition symbol candidates:');
    opts.definitionCandidates.slice(0, 4).forEach((candidate) => lines.push(`- ${candidate.description}`));
  }
  if (opts.referenceCandidates.length > 0) {
    lines.push('Reference symbol candidates:');
    opts.referenceCandidates.slice(0, 4).forEach((candidate) => lines.push(`- ${candidate.description}`));
  }
  return lines.join('\n').trim();
}

function buildManualPlanningContent(opts: {
  focusSymbols: readonly string[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  primaryCandidates: readonly Readonly<{ description: string; filePath: string; line?: number }>[]; 
  definitionCandidates: readonly Readonly<{ description: string; filePath: string; line?: number }>[]; 
}): string {
  if (
    opts.focusSymbols.length === 0 &&
    opts.primaryPaths.length === 0 &&
    opts.definitionPaths.length === 0 &&
    opts.referencePaths.length === 0 &&
    opts.primaryCandidates.length === 0 &&
    opts.definitionCandidates.length === 0
  ) {
    return '';
  }

  const lines: string[] = ['[MANUAL PLANNING HINTS]'];
  if (opts.focusSymbols.length > 0) {
    lines.push(`Focus on these symbols first: ${opts.focusSymbols.join(', ')}`);
  }

  const targetedReads = [...opts.primaryCandidates, ...opts.definitionCandidates]
    .slice(0, 4)
    .map((candidate) =>
      candidate.line
        ? `read_file(${candidate.filePath}) around line ${candidate.line}`
        : `read_file(${candidate.filePath})`,
    );
  if (targetedReads.length > 0) {
    lines.push(`Start with targeted reads: ${targetedReads.join('; ')}`);
  } else if (opts.primaryPaths.length > 0) {
    lines.push(`Start with these files before broader exploration: ${opts.primaryPaths.join(', ')}`);
  }

  if (opts.definitionPaths.length > 0) {
    lines.push(`Use definition candidates next if the primary file delegates logic: ${opts.definitionPaths.join(', ')}`);
  }
  if (opts.referencePaths.length > 0) {
    lines.push(`Use reference candidates to confirm downstream impact: ${opts.referencePaths.join(', ')}`);
  }

  lines.push('Prefer grep for the focus symbols, then read_file with a narrow maxLines/offset window before expanding to wider scans.');
  lines.push('Avoid broad list_dir or rereading full files unless these targeted reads fail to answer the task.');
  return lines.join('\n').trim();
}

function buildManualReadBatchesBlock(opts: {
  readPlan: readonly Readonly<{
    tool: 'read_file' | 'grep';
    targetPath: string;
    symbolName?: string;
    line?: number;
    pattern?: string;
    reason: string;
  }>[];
}): Readonly<{
  content: string;
  items: readonly string[];
}> {
  if (opts.readPlan.length === 0) {
    return Object.freeze({
      content: '',
      items: Object.freeze([]),
    });
  }

  const readSteps = opts.readPlan.filter((step) => step.tool === 'read_file');
  const grepSteps = opts.readPlan.filter((step) => step.tool === 'grep');
  const lines: string[] = ['[MANUAL READ BATCHES]'];
  const items: string[] = [];

  if (readSteps.length > 0) {
    lines.push('Batch 1: targeted reads');
    readSteps.slice(0, 4).forEach((step) => {
      const lineSuffix = typeof step.line === 'number' ? ` around line ${step.line}` : '';
      const symbolSuffix = step.symbolName ? ` [${step.symbolName}]` : '';
      const item = `read_file ${step.targetPath}${lineSuffix}${symbolSuffix} — ${step.reason}`;
      lines.push(`- ${item}`);
      items.push(item);
    });
  }

  if (grepSteps.length > 0) {
    lines.push('Batch 2: symbol verification');
    grepSteps.slice(0, 4).forEach((step) => {
      const patternSuffix = step.pattern ? ` pattern=${step.pattern}` : '';
      const item = `grep ${step.targetPath}${patternSuffix} — ${step.reason}`;
      lines.push(`- ${item}`);
      items.push(item);
    });
  }

  return Object.freeze({
    content: lines.join('\n').trim(),
    items: Object.freeze(items),
  });
}

function filterPendingReadPlan(
  readPlan: readonly ManualReadPlanStep[],
  progressItems: readonly ReadPlanProgressItem[],
): readonly ManualReadPlanStep[] {
  if (readPlan.length === 0 || progressItems.length === 0) {
    return readPlan;
  }

  const confirmedKeys = new Set(
    progressItems
      .filter((item) => item.confirmed)
      .map((item) => `${item.tool}:${item.targetPath}:${item.symbolName ?? ''}:${item.label}`),
  );

  const pending = readPlan.filter((step) => {
    const labelParts = [
      step.tool,
      step.targetPath,
      typeof step.line === 'number' ? ` around line ${step.line}` : '',
      step.symbolName ? ` [${step.symbolName}]` : '',
      step.pattern && step.tool === 'grep' ? ` pattern=${step.pattern}` : '',
    ];
    const label = `${labelParts[0]} ${labelParts[1]}${labelParts[2]}${labelParts[3]}${labelParts[4]}`;
    return !confirmedKeys.has(`${step.tool}:${step.targetPath}:${step.symbolName ?? ''}:${label}`);
  });

  return pending.length > 0 ? Object.freeze(pending) : Object.freeze([]);
}

function prioritizeRefreshReadPlan(
  readPlan: readonly ManualReadPlanStep[],
  progressItems: readonly ReadPlanProgressItem[],
): readonly ManualReadPlanStep[] {
  if (readPlan.length === 0 || progressItems.length === 0) {
    return readPlan;
  }

  const refreshKeys = new Set(
    progressItems
      .filter((item) => item.status === 'needs_refresh')
      .map((item) => `${item.tool}:${item.targetPath}:${item.symbolName ?? ''}`),
  );

  const refreshSteps = readPlan.filter((step) => refreshKeys.has(`${step.tool}:${step.targetPath}:${step.symbolName ?? ''}`));
  const otherSteps = readPlan.filter((step) => !refreshKeys.has(`${step.tool}:${step.targetPath}:${step.symbolName ?? ''}`));
  return Object.freeze([...refreshSteps, ...otherSteps]);
}

function buildHybridRetrievalBlocks(opts: {
  queryText: string;
  records: readonly SyntaxContextRecordSummary[];
  mentionedPaths: readonly string[];
  workingTurnFiles: readonly string[];
  keyFiles: readonly string[];
  recentPaths: readonly string[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  focusSymbols: readonly string[];
  semanticPaths?: readonly string[];
  deprioritizedPaths?: readonly string[];
  deprioritizedSymbols?: readonly string[];
}): Readonly<{
  content: string;
  skeletonContent: string;
  candidatePaths: readonly string[];
}> {
  const queryIdentifiers = extractQueryIdentifiers(opts.queryText);

  const ranked = opts.records
    .map((record) => {
      let score = 0;
      const reasons: string[] = [];
      const matchedSymbols: string[] = [];
      const lowerPath = record.relativePath.toLowerCase();

      const addReason = (label: string, points: number): void => {
        score += points;
        if (!reasons.includes(label)) {
          reasons.push(label);
        }
      };

      const mentionedPathScore = scorePathAffinity(record.relativePath, opts.mentionedPaths);
      if (mentionedPathScore > 0) {
        addReason('mentioned path', mentionedPathScore);
      }

      const workingTurnPathScore = scorePathAffinity(record.relativePath, opts.workingTurnFiles);
      if (workingTurnPathScore > 0) {
        addReason('active turn file', Math.max(workingTurnPathScore, 8));
      }

      const keyFileScore = scorePathAffinity(record.relativePath, opts.keyFiles);
      if (keyFileScore > 0) {
        addReason('session key file', Math.max(keyFileScore, 5));
      }

      const recentPathScore = scorePathAffinity(record.relativePath, opts.recentPaths);
      if (recentPathScore > 0) {
        addReason('recent task file', Math.max(recentPathScore, 3));
      }

      const primaryPathScore = scorePathAffinity(record.relativePath, opts.primaryPaths);
      if (primaryPathScore > 0) {
        addReason('primary candidate', Math.max(primaryPathScore, 6));
      }

      const definitionPathScore = scorePathAffinity(record.relativePath, opts.definitionPaths);
      if (definitionPathScore > 0) {
        addReason('definition edge', Math.max(definitionPathScore, 4));
      }

      const referencePathScore = scorePathAffinity(record.relativePath, opts.referencePaths);
      if (referencePathScore > 0) {
        addReason('reference edge', Math.max(referencePathScore, 3));
      }

      const semanticPathScore = scorePathAffinity(record.relativePath, opts.semanticPaths ?? []);
      if (semanticPathScore > 0) {
        addReason('semantic retrieval hit', Math.max(semanticPathScore, 4));
      }

      const deprioritizedPathScore = scorePathAffinity(record.relativePath, opts.deprioritizedPaths ?? []);
      if (deprioritizedPathScore > 0) {
        addReason('already confirmed by evidence', -Math.max(Math.floor(deprioritizedPathScore / 2), 4));
      }

      opts.focusSymbols.forEach((focusSymbol) => {
        const matched = record.symbols.find((symbol) => symbol.name.toLowerCase() === focusSymbol.toLowerCase());
        if (matched) {
          const isDeprioritized = (opts.deprioritizedSymbols ?? []).some(
            (symbol) => symbol.toLowerCase() === matched.name.toLowerCase(),
          );
          addReason(
            isDeprioritized ? `already confirmed symbol ${matched.name}` : `focus symbol ${matched.name}`,
            isDeprioritized ? -6 : 6,
          );
          if (!matchedSymbols.includes(matched.name)) {
            matchedSymbols.push(matched.name);
          }
        }
      });

      const queryHits = scoreQueryIdentifierHits({
        record,
        queryIdentifiers,
      });
      queryHits.reasons.forEach((reason) => addReason(reason, 0));
      score += queryHits.score;

      const graphAffinity =
        record.resolvedImports.filter((item) => opts.primaryPaths.includes(item) || opts.definitionPaths.includes(item)).length +
        opts.referencePaths.filter((item) => item === record.relativePath).length;
      if (graphAffinity > 0) {
        addReason('syntax graph affinity', Math.min(graphAffinity, 3) * 2);
      }

      return Object.freeze({
        record,
        score,
        reasons: Object.freeze(reasons),
        matchedSymbols: Object.freeze(matchedSymbols),
      });
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.relativePath.localeCompare(b.record.relativePath))
    .slice(0, MAX_HYBRID_FILES);

  if (ranked.length === 0) {
    return Object.freeze({
      content: '',
      skeletonContent: '',
      candidatePaths: Object.freeze([]),
    });
  }

  const retrievalLines = ['[HYBRID RETRIEVAL]'];
  ranked.forEach((entry) => {
    retrievalLines.push(`- ${entry.record.relativePath} (score ${entry.score}): ${entry.reasons.join(', ')}`);
  });

  const skeletonLines = ['[SKELETON RETRIEVAL]'];
  ranked.forEach((entry, index) => {
    if (index > 0) {
      skeletonLines.push('');
    }
    skeletonLines.push(`File: ${entry.record.relativePath}`);
    const preferredSymbols = entry.matchedSymbols.length > 0
      ? entry.record.symbols.filter((symbol) => entry.matchedSymbols.includes(symbol.name))
      : entry.record.symbols.filter((symbol) => symbol.exported);
    const deprioritizedSymbols = new Set((opts.deprioritizedSymbols ?? []).map((symbol) => symbol.toLowerCase()));
    const candidateSymbols = preferredSymbols.length > 0 ? preferredSymbols : entry.record.symbols;
    const filteredSymbols = candidateSymbols.filter((symbol) => !deprioritizedSymbols.has(symbol.name.toLowerCase()));
    const skeletonSymbols = (filteredSymbols.length > 0 ? filteredSymbols : candidateSymbols).slice(0, MAX_SKELETON_SYMBOLS);
    skeletonSymbols.forEach((symbol) => {
      skeletonLines.push(`- ${symbol.signature}`);
    });
  });

  return Object.freeze({
    content: retrievalLines.join('\n').trim(),
    skeletonContent: skeletonLines.join('\n').trim(),
    candidatePaths: Object.freeze(ranked.map((entry) => entry.record.relativePath)),
  });
}

export async function buildPromptContext(opts: {
  agentType: AgentType;
  notes: string;
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
}): Promise<PromptBuildResult> {
  const messages: ChatMessage[] = [];
  const workingTurnFiles =
    opts.workingTurn?.toolDigests.flatMap((digest) => [
      ...digest.filesRead,
      ...digest.filesWritten,
      ...digest.filesReverted,
    ]) ?? [];
  const mentionedPaths = extractMentionedPaths(opts.workingTurn?.userMessage.content ?? '');
  const queryText = opts.workingTurn?.userMessage.content ?? '';
  const activeTaskRetrievalPaths = uniquePaths([
    ...opts.sessionMemory.activeTaskMemory.filesTouched,
    ...opts.sessionMemory.activeTaskMemory.keyFiles,
  ]);
  const projectHintPaths = selectProjectHintPaths(
    queryText,
    opts.sessionMemory.projectMemory.keyFiles,
  );
  const sqliteHintPaths = queryRagHintPaths(
    opts.sessionMemory.workspacePath,
    queryText,
    4,
  );
  const retrievalSeedPaths = uniquePaths([
    ...mentionedPaths,
    ...workingTurnFiles,
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...projectHintPaths,
    ...sqliteHintPaths,
  ]);
  const retrievalKeyFiles = uniquePaths([
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...projectHintPaths,
    ...sqliteHintPaths,
  ]);
  const retrievalRecentPaths = uniquePaths([
    ...takeRecentPaths(opts.sessionMemory.activeTaskMemory.filesTouched, 8),
    ...takeRecentPaths(opts.sessionMemory.projectMemory.keyFiles, 4),
  ]);

  const notesContent = opts.notes.trim() ? `[NOTES]\n${opts.notes.trim()}` : '';
  const systemPlatformContent = buildSystemPlatformContent();
  const taskMemory = await queryRelevantTaskMemory(
    opts.sessionMemory.workspacePath,
    queryText,
    3,
  );
  const taskMemoryContent = buildTaskMemoryContent(taskMemory);
  const projectMemoryContent = buildProjectMemoryContent(opts.sessionMemory.projectMemory);
  const activeTaskMemoryContent = buildActiveTaskMemoryContent(opts.sessionMemory.activeTaskMemory);
  const previousFinalConclusionContent = opts.sessionMemory.lastFinalAssistantConclusion.trim()
    ? `[PREVIOUS FINAL ASSISTANT CONCLUSION]\n` +
      `${opts.sessionMemory.lastFinalAssistantConclusion.trim()}\n\n` +
      'Treat this as the most recent authoritative conclusion from the previous completed turn. Prefer continuing from it instead of restarting the analysis from scratch. If you need to reopen the analysis, explain what current evidence contradicts it or what new information is missing.'
    : '';
  const syntaxIndexBlock = await buildSyntaxIndexContext({
    workspacePath: opts.sessionMemory.workspacePath,
    candidateFiles: retrievalSeedPaths,
    queryText,
  });
  const semanticRetrievalBlock = await buildSemanticRetrievalContext({
    workspacePath: opts.sessionMemory.workspacePath,
    queryText,
    candidateFiles: [
      ...retrievalSeedPaths,
      ...syntaxIndexBlock.priorityPaths,
    ],
    records: syntaxIndexBlock.records,
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
  });
  const initialHybridRetrievalBlock = buildHybridRetrievalBlocks({
    queryText,
    records: syntaxIndexBlock.records,
    mentionedPaths,
    workingTurnFiles,
    keyFiles: retrievalKeyFiles,
    recentPaths: retrievalRecentPaths,
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    semanticPaths: semanticRetrievalBlock.candidatePaths,
  });
  const codeMapCandidatesContent = buildCodeMapCandidatesContent({
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
  });
  const symbolMapCandidatesContent = buildSymbolMapCandidatesContent({
    focusSymbols: syntaxIndexBlock.focusSymbols,
    primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
    definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
    referenceCandidates: syntaxIndexBlock.referenceSymbolCandidates,
  });
  const manualPlanningContent =
    opts.agentType === 'manual'
      ? buildManualPlanningContent({
          focusSymbols: syntaxIndexBlock.focusSymbols,
          primaryPaths: syntaxIndexBlock.primaryPaths,
          definitionPaths: syntaxIndexBlock.definitionPaths,
          referencePaths: syntaxIndexBlock.referencePaths,
          primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
          definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
        })
      : '';
  const evidenceBlock = buildRelevantToolEvidenceBlock({
    sessionMemory: opts.sessionMemory,
    workingTurn: opts.workingTurn,
    preferredPaths:
      initialHybridRetrievalBlock.candidatePaths.length > 0
        ? initialHybridRetrievalBlock.candidatePaths
        : syntaxIndexBlock.priorityPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    readPlan: syntaxIndexBlock.manualReadPlan,
  });
  const pendingReadPlan =
    opts.agentType === 'manual'
      ? prioritizeRefreshReadPlan(
          filterPendingReadPlan(syntaxIndexBlock.manualReadPlan, evidenceBlock.readPlanProgress),
          evidenceBlock.readPlanProgress,
        )
      : Object.freeze([]);
  const manualReadBatchesBlock =
    opts.agentType === 'manual'
      ? buildManualReadBatchesBlock({
          readPlan: pendingReadPlan,
        })
      : Object.freeze({
          content: '',
          items: Object.freeze([]),
        });
  const feedbackHybridRetrievalBlock = buildHybridRetrievalBlocks({
    queryText,
    records: syntaxIndexBlock.records,
    mentionedPaths,
    workingTurnFiles,
    keyFiles: retrievalKeyFiles,
    recentPaths: retrievalRecentPaths,
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    semanticPaths: semanticRetrievalBlock.candidatePaths,
    deprioritizedPaths: evidenceBlock.confirmedReadPaths,
    deprioritizedSymbols: evidenceBlock.confirmedSymbols,
  });
  const hybridRetrievalBlock =
    feedbackHybridRetrievalBlock.candidatePaths.length > 0
      ? feedbackHybridRetrievalBlock
      : initialHybridRetrievalBlock;
  const contextNoteContent = opts.workingTurn?.contextNote?.trim() ?? '';
  const compactSummaryContent = opts.workingTurn?.compactSummary?.trim() ?? '';
  const workingPromptTokens = opts.workingTurn
    ? countContextTokens([opts.workingTurn.userMessage, ...opts.workingTurn.contextMessages]) +
      estimateTokens(contextNoteContent) +
      estimateTokens(compactSummaryContent)
    : 0;

  const notesMessage = buildContextMessage(notesContent, `ctx-notes-${Date.now()}`);
  if (notesMessage) {
    messages.push(notesMessage);
  }

  const systemPlatformMessage = buildContextMessage(systemPlatformContent, `ctx-platform-${Date.now()}`);
  if (systemPlatformMessage) {
    messages.push(systemPlatformMessage);
  }

  const taskMemoryMessage = buildContextMessage(taskMemoryContent, `ctx-task-memory-${Date.now()}`);
  if (taskMemoryMessage) {
    messages.push(taskMemoryMessage);
  }

  const projectMemoryMessage = buildContextMessage(projectMemoryContent, `ctx-project-memory-${Date.now()}`);
  if (projectMemoryMessage) {
    messages.push(projectMemoryMessage);
  }

  const activeTaskMessage = buildContextMessage(activeTaskMemoryContent, `ctx-active-task-${Date.now()}`);
  if (activeTaskMessage) {
    messages.push(activeTaskMessage);
  }

  const previousFinalConclusionMessage = buildContextMessage(
    previousFinalConclusionContent,
    `ctx-previous-final-conclusion-${Date.now()}`,
  );
  if (previousFinalConclusionMessage) {
    messages.push(previousFinalConclusionMessage);
  }

  const codeMapCandidatesMessage = buildContextMessage(codeMapCandidatesContent, `ctx-code-map-${Date.now()}`);
  if (codeMapCandidatesMessage) {
    messages.push(codeMapCandidatesMessage);
  }

  const hybridRetrievalMessage = buildContextMessage(hybridRetrievalBlock.content, `ctx-hybrid-retrieval-${Date.now()}`);
  if (hybridRetrievalMessage) {
    messages.push(hybridRetrievalMessage);
  }

  const semanticRetrievalMessage = buildContextMessage(semanticRetrievalBlock.content, `ctx-semantic-retrieval-${Date.now()}`);
  if (semanticRetrievalMessage) {
    messages.push(semanticRetrievalMessage);
  }

  const semanticChunkMessage = buildContextMessage(semanticRetrievalBlock.chunkContent, `ctx-semantic-chunks-${Date.now()}`);
  if (semanticChunkMessage) {
    messages.push(semanticChunkMessage);
  }

  const skeletonRetrievalMessage = buildContextMessage(hybridRetrievalBlock.skeletonContent, `ctx-skeleton-retrieval-${Date.now()}`);
  if (skeletonRetrievalMessage) {
    messages.push(skeletonRetrievalMessage);
  }

  const symbolMapCandidatesMessage = buildContextMessage(symbolMapCandidatesContent, `ctx-symbol-map-${Date.now()}`);
  if (symbolMapCandidatesMessage) {
    messages.push(symbolMapCandidatesMessage);
  }

  const manualPlanningMessage = buildContextMessage(manualPlanningContent, `ctx-manual-plan-${Date.now()}`);
  if (manualPlanningMessage) {
    messages.push(manualPlanningMessage);
  }

  const manualReadBatchesMessage = buildContextMessage(manualReadBatchesBlock.content, `ctx-manual-batches-${Date.now()}`);
  if (manualReadBatchesMessage) {
    messages.push(manualReadBatchesMessage);
  }

  const readPlanProgressMessage = buildContextMessage(evidenceBlock.readPlanProgressContent, `ctx-read-plan-progress-${Date.now()}`);
  if (readPlanProgressMessage) {
    messages.push(readPlanProgressMessage);
  }

  const retrievalLifecycleMessage = buildContextMessage(
    evidenceBlock.retrievalLifecycleContent,
    `ctx-retrieval-lifecycle-${Date.now()}`,
  );
  if (retrievalLifecycleMessage) {
    messages.push(retrievalLifecycleMessage);
  }

  const antiLoopGuardrailsMessage = buildContextMessage(
    evidenceBlock.antiLoopGuardrailsContent,
    `ctx-anti-loop-${Date.now()}`,
  );
  if (antiLoopGuardrailsMessage) {
    messages.push(antiLoopGuardrailsMessage);
  }

  const evidenceReuseMessage = buildContextMessage(
    evidenceBlock.evidenceReuseContent,
    `ctx-evidence-reuse-${Date.now()}`,
  );
  if (evidenceReuseMessage) {
    messages.push(evidenceReuseMessage);
  }

  const syntaxIndexMessage = buildContextMessage(syntaxIndexBlock.content, `ctx-syntax-index-${Date.now()}`);
  if (syntaxIndexMessage) {
    messages.push(syntaxIndexMessage);
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

  const result = Object.freeze({
    messages: Object.freeze(messages),
    notesTokens: estimateTokens(notesContent) + estimateTokens(systemPlatformContent),
    taskMemoryTokens: estimateTokens(taskMemoryContent),
    activeTaskMemoryTokens: estimateTokens(activeTaskMemoryContent),
    projectMemoryTokens: estimateTokens(projectMemoryContent),
    sessionMemoryTokens: estimateTokens(activeTaskMemoryContent) + estimateTokens(projectMemoryContent),
    evidenceTokens: evidenceBlock.tokens + estimateTokens(evidenceBlock.readPlanProgressContent),
    syntaxIndexTokens:
      syntaxIndexBlock.tokens +
      semanticRetrievalBlock.tokens +
      estimateTokens(hybridRetrievalBlock.content) +
      estimateTokens(hybridRetrievalBlock.skeletonContent) +
      estimateTokens(codeMapCandidatesContent) +
      estimateTokens(symbolMapCandidatesContent) +
      estimateTokens(manualPlanningContent) +
      estimateTokens(manualReadBatchesBlock.content),
    workingSessionTokens: workingPromptTokens,
    workingTurnTokens: workingPromptTokens,
    finalPromptTokens: countContextTokens(messages),
    compactedWorkingTurn: Boolean(opts.workingTurn?.compacted),
    droppedRawToolMessages: opts.workingTurn?.droppedContextMessages ?? 0,
    evidenceContent: evidenceBlock.content,
    evidenceEntryCount: evidenceBlock.entryCount,
    syntaxIndexEntryCount: syntaxIndexBlock.entryCount,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    manualPlanningContent,
    manualReadBatchesContent: manualReadBatchesBlock.content,
    manualReadBatchItems: manualReadBatchesBlock.items,
    readPlanProgressContent: evidenceBlock.readPlanProgressContent,
    readPlanProgressItems: evidenceBlock.readPlanProgress,
    confirmedReadCount: evidenceBlock.confirmedReadCount,
    retrievalLifecycleContent: evidenceBlock.retrievalLifecycleContent,
    antiLoopGuardrailsContent: evidenceBlock.antiLoopGuardrailsContent,
  });

  appendTelemetryEvent(opts.sessionMemory.workspacePath, {
    kind: 'prompt_build',
    promptTokensEstimate: result.finalPromptTokens,
    evidenceEntryCount: result.evidenceEntryCount,
    syntaxIndexEntryCount: result.syntaxIndexEntryCount,
    confirmedReadCount: result.confirmedReadCount,
    readPlanCount: result.readPlanProgressItems.length,
    compactedWorkingTurn: result.compactedWorkingTurn,
    hybridCandidateCount: hybridRetrievalBlock.candidatePaths.length,
    semanticCandidateCount: semanticRetrievalBlock.candidatePaths.length,
  });

  return result;
}
