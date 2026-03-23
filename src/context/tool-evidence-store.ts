import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ToolCall, ToolResult } from '../tools/file-tools';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';
import { appendTelemetryEvent } from './telemetry';
import type {
  DirectoryEntry,
  FileReadEvidence,
  FileWriteEvidence,
  GalaxyDesignActionEvidence,
  GalaxyDesignKnowledgeEvidence,
  GrepEvidence,
  ListDirEvidence,
  ProjectCommandEvidence,
  ToolEvidence,
  ToolEvidenceBase,
  ToolReportEvidence,
  WebResearchEvidence,
} from './tool-evidence-types';

const MAX_RECENT_EVIDENCE = 80;

function summarizeText(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function getStringParam(call: ToolCall, key: string): string {
  const value = call.params[key];
  return typeof value === 'string' ? value : '';
}

function getMeta(result: ToolResult): Readonly<Record<string, unknown>> {
  return result.meta ?? {};
}

function asDirectoryEntries(value: unknown): readonly DirectoryEntry[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  return Object.freeze(
    value
      .map((item) => {
        if (typeof item !== 'object' || item === null) {
          return null;
        }
        const raw = item as Record<string, unknown>;
        if (
          typeof raw.name !== 'string' ||
          typeof raw.path !== 'string' ||
          (raw.kind !== 'file' && raw.kind !== 'dir')
        ) {
          return null;
        }

        return Object.freeze({
          name: raw.name,
          path: raw.path,
          kind: raw.kind,
        });
      })
      .filter((item): item is DirectoryEntry => item !== null),
  );
}

function asChangedLineRanges(
  value: unknown,
): readonly Readonly<{ startLine: number; endLine: number }>[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  return Object.freeze(
    value
      .map((item) => {
        if (typeof item !== 'object' || item === null) {
          return null;
        }
        const raw = item as Record<string, unknown>;
        if (typeof raw.startLine !== 'number' || typeof raw.endLine !== 'number') {
          return null;
        }
        return Object.freeze({
          startLine: raw.startLine,
          endLine: raw.endLine,
        });
      })
      .filter((item): item is { startLine: number; endLine: number } => item !== null),
  );
}

function buildBase(opts: {
  workspaceId: string;
  turnId: string;
  toolCallId?: string;
  toolName: string;
  success: boolean;
  summary: string;
  tags?: readonly string[];
}): ToolEvidenceBase {
  return Object.freeze({
    evidenceId: randomUUID(),
    workspaceId: opts.workspaceId,
    turnId: opts.turnId,
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    toolName: opts.toolName,
    summary: opts.summary,
    success: opts.success,
    capturedAt: Date.now(),
    stale: false,
    tags: Object.freeze([...(opts.tags ?? [])]),
  });
}

export function createToolEvidence(opts: {
  workspaceId: string;
  turnId: string;
  toolCallId?: string;
  call: ToolCall;
  result: ToolResult;
}): ToolEvidence | null {
  const toolName = opts.call.name;
  const meta = getMeta(opts.result);
  const summary = summarizeText(opts.result.success ? opts.result.content : opts.result.error ?? opts.result.content);
  const base = buildBase({
    workspaceId: opts.workspaceId,
    turnId: opts.turnId,
    toolCallId: opts.toolCallId,
    toolName,
    success: opts.result.success,
    summary,
  });

  if (toolName === 'list_dir') {
    const evidence: ListDirEvidence = Object.freeze({
      ...base,
      toolName: 'list_dir',
      directoryPath:
        typeof meta.directoryPath === 'string' ? meta.directoryPath : getStringParam(opts.call, 'path'),
      entryCount: typeof meta.entryCount === 'number' ? meta.entryCount : 0,
      entries: asDirectoryEntries(meta.entries),
      truncated: Boolean(meta.truncated ?? false),
    });
    return evidence;
  }

  if (toolName === 'grep') {
    const evidence: GrepEvidence = Object.freeze({
      ...base,
      toolName: 'grep',
      targetPath: typeof meta.targetPath === 'string' ? meta.targetPath : getStringParam(opts.call, 'path'),
      pattern: typeof meta.pattern === 'string' ? meta.pattern : getStringParam(opts.call, 'pattern'),
      matches: typeof meta.matches === 'number' ? meta.matches : 0,
      contentPreview: summarizeText(opts.result.content, 500),
      truncated: opts.result.content.length > 500,
    });
    return evidence;
  }

  if (toolName === 'read_file' || toolName === 'head' || toolName === 'tail' || toolName === 'read_document') {
    const evidence: FileReadEvidence = Object.freeze({
      ...base,
      toolName,
      filePath: typeof meta.filePath === 'string' ? meta.filePath : getStringParam(opts.call, 'path'),
      readMode:
        meta.readMode === 'full' ||
        meta.readMode === 'partial' ||
        meta.readMode === 'head' ||
        meta.readMode === 'tail' ||
        meta.readMode === 'document'
          ? meta.readMode
          : toolName === 'read_document'
            ? 'document'
          : toolName === 'head'
            ? 'head'
            : toolName === 'tail'
              ? 'tail'
              : 'partial',
      ...(typeof meta.startLine === 'number' ? { startLine: meta.startLine } : {}),
      ...(typeof meta.endLine === 'number' ? { endLine: meta.endLine } : {}),
      ...(typeof meta.totalLines === 'number' ? { totalLines: meta.totalLines } : {}),
      ...(typeof meta.bytesRead === 'number' ? { bytesRead: meta.bytesRead } : {}),
      ...(typeof opts.call.params.offset === 'number' ? { requestedOffset: opts.call.params.offset } : {}),
      ...(typeof opts.call.params.maxLines === 'number' ? { requestedMaxLines: opts.call.params.maxLines } : {}),
      contentPreview: summarizeText(opts.result.content, 500),
      truncated: Boolean(meta.truncated ?? false),
    });
    return evidence;
  }

  if (
    toolName === 'write_file' ||
    toolName === 'edit_file'
  ) {
    const evidence: FileWriteEvidence = Object.freeze({
      ...base,
      toolName,
      filePath: typeof meta.filePath === 'string' ? meta.filePath : getStringParam(opts.call, 'path'),
      operation:
        meta.operation === 'create' ||
        meta.operation === 'overwrite' ||
        meta.operation === 'edit'
          ? meta.operation
          : toolName === 'write_file'
            ? 'overwrite'
            : 'edit',
      existedBefore: Boolean(meta.existedBefore ?? true),
      changedLineRanges: asChangedLineRanges(meta.changedLineRanges),
      ...(typeof meta.replaceAll === 'boolean' ? { replaceAll: meta.replaceAll } : {}),
      ...(typeof meta.occurrencesChanged === 'number'
        ? { occurrencesChanged: meta.occurrencesChanged }
        : {}),
      ...(typeof meta.recursive === 'boolean' ? { recursive: meta.recursive } : {}),
    });
    return evidence;
  }

  if (toolName === 'validate_code') {
    const evidence: ToolReportEvidence = Object.freeze({
      ...base,
      toolName,
      filePath: typeof meta.filePath === 'string' ? meta.filePath : getStringParam(opts.call, 'path'),
      reportKind: 'validation',
      reportSummary: summary,
      contentPreview: summarizeText(opts.result.content, 500),
      truncated: opts.result.content.length > 500,
    });
    return evidence;
  }

  if (toolName === 'search_web' || toolName === 'extract_web' || toolName === 'map_web' || toolName === 'crawl_web') {
    const urls = Array.isArray(meta.urls)
      ? Object.freeze(meta.urls.filter((item): item is string => typeof item === 'string'))
      : Object.freeze([]);
    const reportKind =
      toolName === 'search_web'
        ? 'web_search'
        : toolName === 'extract_web'
          ? 'web_extract'
          : toolName === 'map_web'
            ? 'web_map'
            : 'web_crawl';
    const evidence: WebResearchEvidence = Object.freeze({
      ...base,
      toolName,
      reportKind,
      ...(typeof meta.query === 'string' && meta.query.trim() ? { query: meta.query } : {}),
      ...(typeof meta.baseUrl === 'string' && meta.baseUrl.trim() ? { baseUrl: meta.baseUrl } : {}),
      urls,
      resultCount: typeof meta.resultCount === 'number' ? meta.resultCount : 0,
      contentPreview: summarizeText(opts.result.content, 500),
      truncated: Boolean(meta.truncated ?? opts.result.content.length > 500),
    });
    return evidence;
  }

  if (toolName === 'run_project_command') {
    const category = meta.category;
    if (
      category !== 'build' &&
      category !== 'test' &&
      category !== 'lint' &&
      category !== 'typecheck' &&
      category !== 'format-check' &&
      category !== 'custom'
    ) {
      return null;
    }

    const evidence: ProjectCommandEvidence = Object.freeze({
      ...base,
      toolName: 'run_project_command',
      commandId:
        typeof meta.commandId === 'string'
          ? meta.commandId
          : getStringParam(opts.call, 'command') || getStringParam(opts.call, 'commandId'),
      commandLabel:
        typeof meta.commandLabel === 'string'
          ? meta.commandLabel
          : getStringParam(opts.call, 'command') || getStringParam(opts.call, 'commandId'),
      category,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
      exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : opts.result.success ? 0 : 1,
      outputPreview: summarizeText(opts.result.content, 500),
      truncated: Boolean(meta.truncated ?? opts.result.content.length > 500),
    });
    return evidence;
  }

  if (toolName === 'galaxy_design_project_info' || toolName === 'galaxy_design_registry') {
    const sampleComponents = Array.isArray(meta.sampleComponents)
      ? Object.freeze(meta.sampleComponents.filter((item): item is string => typeof item === 'string'))
      : Object.freeze([]);
    const evidence: GalaxyDesignKnowledgeEvidence = Object.freeze({
      ...base,
      toolName,
      ...(typeof meta.framework === 'string' ? { framework: meta.framework } : {}),
      ...(typeof meta.packageManager === 'string' ? { packageManager: meta.packageManager } : {}),
      ...(typeof meta.targetPath === 'string' ? { targetPath: meta.targetPath } : {}),
      ...(typeof meta.initialized === 'boolean' ? { initialized: meta.initialized } : {}),
      ...(typeof meta.query === 'string' ? { query: meta.query } : {}),
      ...(typeof meta.component === 'string' ? { component: meta.component } : {}),
      ...(typeof meta.group === 'string' ? { group: meta.group } : {}),
      ...(typeof meta.resultCount === 'number' ? { resultCount: meta.resultCount } : {}),
      sampleComponents,
      truncated: Boolean(meta.truncated ?? false),
    });
    return evidence;
  }

  if (toolName === 'galaxy_design_init' || toolName === 'galaxy_design_add') {
    const components = Array.isArray(meta.components)
      ? Object.freeze(meta.components.filter((item): item is string => typeof item === 'string'))
      : Object.freeze([]);
    const evidence: GalaxyDesignActionEvidence = Object.freeze({
      ...base,
      toolName,
      framework: typeof meta.framework === 'string' ? meta.framework : 'unknown',
      packageManager: typeof meta.packageManager === 'string' ? meta.packageManager : 'unknown',
      runnerPackageManager:
        typeof meta.runnerPackageManager === 'string' ? meta.runnerPackageManager : 'unknown',
      targetPath: typeof meta.targetPath === 'string' ? meta.targetPath : getStringParam(opts.call, 'path'),
      commandPreview: typeof meta.commandPreview === 'string' ? meta.commandPreview : '',
      components,
      exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : opts.result.success ? 0 : 1,
      outputPreview: summarizeText(opts.result.content, 500),
      truncated: Boolean(meta.truncated ?? opts.result.content.length > 500),
    });
    return evidence;
  }

  return null;
}

function parseEvidenceLine(line: string): ToolEvidence | null {
  try {
    return JSON.parse(line) as ToolEvidence;
  } catch {
    return null;
  }
}

export function loadRecentToolEvidence(workspacePath: string): readonly ToolEvidence[] {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.toolEvidencePath)) {
    return Object.freeze([]);
  }

  try {
    const lines = fs.readFileSync(storage.toolEvidencePath, 'utf-8').split(/\r?\n/).filter(Boolean);
    return Object.freeze(
      lines
        .slice(-MAX_RECENT_EVIDENCE)
        .map(parseEvidenceLine)
        .filter((item): item is ToolEvidence => item !== null),
    );
  } catch {
    return Object.freeze([]);
  }
}

export function appendToolEvidence(workspacePath: string, evidence: ToolEvidence): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.appendFileSync(storage.toolEvidencePath, `${JSON.stringify(evidence)}\n`, 'utf-8');
  appendTelemetryEvent(workspacePath, {
    kind: 'tool_evidence',
    toolName: evidence.toolName,
    success: evidence.success,
    ...('filePath' in evidence && typeof evidence.filePath === 'string' ? { targetPath: evidence.filePath } : {}),
    ...('targetPath' in evidence && typeof evidence.targetPath === 'string' ? { targetPath: evidence.targetPath } : {}),
    ...('readMode' in evidence && typeof evidence.readMode === 'string' ? { readMode: evidence.readMode } : {}),
  });
}

export function clearToolEvidence(workspacePath: string): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.toolEvidencePath, '', 'utf-8');
}
