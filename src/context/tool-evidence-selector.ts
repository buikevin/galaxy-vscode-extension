import path from 'node:path';
import { estimateTokens } from './compaction';
import type { SessionMemory, WorkingTurn } from './history-types';
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

function markPathInvalidation(
  invalidatedFiles: Set<string>,
  invalidatedDirectories: Set<string>,
  targetPath: string,
): void {
  if (!targetPath) {
    return;
  }

  invalidatedFiles.add(targetPath);
  invalidatedDirectories.add(`${path.dirname(targetPath)}${path.sep}`);
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

export function buildRelevantToolEvidenceBlock(opts: {
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
}): Readonly<{
  content: string;
  tokens: number;
  entryCount: number;
}> {
  const evidence = loadRecentToolEvidence(opts.sessionMemory.workspacePath);
  const freshenedEvidence = deriveStaleEvidence(evidence);
  if (freshenedEvidence.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
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
    [...new Set([...mentionedPaths, ...opts.sessionMemory.keyFiles, ...workingTurnPaths])],
  );

  const selected = [...freshenedEvidence]
    .map((item) => ({ item, score: scoreEvidence(item, mentionedPaths, candidatePaths) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.capturedAt - a.item.capturedAt)
    .slice(0, 8)
    .map((entry) => entry.item);

  if (selected.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
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
  });
}
