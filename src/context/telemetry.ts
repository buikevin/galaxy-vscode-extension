/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Persists telemetry events and maintains a rolling summary for retrieval diagnostics.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';
import type { TelemetryEvent, TelemetryEventInput, TelemetrySummary } from './entities/telemetry';

const EMPTY_SUMMARY: TelemetrySummary = Object.freeze({
  totalEvents: 0,
  promptBuilds: 0,
  avgPromptTokensEstimate: 0,
  maxPromptTokensEstimate: 0,
  compactedTurns: 0,
  readEvidenceEvents: 0,
  fullFileReads: 0,
  rereads: 0,
  grepEvents: 0,
  multiAgentPlans: 0,
  multiAgentSuccesses: 0,
  subAgentTurns: 0,
  userReverts: 0,
  capabilitySnapshots: 0,
  validationSelections: 0,
  blockedToolCalls: 0,
  workflowQueries: 0,
  workflowHits: 0,
  workflowGuardActivations: 0,
  lastUpdatedAt: 0,
  readCountsByPath: Object.freeze({}),
});

/**
 * Loads the persisted telemetry summary or falls back to an empty one.
 */
function loadSummary(summaryPath: string): TelemetrySummary {
  try {
    if (!fs.existsSync(summaryPath)) {
      return EMPTY_SUMMARY;
    }
    return {
      ...EMPTY_SUMMARY,
      ...(JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as Partial<TelemetrySummary>),
    };
  } catch {
    return EMPTY_SUMMARY;
  }
}

export function loadTelemetrySummary(workspacePath: string): TelemetrySummary {
  const info = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(info);
  return loadSummary(info.telemetrySummaryPath);
}

export function formatTelemetrySummary(summary: TelemetrySummary): string {
  const topReadPaths = Object.entries(summary.readCountsByPath)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([filePath, count]) => `- ${filePath}: ${count}`)
    .join('\n');

  return [
    '[TELEMETRY SUMMARY]',
    `Total events: ${summary.totalEvents}`,
    `Prompt builds: ${summary.promptBuilds}`,
    `Avg prompt tokens: ${summary.avgPromptTokensEstimate}`,
    `Max prompt tokens: ${summary.maxPromptTokensEstimate}`,
    `Compacted turns: ${summary.compactedTurns}`,
    `Read evidence events: ${summary.readEvidenceEvents}`,
    `Full file reads: ${summary.fullFileReads}`,
    `Rereads: ${summary.rereads}`,
    `Grep events: ${summary.grepEvents}`,
    `Multi-agent plans: ${summary.multiAgentPlans}`,
    `Multi-agent successes: ${summary.multiAgentSuccesses}`,
    `Sub-agent turns: ${summary.subAgentTurns}`,
    `User reverts: ${summary.userReverts}`,
    `Capability snapshots: ${summary.capabilitySnapshots}`,
    `Validation selections: ${summary.validationSelections}`,
    `Blocked tool calls: ${summary.blockedToolCalls}`,
    `Workflow queries: ${summary.workflowQueries}`,
    `Workflow hits: ${summary.workflowHits}`,
    `Workflow guard activations: ${summary.workflowGuardActivations}`,
    summary.lastUpdatedAt > 0 ? `Last updated: ${new Date(summary.lastUpdatedAt).toISOString()}` : 'Last updated: n/a',
    topReadPaths ? `Top reread paths:\n${topReadPaths}` : 'Top reread paths:\n- none',
  ].join('\n');
}

function updateSummary(summary: TelemetrySummary, event: TelemetryEvent): TelemetrySummary {
  const nextReadCounts = { ...summary.readCountsByPath };
  let readEvidenceEvents = summary.readEvidenceEvents;
  let fullFileReads = summary.fullFileReads;
  let rereads = summary.rereads;
  let grepEvents = summary.grepEvents;

  if (event.kind === 'tool_evidence') {
    if (event.toolName === 'read_file' || event.toolName === 'head' || event.toolName === 'tail' || event.toolName === 'read_document') {
      readEvidenceEvents += 1;
      if (event.readMode === 'full' || event.readMode === 'document') {
        fullFileReads += 1;
      }
      if (event.targetPath) {
        const previous = nextReadCounts[event.targetPath] ?? 0;
        nextReadCounts[event.targetPath] = previous + 1;
        if (previous >= 1) {
          rereads += 1;
        }
      }
    }
    if (event.toolName === 'grep') {
      grepEvents += 1;
    }
  }

  const promptBuilds = summary.promptBuilds + (event.kind === 'prompt_build' ? 1 : 0);
  const totalPromptTokens =
    summary.avgPromptTokensEstimate * summary.promptBuilds +
    (event.kind === 'prompt_build' ? event.promptTokensEstimate : 0);
  const avgPromptTokensEstimate = promptBuilds > 0 ? Math.round(totalPromptTokens / promptBuilds) : 0;

  return Object.freeze({
    totalEvents: summary.totalEvents + 1,
    promptBuilds,
    avgPromptTokensEstimate,
    maxPromptTokensEstimate:
      event.kind === 'prompt_build'
        ? Math.max(summary.maxPromptTokensEstimate, event.promptTokensEstimate)
        : summary.maxPromptTokensEstimate,
    compactedTurns: summary.compactedTurns + (event.kind === 'working_turn_compacted' ? 1 : 0),
    readEvidenceEvents,
    fullFileReads,
    rereads,
    grepEvents,
    multiAgentPlans: summary.multiAgentPlans + (event.kind === 'multi_agent_plan' ? 1 : 0),
    multiAgentSuccesses:
      summary.multiAgentSuccesses + (event.kind === 'multi_agent_plan' && event.completed ? 1 : 0),
    subAgentTurns: summary.subAgentTurns + (event.kind === 'sub_agent_turn' ? 1 : 0),
    userReverts: summary.userReverts + (event.kind === 'user_revert' ? event.fileCount : 0),
    capabilitySnapshots: summary.capabilitySnapshots + (event.kind === 'capability_snapshot' ? 1 : 0),
    validationSelections: summary.validationSelections + (event.kind === 'validation_selection' ? 1 : 0),
    blockedToolCalls: summary.blockedToolCalls + (event.kind === 'blocked_tool' ? 1 : 0),
    workflowQueries: summary.workflowQueries + (event.kind === 'workflow_retrieval' && event.flowQuery ? 1 : 0),
    workflowHits: summary.workflowHits + (event.kind === 'workflow_retrieval' && event.hadHits ? 1 : 0),
    workflowGuardActivations:
      summary.workflowGuardActivations + (event.kind === 'workflow_retrieval' && event.rereadGuardEnabled ? 1 : 0),
    lastUpdatedAt: event.capturedAt,
    readCountsByPath: Object.freeze(nextReadCounts),
  });
}

export function appendTelemetryEvent(
  workspacePath: string,
  event: TelemetryEventInput,
): void {
  try {
    const info = getProjectStorageInfo(workspacePath);
    ensureProjectStorage(info);
    const fullEvent: TelemetryEvent = Object.freeze({
      id: randomUUID(),
      capturedAt: Date.now(),
      ...event,
    } as TelemetryEvent);
    fs.appendFileSync(info.telemetryPath, `${JSON.stringify(fullEvent)}\n`, 'utf-8');
    const nextSummary = updateSummary(loadSummary(info.telemetrySummaryPath), fullEvent);
    fs.writeFileSync(info.telemetrySummaryPath, JSON.stringify(nextSummary, null, 2), 'utf-8');
  } catch {
    // ignore telemetry failures
  }
}
