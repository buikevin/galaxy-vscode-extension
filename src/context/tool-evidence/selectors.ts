/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-02
 * @desc Evidence formatting, stale detection, and retrieval guardrail helpers for the extension runtime.
 */

import path from 'node:path';
import type { ReadPlanProgressItem } from '../entities/history';
import type { ToolEvidence } from '../entities/tool-evidence';

/**
 * Returns true when a path looks like a documentation or prose file.
 *
 * @param targetPath File path associated with the current evidence item.
 * @returns Whether the path is likely a long-form document rather than source code.
 */
function isDocumentationPath(targetPath: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(targetPath);
}

/**
 * Returns the primary path associated with one evidence item.
 *
 * @param evidence Tool evidence item to inspect.
 * @returns File, directory, or target path used for matching.
 */
export function getEvidenceTargetPath(evidence: ToolEvidence): string {
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

/**
 * Extracts candidate file paths mentioned in free-form text.
 *
 * @param text Source text to scan.
 * @returns Frozen list of likely path mentions.
 */
export function extractMentionedPaths(text: string): readonly string[] {
  const matches = text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Object.freeze(matches);
}

/**
 * Builds a searchable text blob from one evidence item.
 *
 * @param evidence Tool evidence item to flatten.
 * @returns Search text used for ranking and symbol matching.
 */
export function getEvidenceSearchText(evidence: ToolEvidence): string {
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
    case 'edit_file_range':
    case 'multi_edit_file_ranges':
      return `${evidence.summary} ${evidence.operation}`;
  }
}

/**
 * Scores symbol-name overlap between one evidence item and the prompt focus symbols.
 *
 * @param evidence Tool evidence item being ranked.
 * @param focusSymbols Symbol names the prompt currently prioritizes.
 * @returns Ranking score derived from symbol overlap.
 */
export function scoreSymbolMatch(evidence: ToolEvidence, focusSymbols: readonly string[]): number {
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

/**
 * Marks one file path and its parent directory as invalidated.
 *
 * @param invalidatedFiles File paths already invalidated by newer writes.
 * @param invalidatedDirectories Directory paths invalidated by broader actions.
 * @param targetPath File path to invalidate.
 */
export function markPathInvalidation(
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

/**
 * Normalizes one directory path for prefix comparisons.
 *
 * @param targetPath Directory path to normalize.
 * @returns Path that always ends with the platform separator.
 */
export function normalizeDirectoryPath(targetPath: string): string {
  if (!targetPath) {
    return '';
  }

  return targetPath.endsWith(path.sep) ? targetPath : `${targetPath}${path.sep}`;
}

/**
 * Marks one directory path as invalidated.
 *
 * @param invalidatedDirectories Directory invalidation set.
 * @param targetPath Directory path to invalidate.
 */
export function markDirectoryInvalidation(invalidatedDirectories: Set<string>, targetPath: string): void {
  if (!targetPath) {
    return;
  }

  invalidatedDirectories.add(normalizeDirectoryPath(targetPath));
}

/**
 * Returns true when a project command likely changed workspace state.
 *
 * @param commandLabel Human-readable command label.
 * @param category Command category inferred by command detection.
 * @returns Whether earlier read evidence should be considered stale.
 */
export function isWorkspaceMutatingProjectCommand(commandLabel: string, category: string): boolean {
  if (category === 'build') {
    return true;
  }

  const normalized = commandLabel.toLowerCase();
  return /(?:^|\s)(?:install|add|init|create|generate|codegen|scaffold|migrate|upgrade|update|sync)(?:\s|$)|git\s+(?:pull|checkout|switch|merge|rebase|reset)|(?:eslint|stylelint|ruff).+--fix|prettier.+--write|(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:install|add)(?:\s|$)|(?:^|\s)(?:vite|next|nuxt|astro|webpack|rollup|tsup)\s+build(?:\s|$)/.test(normalized);
}

/**
 * Marks evidence items stale when later writes or mutating commands invalidate them.
 *
 * @param evidence Tool evidence in chronological order.
 * @returns Frozen evidence list with stale flags updated.
 */
export function deriveStaleEvidence(evidence: readonly ToolEvidence[]): readonly ToolEvidence[] {
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

    if (
      item.success &&
      (item.toolName === 'write_file' || item.toolName === 'edit_file' || item.toolName === 'edit_file_range' || item.toolName === 'multi_edit_file_ranges')
    ) {
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

/**
 * Scores one evidence item against candidate and explicitly mentioned paths.
 *
 * @param evidence Tool evidence item being ranked.
 * @param mentionedPaths Paths extracted from the latest user message.
 * @param candidatePaths Aggregated preferred, key, definition, and reference paths.
 * @returns Base ranking score before symbol and read-plan boosts.
 */
export function scoreEvidence(
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

/**
 * Formats one evidence item into a short human-readable bullet.
 *
 * @param evidence Tool evidence item to format.
 * @returns One evidence summary line for prompt context.
 */
export function formatEvidence(evidence: ToolEvidence): string {
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
    case 'edit_file_range':
    case 'multi_edit_file_ranges':
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

/**
 * Builds a lifecycle block describing confirmed, refresh, and pending retrieval work.
 *
 * @param readPlanProgress Read-plan progress items derived from tool evidence.
 * @returns Prompt block describing retrieval lifecycle state.
 */
export function buildRetrievalLifecycleBlock(readPlanProgress: readonly ReadPlanProgressItem[]): string {
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

/**
 * Builds anti-loop guardrails based on repeated reads or writes.
 *
 * @param evidence Tool evidence candidates after stale marking.
 * @param readPlanProgress Current read-plan progress items.
 * @returns Prompt block that discourages low-signal rereads and rewrites.
 */
export function buildAntiLoopGuardrails(
  evidence: readonly ToolEvidence[],
  readPlanProgress: readonly ReadPlanProgressItem[],
): string {
  const recentEvidence = evidence.slice(-18);
  const writeCounts = new Map<string, number>();
  const readCounts = new Map<string, number>();
  const docEditContinuityPaths = new Set<string>();

  recentEvidence.forEach((item) => {
    const targetPath = getEvidenceTargetPath(item);
    if (!targetPath) {
      return;
    }

    if (
      item.success &&
      (item.toolName === 'write_file' || item.toolName === 'edit_file' || item.toolName === 'edit_file_range' || item.toolName === 'multi_edit_file_ranges')
    ) {
      writeCounts.set(targetPath, (writeCounts.get(targetPath) ?? 0) + 1);
      if (isDocumentationPath(targetPath) && (readCounts.get(targetPath) ?? 0) > 0) {
        docEditContinuityPaths.add(targetPath);
      }
      return;
    }

    if (item.toolName === 'read_file' || item.toolName === 'head' || item.toolName === 'tail' || item.toolName === 'read_document' || item.toolName === 'grep') {
      readCounts.set(targetPath, (readCounts.get(targetPath) ?? 0) + 1);
      if (isDocumentationPath(targetPath) && (writeCounts.get(targetPath) ?? 0) > 0) {
        docEditContinuityPaths.add(targetPath);
      }
    }
  });

  const repeatedWrites = [...writeCounts.entries()].filter(([, count]) => count >= 3);
  const repeatedReads = [...readCounts.entries()].filter(([, count]) => count >= 3);
  const refreshSteps = readPlanProgress.filter((item) => item.status === 'needs_refresh');
  const docEditContinuity = [...docEditContinuityPaths];

  if (repeatedWrites.length === 0 && repeatedReads.length === 0 && refreshSteps.length === 0 && docEditContinuity.length === 0) {
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
  if (docEditContinuity.length > 0) {
    lines.push(`For documentation files already read and edited in this turn, batch the remaining edits and avoid rereading the whole file: ${docEditContinuity.join(', ')}`);
  }
  lines.push('Prefer the next pending step or a user-facing summary when the current file has already been inspected and edited multiple times.');
  return lines.join('\n').trim();
}

/**
 * Builds a prompt block that reminds the model to reuse confirmed evidence first.
 *
 * @param readPlanProgress Current read-plan progress items.
 * @returns Prompt block that encourages evidence reuse before rereads.
 */
export function buildEvidenceReuseBlock(readPlanProgress: readonly ReadPlanProgressItem[]): string {
  const confirmed = readPlanProgress.filter((item) => item.status === 'confirmed');
  const refresh = readPlanProgress.filter((item) => item.status === 'needs_refresh');
  const confirmedDocumentationPaths = [...new Set(
    confirmed
      .map((item) => item.targetPath)
      .filter((targetPath) => isDocumentationPath(targetPath)),
  )];
  if (confirmed.length === 0 && refresh.length === 0) {
    return '';
  }

  const lines = ['[REUSE EXISTING EVIDENCE FIRST]'];
  if (confirmed.length > 0) {
    lines.push(`Already confirmed: ${confirmed.map((item) => item.label).join('; ')}`);
    lines.push('Do not reread these files broadly unless the file changed, the evidence became stale, or you need exact lines for an edit.');
  }
  if (refresh.length > 0) {
    lines.push(`Refresh only these steps narrowly: ${refresh.map((item) => item.label).join('; ')}`);
  }
  if (confirmedDocumentationPaths.length > 0) {
    lines.push(`When editing documentation, reuse the confirmed document context first and batch remaining edits on: ${confirmedDocumentationPaths.join(', ')}`);
  }
  lines.push('When reopening analysis, prefer narrow line windows or targeted grep instead of restarting from the top of the file.');
  return lines.join('\n').trim();
}
