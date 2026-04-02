/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Prompt context block builders extracted from prompt-builder for maintainability.
 */

import type { ReadPlanProgressItem } from '../entities/history';
import { resolveShellProfile } from '../../runtime/shell-resolver';
import type { ManualReadPlanStep, SyntaxSymbolCandidate } from '../entities/syntax-index';

/**
 * Builds high-priority task memory continuation content.
 */
export function buildTaskMemoryContent(opts: {
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

/**
 * Builds platform-aware command execution guidance.
 */
export function buildSystemPlatformContent(): string {
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

/**
 * Builds a code-map candidate block from prioritized file paths.
 */
export function buildCodeMapCandidatesContent(opts: {
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

/**
 * Builds a symbol-centric code map candidate block.
 */
export function buildSymbolMapCandidatesContent(opts: {
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

/**
 * Builds manual planning hints for the manual agent mode.
 */
export function buildManualPlanningContent(opts: {
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

/**
 * Determines whether manual planning hints should be emitted again for the current round.
 *
 * @param opts Current read-plan progress and working-turn scope signals.
 * @returns `true` when the runtime still needs to actively steer the next discovery step.
 */
export function shouldEmitManualPlanningHints(opts: {
  confirmedReadCount: number;
  pendingReadPlanCount: number;
  refreshReadPathCount: number;
  workingTurnFileCount: number;
}): boolean {
  if (opts.refreshReadPathCount > 0) {
    return true;
  }

  if (opts.confirmedReadCount <= 0) {
    return true;
  }

  if (opts.workingTurnFileCount <= 0 && opts.pendingReadPlanCount > 0) {
    return true;
  }

  return false;
}

/**
 * Narrows manual-planning candidates to the current task/file scope when strong path signals exist.
 */
export function narrowManualPlanningScope(opts: {
  scopedPaths: readonly string[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  primaryCandidates: readonly SyntaxSymbolCandidate[];
  definitionCandidates: readonly SyntaxSymbolCandidate[];
  referenceCandidates: readonly SyntaxSymbolCandidate[];
  manualReadPlan: readonly ManualReadPlanStep[];
}): Readonly<{
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  primaryCandidates: readonly SyntaxSymbolCandidate[];
  definitionCandidates: readonly SyntaxSymbolCandidate[];
  referenceCandidates: readonly SyntaxSymbolCandidate[];
  manualReadPlan: readonly ManualReadPlanStep[];
}> {
  const scopedPaths = opts.scopedPaths.filter((candidate) => candidate.trim().length > 0);
  if (scopedPaths.length === 0) {
    return Object.freeze({
      primaryPaths: Object.freeze([...opts.primaryPaths]),
      definitionPaths: Object.freeze([...opts.definitionPaths]),
      referencePaths: Object.freeze([...opts.referencePaths]),
      primaryCandidates: Object.freeze([...opts.primaryCandidates]),
      definitionCandidates: Object.freeze([...opts.definitionCandidates]),
      referenceCandidates: Object.freeze([...opts.referenceCandidates]),
      manualReadPlan: Object.freeze([...opts.manualReadPlan]),
    });
  }

  const scopedSet = new Set(scopedPaths);
  const matchesScope = (candidatePath: string): boolean =>
    scopedSet.has(candidatePath) ||
    scopedPaths.some((scopedPath) => candidatePath.endsWith(scopedPath) || scopedPath.endsWith(candidatePath));
  const filterPaths = (paths: readonly string[]): readonly string[] => {
    const filtered = paths.filter(matchesScope);
    return Object.freeze(filtered.length > 0 ? filtered : [...paths]);
  };
  const filterCandidates = <T extends Readonly<{ filePath: string }>>(candidates: readonly T[]): readonly T[] => {
    const filtered = candidates.filter((candidate) => matchesScope(candidate.filePath));
    return Object.freeze(filtered.length > 0 ? filtered : [...candidates]);
  };
  const filterReadPlan = (steps: readonly ManualReadPlanStep[]): readonly ManualReadPlanStep[] => {
    const filtered = steps.filter((step) => matchesScope(step.targetPath));
    return Object.freeze(filtered.length > 0 ? filtered : [...steps]);
  };

  return Object.freeze({
    primaryPaths: filterPaths(opts.primaryPaths),
    definitionPaths: filterPaths(opts.definitionPaths),
    referencePaths: filterPaths(opts.referencePaths),
    primaryCandidates: filterCandidates(opts.primaryCandidates),
    definitionCandidates: filterCandidates(opts.definitionCandidates),
    referenceCandidates: filterCandidates(opts.referenceCandidates),
    manualReadPlan: filterReadPlan(opts.manualReadPlan),
  });
}

/**
 * Builds manual read batches from a pending read plan.
 */
export function buildManualReadBatchesBlock(opts: {
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

/**
 * Filters a read plan down to steps not already confirmed by evidence.
 */
export function filterPendingReadPlan<T extends Readonly<{
    tool: 'read_file' | 'grep';
    targetPath: string;
    symbolName?: string;
    line?: number;
    pattern?: string;
  }>>(
  readPlan: readonly T[],
  progressItems: readonly ReadPlanProgressItem[],
): readonly T[] {
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

/**
 * Prioritizes read-plan steps that need a refresh according to evidence.
 */
export function prioritizeRefreshReadPlan<T extends Readonly<{ tool: string; targetPath: string; symbolName?: string }>>(
  readPlan: readonly T[],
  progressItems: readonly ReadPlanProgressItem[],
): readonly T[] {
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
