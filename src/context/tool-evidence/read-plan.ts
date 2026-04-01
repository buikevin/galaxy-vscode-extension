/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Read-plan matching and progress helpers for tool-evidence retrieval in the extension runtime.
 */

import type { ReadPlanProgressItem } from '../entities/history';
import type { ManualReadPlanStep } from '../entities/syntax-index';
import type { ToolEvidence } from '../entities/tool-evidence';
import { formatEvidence, getEvidenceSearchText, getEvidenceTargetPath } from './selectors';

/**
 * Returns true when a file-read evidence record covers the requested line.
 *
 * @param evidence Tool evidence item to inspect.
 * @param line Target line number from the read plan.
 * @returns Whether the evidence range covers the requested line with a small buffer.
 */
export function evidenceCoversLine(evidence: ToolEvidence, line: number): boolean {
  if (!('startLine' in evidence) || !('endLine' in evidence)) {
    return false;
  }
  if (typeof evidence.startLine !== 'number' || typeof evidence.endLine !== 'number') {
    return false;
  }
  return line >= evidence.startLine - 12 && line <= evidence.endLine + 12;
}

/**
 * Scores how well one evidence item supports the current manual read plan.
 *
 * @param evidence Tool evidence item being ranked.
 * @param readPlan Manual read-plan steps assembled for the turn.
 * @returns Additional ranking score derived from read-plan alignment.
 */
export function scoreReadPlanMatch(
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

/**
 * Formats one read-plan step into a stable human-readable label.
 *
 * @param step Manual read-plan step to label.
 * @returns Text label used in prompt context blocks.
 */
export function formatReadPlanStepLabel(step: ManualReadPlanStep): string {
  const lineSuffix = typeof step.line === 'number' ? ` around line ${step.line}` : '';
  const symbolSuffix = step.symbolName ? ` [${step.symbolName}]` : '';
  const patternSuffix = step.pattern && step.tool === 'grep' ? ` pattern=${step.pattern}` : '';
  return `${step.tool} ${step.targetPath}${lineSuffix}${symbolSuffix}${patternSuffix}`;
}

/**
 * Returns true when one evidence record satisfies a read-plan step.
 *
 * @param evidence Tool evidence item to test.
 * @param step Read-plan step being evaluated.
 * @returns Whether the evidence satisfies the step with current freshness rules.
 */
export function matchesReadPlanStepEvidence(evidence: ToolEvidence, step: ManualReadPlanStep): boolean {
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

/**
 * Evaluates confirmation and refresh state for the active read plan.
 *
 * @param evidence Tool evidence candidates after stale marking.
 * @param readPlan Manual read-plan steps for the current prompt.
 * @returns Prompt-ready read-plan progress details.
 */
export function evaluateReadPlanProgress(
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
