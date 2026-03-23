import path from 'node:path';
import { estimateTokens } from './compaction';
import type { ReadPlanProgressItem, SessionMemory, WorkingTurn } from './history-types';
import type { ManualReadPlanStep } from './syntax-index';
import { loadRecentToolEvidence } from './tool-evidence-store';
import type { ToolEvidence } from './tool-evidence-types';

const MAX_EVIDENCE_TOKENS = 1200;

function getEvidenceTargetPath(evidence: ToolEvidence): string {
  if ('filePath' in evidence) {
    return evidence.filePath;
  }
  if ('directoryPath' in evidence) {
    return evidence.directoryPath;
  }
  if ('targetPath' in evidence) {
    return evidence.targetPath ?? '';
  }
  return '';
}

function extractMentionedPaths(text: string): readonly string[] {
  const matches = text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Object.freeze(matches);
}

function getEvidenceSearchText(evidence: ToolEvidence): string {
  switch (evidence.toolName) {
    case 'grep':
      return `${evidence.summary} ${evidence.pattern} ${evidence.contentPreview}`;
    case 'read_file':
    case 'read_document':
    case 'head':
    case 'tail':
      return `${evidence.summary} ${evidence.contentPreview}`;
    case 'validate_code':
      return `${evidence.summary} ${evidence.reportSummary} ${evidence.contentPreview}`;
    case 'search_web':
    case 'extract_web':
    case 'map_web':
    case 'crawl_web':
      return `${evidence.summary} ${evidence.query ?? ''} ${evidence.contentPreview}`;
    case 'run_project_command':
      return `${evidence.summary} ${evidence.commandLabel} ${evidence.outputPreview}`;
    case 'galaxy_design_registry':
      return `${evidence.summary} ${evidence.component ?? ''} ${evidence.group ?? ''} ${evidence.query ?? ''} ${evidence.sampleComponents.join(' ')}`;
    case 'galaxy_design_project_info':
      return `${evidence.summary} ${evidence.framework ?? ''} ${evidence.packageManager ?? ''}`;
    case 'galaxy_design_init':
    case 'galaxy_design_add':
      return `${evidence.summary} ${evidence.components.join(' ')} ${evidence.outputPreview}`;
    case 'list_dir':
      return `${evidence.summary} ${evidence.entries.map((entry) => entry.name).join(' ')}`;
    case 'write_file':
    case 'edit_file':
      return `${evidence.summary} ${evidence.operation}`;
  }
}

function scoreSymbolMatch(evidence: ToolEvidence, focusSymbols: readonly string[]): number {
  if (focusSymbols.length === 0) {
    return 0;
  }

  const haystack = getEvidenceSearchText(evidence).toLowerCase();
  let score = 0;
  focusSymbols.forEach((symbol) => {
    const normalized = symbol.toLowerCase();
    if (haystack.includes(normalized)) {
      score += evidence.toolName === 'grep' ? 5 : 3;
    }
  });
  return score;
}

function evidenceCoversLine(evidence: ToolEvidence, line: number): boolean {
  if (!('startLine' in evidence) || !('endLine' in evidence)) {
    return false;
  }
  if (typeof evidence.startLine !== 'number' || typeof evidence.endLine !== 'number') {
    return false;
  }
  return line >= evidence.startLine - 12 && line <= evidence.endLine + 12;
}

function scoreReadPlanMatch(
  evidence: ToolEvidence,
  readPlan: readonly ManualReadPlanStep[],
): number {
  if (readPlan.length === 0) {
    return 0;
  }

  const targetPath = getEvidenceTargetPath(evidence);
  let score = 0;

  readPlan.forEach((step) => {
    const pathMatches = targetPath && (targetPath.includes(step.targetPath) || step.targetPath.includes(targetPath));
    if (!pathMatches) {
      return;
    }

    if (step.tool === 'read_file' && (evidence.toolName === 'read_file' || evidence.toolName === 'head' || evidence.toolName === 'tail' || evidence.toolName === 'read_document')) {
      score += 3;
      if (typeof step.line === 'number' && evidenceCoversLine(evidence, step.line)) {
        score += 4;
      }
      return;
    }

    if (step.tool === 'grep' && evidence.toolName === 'grep') {
      score += 3;
      if (step.pattern && evidence.pattern.toLowerCase().includes(step.pattern.toLowerCase())) {
        score += 4;
      }
      if (step.symbolName && evidence.pattern.toLowerCase().includes(step.symbolName.toLowerCase())) {
        score += 2;
      }
    }
  });

  return score;
}

function formatReadPlanStepLabel(step: ManualReadPlanStep): string {
  const lineSuffix = typeof step.line === 'number' ? ` around line ${step.line}` : '';
  const symbolSuffix = step.symbolName ? ` [${step.symbolName}]` : '';
  const patternSuffix = step.pattern && step.tool === 'grep' ? ` pattern=${step.pattern}` : '';
  return `${step.tool} ${step.targetPath}${lineSuffix}${symbolSuffix}${patternSuffix}`;
}

function matchesReadPlanStepEvidence(evidence: ToolEvidence, step: ManualReadPlanStep): boolean {
  const targetPath = getEvidenceTargetPath(evidence);
  const pathMatches = targetPath && (targetPath.includes(step.targetPath) || step.targetPath.includes(targetPath));
  if (!pathMatches || !evidence.success) {
    return false;
  }

  if (step.tool === 'read_file') {
    if (!(evidence.toolName === 'read_file' || evidence.toolName === 'head' || evidence.toolName === 'tail' || evidence.toolName === 'read_document')) {
      return false;
    }
    if (typeof step.line === 'number' && !evidenceCoversLine(evidence, step.line)) {
      return false;
    }
    if (step.symbolName && !getEvidenceSearchText(evidence).toLowerCase().includes(step.symbolName.toLowerCase()) && typeof step.line !== 'number') {
      return false;
    }
    return true;
  }

  if (step.tool === 'grep') {
    if (evidence.toolName !== 'grep') {
      return false;
    }
    if (step.pattern && !evidence.pattern.toLowerCase().includes(step.pattern.toLowerCase())) {
      return false;
    }
    if (step.symbolName && !getEvidenceSearchText(evidence).toLowerCase().includes(step.symbolName.toLowerCase())) {
      return false;
    }
    return true;
  }

  return false;
}

function evaluateReadPlanProgress(
  evidence: readonly ToolEvidence[],
  readPlan: readonly ManualReadPlanStep[],
): Readonly<{
  items: readonly ReadPlanProgressItem[];
  content: string;
  confirmedPaths: readonly string[];
  confirmedSymbols: readonly string[];
  refreshPaths: readonly string[];
  refreshSymbols: readonly string[];
  confirmedCount: number;
}> {
  if (readPlan.length === 0) {
    return Object.freeze({
      items: Object.freeze([]),
      content: '',
      confirmedPaths: Object.freeze([]),
      confirmedSymbols: Object.freeze([]),
      refreshPaths: Object.freeze([]),
      refreshSymbols: Object.freeze([]),
      confirmedCount: 0,
    });
  }

  const items: ReadPlanProgressItem[] = [];
  const confirmedPaths = new Set<string>();
  const confirmedSymbols = new Set<string>();
  const refreshPaths = new Set<string>();
  const refreshSymbols = new Set<string>();
  let confirmedCount = 0;

  readPlan.forEach((step) => {
    let matchedEvidence: ToolEvidence | null = null;
    let staleMatchedEvidence: ToolEvidence | null = null;
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      const candidate = evidence[index]!;
      if (!matchesReadPlanStepEvidence(candidate, step)) {
        continue;
      }
      if (candidate.stale) {
        staleMatchedEvidence ??= candidate;
        continue;
      }
      matchedEvidence = candidate;
      break;
    }

    const effectiveEvidence = matchedEvidence ?? staleMatchedEvidence;
    const status = matchedEvidence ? 'confirmed' : effectiveEvidence ? 'needs_refresh' : 'pending';
    const confirmed = status === 'confirmed';
    if (confirmed) {
      confirmedCount += 1;
      confirmedPaths.add(step.targetPath);
      if (step.symbolName) {
        confirmedSymbols.add(step.symbolName);
      }
    } else if (status === 'needs_refresh') {
      refreshPaths.add(step.targetPath);
      if (step.symbolName) {
        refreshSymbols.add(step.symbolName);
      }
    }

    items.push(
      Object.freeze({
        label: formatReadPlanStepLabel(step),
        confirmed,
        status,
        ...(effectiveEvidence
          ? {
              evidenceSummary:
                matchedEvidence
                  ? formatEvidence(matchedEvidence)
                  : `[stale-read] ${formatEvidence(effectiveEvidence)}`,
            }
          : {}),
        targetPath: step.targetPath,
        ...(step.symbolName ? { symbolName: step.symbolName } : {}),
        tool: step.tool,
      }),
    );
  });

  const lines = ['[READ PLAN PROGRESS]'];
  items.forEach((item) => {
    const marker =
      item.status === 'confirmed'
        ? '[confirmed]'
        : item.status === 'needs_refresh'
          ? '[needs-refresh]'
          : '[pending]';
    lines.push(`- ${marker} ${item.label}`);
    if (item.evidenceSummary) {
      lines.push(`  evidence: ${item.evidenceSummary.replace(/^- /, '')}`);
    }
  });

  return Object.freeze({
    items: Object.freeze(items),
    content: lines.join('\n').trim(),
    confirmedPaths: Object.freeze([...confirmedPaths]),
    confirmedSymbols: Object.freeze([...confirmedSymbols]),
    refreshPaths: Object.freeze([...refreshPaths]),
    refreshSymbols: Object.freeze([...refreshSymbols]),
    confirmedCount,
  });
}

function markPathInvalidation(
  invalidatedFiles: Set<string>,
  invalidatedDirectories: Set<string>,
  targetPath: string,
): void {
  if (!targetPath) {
    return;
  }

  invalidatedFiles.add(targetPath);
  invalidatedDirectories.add(normalizeDirectoryPath(path.dirname(targetPath)));
}

function normalizeDirectoryPath(targetPath: string): string {
  if (!targetPath) {
    return '';
  }

  return targetPath.endsWith(path.sep) ? targetPath : `${targetPath}${path.sep}`;
}

function markDirectoryInvalidation(invalidatedDirectories: Set<string>, targetPath: string): void {
  if (!targetPath) {
    return;
  }

  invalidatedDirectories.add(normalizeDirectoryPath(targetPath));
}

function isWorkspaceMutatingProjectCommand(commandLabel: string, category: string): boolean {
  if (category === 'build') {
    return true;
  }

  const normalized = commandLabel.toLowerCase();
  return /(?:^|\s)(?:install|add|init|create|generate|codegen|scaffold|migrate|upgrade|update|sync)(?:\s|$)|git\s+(?:pull|checkout|switch|merge|rebase|reset)|(?:eslint|stylelint|ruff).+--fix|prettier.+--write|(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:install|add)(?:\s|$)|(?:^|\s)(?:vite|next|nuxt|astro|webpack|rollup|tsup)\s+build(?:\s|$)/.test(normalized);
}

function deriveStaleEvidence(evidence: readonly ToolEvidence[]): readonly ToolEvidence[] {
  const invalidatedFiles = new Set<string>();
  const invalidatedDirectories = new Set<string>();
  let invalidateAllPrior = false;
  const derived = [...evidence];

  for (let index = derived.length - 1; index >= 0; index -= 1) {
    const item = derived[index]!;
    const targetPath = getEvidenceTargetPath(item);
    let stale = item.stale || invalidateAllPrior;

    if (targetPath) {
      if (invalidatedFiles.has(targetPath)) {
        stale = true;
      }
      for (const directory of invalidatedDirectories) {
        if (targetPath.startsWith(directory)) {
          stale = true;
          break;
        }
      }
    }

    derived[index] = stale ? Object.freeze({ ...item, stale: true }) : item;

    if (item.toolName === 'write_file' || item.toolName === 'edit_file') {
      markPathInvalidation(invalidatedFiles, invalidatedDirectories, item.filePath);
      continue;
    }

    if ((item.toolName === 'galaxy_design_init' || item.toolName === 'galaxy_design_add') && item.success) {
      markDirectoryInvalidation(invalidatedDirectories, item.targetPath);
      continue;
    }

    if (
      item.toolName === 'run_project_command' &&
      item.success &&
      isWorkspaceMutatingProjectCommand(item.commandLabel, item.category)
    ) {
      markDirectoryInvalidation(invalidatedDirectories, item.cwd);
      invalidateAllPrior = true;
      if (/git\s+(?:pull|checkout|switch|merge|rebase|reset)/i.test(item.commandLabel)) {
        invalidateAllPrior = true;
      }
    }

  }

  return Object.freeze(derived);
}

function scoreEvidence(
  evidence: ToolEvidence,
  mentionedPaths: readonly string[],
  candidatePaths: readonly string[],
): number {
  let score = 0;
  const targetPath = getEvidenceTargetPath(evidence);

  if (targetPath && candidatePaths.some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
    score += 5;
  }

  if (targetPath && mentionedPaths.some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
    score += 8;
  }

  if (!evidence.stale) {
    score += 1;
  }

  if (evidence.success) {
    score += 1;
  }

  return score;
}

function formatEvidence(evidence: ToolEvidence): string {
  switch (evidence.toolName) {
    case 'list_dir':
      return `- Directory index ${evidence.directoryPath}: ${evidence.entries
        .slice(0, 12)
        .map((entry) => entry.name)
        .join(', ')}${evidence.truncated ? ' ...' : ''}`;
    case 'grep':
      return `- Search ${evidence.pattern} in ${evidence.targetPath}: ${evidence.matches} match${evidence.matches === 1 ? '' : 'es'}`;
    case 'read_file':
    case 'read_document':
    case 'head':
    case 'tail':
      return `- ${evidence.filePath} read ${evidence.startLine && evidence.endLine ? `lines ${evidence.startLine}-${evidence.endLine}` : evidence.readMode}`;
    case 'write_file':
    case 'edit_file':
      return `- ${evidence.filePath} ${evidence.operation}${evidence.changedLineRanges.length > 0 ? ` lines ${evidence.changedLineRanges.map((range) => `${range.startLine}-${range.endLine}`).join(', ')}` : ''}`;
    case 'validate_code':
      return `- Validation for ${evidence.filePath}: ${evidence.reportSummary}`;
    case 'search_web':
      return `- Web search${evidence.query ? ` for "${evidence.query}"` : ''}: ${evidence.resultCount} result${evidence.resultCount === 1 ? '' : 's'}`;
    case 'extract_web':
      return `- Web extract: ${evidence.urls.length} URL${evidence.urls.length === 1 ? '' : 's'}, ${evidence.resultCount} extracted`;
    case 'map_web':
      return `- Web map ${evidence.baseUrl ?? evidence.urls[0] ?? ''}: ${evidence.resultCount} URL${evidence.resultCount === 1 ? '' : 's'}`;
    case 'crawl_web':
      return `- Web crawl ${evidence.baseUrl ?? evidence.urls[0] ?? ''}: ${evidence.resultCount} page${evidence.resultCount === 1 ? '' : 's'}`;
    case 'run_project_command':
      return `- Project command ${evidence.commandLabel} (${evidence.category}) in ${evidence.cwd}${evidence.truncated ? ' [truncated]' : ''}`;
    case 'galaxy_design_project_info':
      return `- Galaxy Design project ${evidence.targetPath ?? '.'}: framework=${evidence.framework ?? 'unknown'}, packageManager=${evidence.packageManager ?? 'unknown'}, initialized=${typeof evidence.initialized === 'boolean' ? (evidence.initialized ? 'yes' : 'no') : 'unknown'}`;
    case 'galaxy_design_registry':
      return `- Galaxy Design registry ${evidence.framework ? `[${evidence.framework}] ` : ''}${evidence.component || evidence.group || evidence.query || 'overview'}${evidence.sampleComponents.length > 0 ? ` -> ${evidence.sampleComponents.slice(0, 8).join(', ')}` : ''}`;
    case 'galaxy_design_init':
      return `- Galaxy Design init at ${evidence.targetPath} using ${evidence.runnerPackageManager}`;
    case 'galaxy_design_add':
      return `- Galaxy Design add at ${evidence.targetPath}: ${evidence.components.join(', ') || 'components added'}`;
  }
}

function buildRetrievalLifecycleBlock(readPlanProgress: readonly ReadPlanProgressItem[]): string {
  if (readPlanProgress.length === 0) {
    return '';
  }

  const confirmed = readPlanProgress.filter((item) => item.status === 'confirmed');
  const refresh = readPlanProgress.filter((item) => item.status === 'needs_refresh');
  const pending = readPlanProgress.filter((item) => item.status !== 'confirmed' && item.status !== 'needs_refresh');
  const lines = ['[RETRIEVAL LIFECYCLE]'];
  if (confirmed.length > 0) {
    lines.push(`Confirmed steps: ${confirmed.map((item) => item.label).join('; ')}`);
  }
  if (refresh.length > 0) {
    lines.push(`Needs refresh after workspace changes: ${refresh.map((item) => item.label).join('; ')}`);
  }
  if (pending.length > 0) {
    lines.push(`Still pending: ${pending.map((item) => item.label).join('; ')}`);
  }
  return lines.join('\n').trim();
}

function buildAntiLoopGuardrails(
  evidence: readonly ToolEvidence[],
  readPlanProgress: readonly ReadPlanProgressItem[],
): string {
  const recentEvidence = evidence.slice(-18);
  const writeCounts = new Map<string, number>();
  const readCounts = new Map<string, number>();

  recentEvidence.forEach((item) => {
    const targetPath = getEvidenceTargetPath(item);
    if (!targetPath) {
      return;
    }

    if (item.toolName === 'write_file' || item.toolName === 'edit_file') {
      writeCounts.set(targetPath, (writeCounts.get(targetPath) ?? 0) + 1);
      return;
    }

    if (item.toolName === 'read_file' || item.toolName === 'head' || item.toolName === 'tail' || item.toolName === 'read_document' || item.toolName === 'grep') {
      readCounts.set(targetPath, (readCounts.get(targetPath) ?? 0) + 1);
    }
  });

  const repeatedWrites = [...writeCounts.entries()].filter(([, count]) => count >= 3);
  const repeatedReads = [...readCounts.entries()].filter(([, count]) => count >= 4);
  const refreshSteps = readPlanProgress.filter((item) => item.status === 'needs_refresh');

  if (repeatedWrites.length === 0 && repeatedReads.length === 0 && refreshSteps.length === 0) {
    return '';
  }

  const lines = ['[ANTI-LOOP GUARDRAILS]'];
  if (repeatedWrites.length > 0) {
    lines.push(`Avoid rewriting the same file without a new reason: ${repeatedWrites.map(([filePath, count]) => `${filePath} (${count} writes)`).join(', ')}`);
  }
  if (repeatedReads.length > 0) {
    lines.push(`Avoid rereading the same file broadly without narrowing scope: ${repeatedReads.map(([filePath, count]) => `${filePath} (${count} reads)`).join(', ')}`);
  }
  if (refreshSteps.length > 0) {
    lines.push('If a step only needs refresh, reread the narrow affected region instead of restarting the whole plan.');
  }
  lines.push('Prefer the next pending step or a user-facing summary when the current file has already been inspected and edited multiple times.');
  return lines.join('\n').trim();
}

export function buildRelevantToolEvidenceBlock(opts: {
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
  preferredPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
  focusSymbols?: readonly string[];
  readPlan?: readonly ManualReadPlanStep[];
}): Readonly<{
  content: string;
  tokens: number;
  entryCount: number;
  readPlanProgress: readonly ReadPlanProgressItem[];
  readPlanProgressContent: string;
  confirmedReadPaths: readonly string[];
  confirmedSymbols: readonly string[];
  refreshReadPaths: readonly string[];
  refreshSymbols: readonly string[];
  confirmedReadCount: number;
  retrievalLifecycleContent: string;
  antiLoopGuardrailsContent: string;
}> {
  const evidence = loadRecentToolEvidence(opts.sessionMemory.workspacePath);
  const freshenedEvidence = deriveStaleEvidence(evidence);
  const readPlanProgress = evaluateReadPlanProgress(freshenedEvidence, opts.readPlan ?? []);
  const retrievalLifecycleContent = buildRetrievalLifecycleBlock(readPlanProgress.items);
  const antiLoopGuardrailsContent = buildAntiLoopGuardrails(freshenedEvidence, readPlanProgress.items);
  if (freshenedEvidence.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
      readPlanProgress: readPlanProgress.items,
      readPlanProgressContent: readPlanProgress.content,
      confirmedReadPaths: readPlanProgress.confirmedPaths,
      confirmedSymbols: readPlanProgress.confirmedSymbols,
      refreshReadPaths: readPlanProgress.refreshPaths,
      refreshSymbols: readPlanProgress.refreshSymbols,
      confirmedReadCount: readPlanProgress.confirmedCount,
      retrievalLifecycleContent,
      antiLoopGuardrailsContent,
    });
  }

  const latestUserMessage = opts.workingTurn?.userMessage.content ?? '';
  const mentionedPaths = extractMentionedPaths(latestUserMessage);
  const workingTurnPaths = opts.workingTurn
    ? opts.workingTurn.toolDigests.flatMap((digest) => [
        ...digest.filesRead,
        ...digest.filesWritten,
        ...digest.filesReverted,
      ])
    : [];
  const candidatePaths = Object.freeze(
    [
      ...new Set([
        ...mentionedPaths,
        ...opts.sessionMemory.keyFiles,
        ...workingTurnPaths,
        ...(opts.preferredPaths ?? []),
        ...(opts.definitionPaths ?? []),
        ...(opts.referencePaths ?? []),
      ]),
    ],
  );

  const selected = [...freshenedEvidence]
    .map((item) => {
      let score = scoreEvidence(item, mentionedPaths, candidatePaths);
      const targetPath = getEvidenceTargetPath(item);
      if (targetPath && (opts.preferredPaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 5;
      }
      if (targetPath && (opts.definitionPaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 4;
      }
      if (targetPath && (opts.referencePaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 3;
      }
      score += scoreSymbolMatch(item, opts.focusSymbols ?? []);
      score += scoreReadPlanMatch(item, opts.readPlan ?? []);
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.capturedAt - a.item.capturedAt)
    .slice(0, 8)
    .map((entry) => entry.item);

  if (selected.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
      readPlanProgress: readPlanProgress.items,
      readPlanProgressContent: readPlanProgress.content,
      confirmedReadPaths: readPlanProgress.confirmedPaths,
      confirmedSymbols: readPlanProgress.confirmedSymbols,
      refreshReadPaths: readPlanProgress.refreshPaths,
      refreshSymbols: readPlanProgress.refreshSymbols,
      confirmedReadCount: readPlanProgress.confirmedCount,
      retrievalLifecycleContent,
      antiLoopGuardrailsContent,
    });
  }

  const lines = ['[RELEVANT TOOL EVIDENCE]'];
  let entryCount = 0;

  for (const item of selected) {
    const line = formatEvidence(item);
    const nextContent = `${lines.join('\n')}\n${line}`;
    if (estimateTokens(nextContent) > MAX_EVIDENCE_TOKENS) {
      break;
    }
    lines.push(line);
    entryCount += 1;
  }

  const content = lines.join('\n').trim();
  return Object.freeze({
    content,
    tokens: estimateTokens(content),
    entryCount,
    readPlanProgress: readPlanProgress.items,
    readPlanProgressContent: readPlanProgress.content,
    confirmedReadPaths: readPlanProgress.confirmedPaths,
    confirmedSymbols: readPlanProgress.confirmedSymbols,
    refreshReadPaths: readPlanProgress.refreshPaths,
    refreshSymbols: readPlanProgress.refreshSymbols,
    confirmedReadCount: readPlanProgress.confirmedCount,
    retrievalLifecycleContent,
    antiLoopGuardrailsContent,
  });
}
