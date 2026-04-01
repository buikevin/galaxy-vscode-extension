/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Orchestrate one extension chat turn, including prompt building, tool execution, approvals, review, and session tracking.
 */

import type { GalaxyConfig } from '../shared/config';
import {
  askActionApproval,
  buildPermissionContextBlock,
  denyActionApproval,
  getCommandPermission,
  grantActionApproval,
} from '../context/action-approval-store';
import { computeWorkingContextBudget, estimateTokens } from '../context/compaction';
import { buildPromptContext } from '../context/prompt-builder';
import { appendTelemetryEvent } from '../context/telemetry';
import type { HistoryManager } from '../context/entities/history-manager';
import { scheduleWorkflowGraphRefresh } from '../context/workflow/extractor/runtime';
import { evaluateWorkflowRereadGuard } from '../context/workflow/reread-guard';
import type { AgentType, ChatMessage, ToolApprovalDecision } from '../shared/protocol';
import type { PendingActionApproval, RunResult } from '../shared/runtime';
import {
  executeToolAsync,
} from '../tools/file/dispatch';
import { getEnabledToolDefinitions, isToolEnabled } from '../tools/file/definitions';
import { normalizeToolName } from '../tools/file/tooling';
import type { FileToolContext, ToolCall } from '../tools/entities/file-tools';
import { runCodeReviewTool } from './code-reviewer';
import { buildApprovalRequest, getBlockedCapability } from './chat-approvals';
import { createDriver } from './driver-factory';
import { captureWorkspaceSnapshot, getSessionFiles, trackWorkspaceChanges } from './session-tracker';
import { buildSystemPrompt } from './system-prompt';
import type { StreamChunk } from '../shared/runtime';

/**
 * Creates a stable-ish message id for transcript entries generated during one run.
 *
 * @returns Message id string.
 */
function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs one full extension chat turn, including prompt assembly, tool loops, approvals, validation handoff, and telemetry.
 *
 * @param opts Turn runtime dependencies and UI callbacks.
 * @returns Final accumulated assistant output and file-write summary for the turn.
 */
export async function runExtensionChat(opts: {
  config: GalaxyConfig;
  agentType: AgentType;
  historyManager: HistoryManager;
  toolContext: FileToolContext;
  onChunk: (chunk: StreamChunk) => Promise<void> | void;
  onMessage: (message: ChatMessage) => Promise<void> | void;
  onToolCalls?: (toolCalls: readonly Readonly<{ id: string; name: string; params: Record<string, unknown> }>[]) => Promise<void> | void;
  onStatus?: (statusText: string) => Promise<void> | void;
  onEvidenceContext?: (payload: {
    content: string;
    tokens: number;
    entryCount: number;
    finalPromptTokens?: number;
    focusSymbols?: readonly string[];
    manualPlanningContent?: string;
    manualReadBatchItems?: readonly string[];
    readPlanProgressItems?: readonly Readonly<{
      label: string;
      confirmed: boolean;
      evidenceSummary?: string;
      targetPath: string;
      symbolName?: string;
      tool: 'read_file' | 'grep';
    }>[];
    confirmedReadCount?: number;
  }) => Promise<void> | void;
  requestToolApproval: (approval: PendingActionApproval) => Promise<ToolApprovalDecision>;
}): Promise<RunResult> {
  const driver = createDriver(opts.config, opts.agentType, true);
  const workspacePath = opts.historyManager.getSessionMemory().workspacePath;
  appendTelemetryEvent(workspacePath, {
    kind: 'capability_snapshot',
    source: 'chat_turn',
    agentType: opts.agentType,
    enabledCapabilities: Object.freeze(
      Object.entries(opts.config.toolCapabilities)
        .filter(([, enabled]) => enabled)
        .map(([capability]) => capability)
        .sort(),
    ),
  });
  const filesWritten = new Set<string>();
  const maxToolRounds =
    typeof opts.config.maxToolRounds === 'number' && Number.isFinite(opts.config.maxToolRounds)
      ? Math.max(1, Math.floor(opts.config.maxToolRounds))
      : null;
  const systemPromptTokens = estimateTokens(
    buildSystemPrompt(opts.agentType, opts.config),
  );
  const toolSchemaTokens = estimateTokens(
    JSON.stringify(getEnabledToolDefinitions(opts.config)),
  );

  for (let round = 0; maxToolRounds === null || round < maxToolRounds; round += 1) {
    const buildRoundPrompt = async () => {
      const promptBuild = await buildPromptContext({
        agentType: opts.agentType,
        notes: opts.historyManager.getNotes(),
        sessionMemory: opts.historyManager.getSessionMemory(),
        workingTurn: opts.historyManager.getWorkingTurn(),
      });
      const permissionsBlock = buildPermissionContextBlock(workspacePath);
      const permissionTokens = permissionsBlock ? estimateTokens(permissionsBlock) : 0;
      const promptTokensEstimate =
        promptBuild.finalPromptTokens +
        systemPromptTokens +
        toolSchemaTokens +
        permissionTokens;
      return {
        promptBuild,
        permissionsBlock,
        promptTokensEstimate,
      };
    };

    let roundPrompt = await buildRoundPrompt();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const workingTurnBudget = computeWorkingContextBudget({
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
        workingTurnTokens: roundPrompt.promptBuild.workingTurnTokens,
      });
      const compacted = opts.historyManager.compactWorkingTurn({
        workingTurnBudget,
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
      });
      if (!compacted) {
        break;
      }
      appendTelemetryEvent(workspacePath, {
        kind: 'working_turn_compacted',
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
        workingTurnBudget,
        workingTurnTokens: roundPrompt.promptBuild.workingTurnTokens,
      });
      roundPrompt = await buildRoundPrompt();
    }

    const { promptBuild, permissionsBlock, promptTokensEstimate } = roundPrompt;
    await opts.onEvidenceContext?.({
      content: promptBuild.evidenceContent,
      tokens: promptBuild.evidenceTokens,
      entryCount: promptBuild.evidenceEntryCount,
      finalPromptTokens: promptTokensEstimate,
      focusSymbols: promptBuild.focusSymbols,
      manualPlanningContent: promptBuild.manualPlanningContent,
      manualReadBatchItems: promptBuild.manualReadBatchItems,
      readPlanProgressItems: promptBuild.readPlanProgressItems,
      confirmedReadCount: promptBuild.confirmedReadCount,
    });
    const messages = permissionsBlock
      ? Object.freeze([
          ...promptBuild.messages,
          Object.freeze({
            id: `ctx-command-permissions-${Date.now()}`,
            role: 'user' as const,
            content: permissionsBlock,
            timestamp: Date.now(),
          }),
        ])
      : promptBuild.messages;

    let roundText = '';
    let roundThinking = '';
    let errorMessage = '';
    const pendingToolCalls: ToolCall[] = [];

    await driver.chat(messages, async (chunk) => {
      if (chunk.type === 'text') {
        roundText += chunk.delta;
        await opts.onChunk(chunk);
        return;
      }

      if (chunk.type === 'thinking') {
        roundThinking += chunk.delta;
        await opts.onChunk(chunk);
        return;
      }

      if (chunk.type === 'tool_call') {
        pendingToolCalls.push(chunk.call);
        await opts.onStatus?.(`Tool: ${normalizeToolName(chunk.call.name)}`);
        return;
      }

      if (chunk.type === 'error') {
        errorMessage = chunk.message;
        await opts.onChunk(chunk);
      }
    });

    if (errorMessage) {
      return Object.freeze({
        assistantText: roundText,
        assistantThinking: roundThinking,
        errorMessage,
        filesWritten: Object.freeze([...filesWritten]),
      });
    }

    if (roundText.trim()) {
      opts.historyManager.appendAssistantDraft(roundText);
    }

    if (pendingToolCalls.length === 0) {
      return Object.freeze({
        assistantText: roundText,
        assistantThinking: roundThinking,
        filesWritten: Object.freeze([...filesWritten]),
      });
    }

    const assistantToolCalls = pendingToolCalls.map((call) => Object.freeze({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: normalizeToolName(call.name),
      params: call.params,
    }));

    const assistantContextMessage: ChatMessage = Object.freeze({
      id: createMessageId(),
      role: 'assistant',
      content: roundText,
      agentType: opts.agentType,
      ...(roundThinking.trim() ? { thinking: roundThinking } : {}),
      toolCalls: Object.freeze(assistantToolCalls),
      timestamp: Date.now(),
    });
    opts.historyManager.appendContextMessage(assistantContextMessage);
    await opts.onToolCalls?.(assistantToolCalls);

    if (roundText.trim() || roundThinking.trim()) {
      await opts.onMessage(assistantContextMessage);
    }

    for (let index = 0; index < pendingToolCalls.length; index += 1) {
      const call = pendingToolCalls[index]!;
      const toolCall = assistantToolCalls[index]!;
      const toolName = normalizeToolName(call.name);

      if (!isToolEnabled(toolName, opts.config)) {
        appendTelemetryEvent(workspacePath, {
          kind: 'blocked_tool',
          toolName,
          capability: getBlockedCapability(toolName),
        });
        const disabledToolMessage: ChatMessage = Object.freeze({
          id: createMessageId(),
          role: 'tool',
          content: `Error: ${toolName} is disabled in config.`,
          timestamp: Date.now(),
          toolName,
          toolParams: Object.freeze(call.params),
          toolSuccess: false,
          toolCallId: toolCall.id,
        });
        opts.historyManager.appendToolMessage(disabledToolMessage);
        await opts.onMessage(disabledToolMessage);
        continue;
      }

      const approvalRequest = buildApprovalRequest({
        workspacePath,
        config: opts.config,
        toolName,
        params: call.params,
      });
      if (toolName === 'run_project_command' && approvalRequest) {
        const permission = getCommandPermission(workspacePath, approvalRequest.approvalKey);
        if (permission === 'deny') {
          const deniedToolMessage: ChatMessage = Object.freeze({
            id: createMessageId(),
            role: 'tool',
            content: `Permission denied by user for command: ${approvalRequest.approvalKey}`,
            timestamp: Date.now(),
            toolName,
            toolParams: Object.freeze(call.params),
            toolSuccess: false,
            toolCallId: toolCall.id,
          });
          opts.historyManager.appendToolMessage(deniedToolMessage);
          await opts.onMessage(deniedToolMessage);
          continue;
        }

        if (permission !== 'allow') {
          const decision = await opts.requestToolApproval(approvalRequest);
          if (decision === 'allow') {
            grantActionApproval(workspacePath, approvalRequest.approvalKey, toolName);
          } else if (decision === 'ask') {
            askActionApproval(workspacePath, approvalRequest.approvalKey);
          } else if (decision === 'deny') {
            denyActionApproval(workspacePath, approvalRequest.approvalKey);
            const deniedToolMessage: ChatMessage = Object.freeze({
              id: createMessageId(),
              role: 'tool',
              content: `Permission denied by user for command: ${approvalRequest.approvalKey}`,
              timestamp: Date.now(),
              toolName,
              toolParams: Object.freeze(call.params),
              toolSuccess: false,
              toolCallId: toolCall.id,
            });
            opts.historyManager.appendToolMessage(deniedToolMessage);
            await opts.onMessage(deniedToolMessage);
            continue;
          }
        }
      } else if (approvalRequest) {
        const decision = await opts.requestToolApproval(approvalRequest);
        if (decision === 'deny') {
          const deniedToolMessage: ChatMessage = Object.freeze({
            id: createMessageId(),
            role: 'tool',
          content: `Permission denied by user for ${toolName}.`,
            timestamp: Date.now(),
            toolName,
            toolParams: Object.freeze(call.params),
            toolSuccess: false,
            toolCallId: toolCall.id,
          });
          opts.historyManager.appendToolMessage(deniedToolMessage);
          await opts.onMessage(deniedToolMessage);
          continue;
        }
      }

      const workflowGuardDecision = evaluateWorkflowRereadGuard({
        workspacePath,
        toolName,
        params: call.params,
        guard: promptBuild.workflowRereadGuard,
      });
      if (workflowGuardDecision.blocked) {
        const blockedToolMessage: ChatMessage = Object.freeze({
          id: createMessageId(),
          role: 'tool',
          content: `Error: ${workflowGuardDecision.reason}`,
          timestamp: Date.now(),
          toolName,
          toolParams: Object.freeze(call.params),
          toolSuccess: false,
          toolCallId: toolCall.id,
          toolMeta: Object.freeze({
            blockedBy: 'workflow_reread_guard',
            relativePath: workflowGuardDecision.relativePath ?? '',
          }),
        });
        opts.historyManager.appendToolMessage(blockedToolMessage);
        await opts.onMessage(blockedToolMessage);
        continue;
      }

      await opts.onStatus?.(`Executing: ${toolName}`);
      const shouldTrackWorkspaceChanges = [
        'run_project_command',
        'galaxy_design_init',
        'galaxy_design_add',
      ].includes(toolName);
      const workspaceSnapshotBefore = shouldTrackWorkspaceChanges
        ? captureWorkspaceSnapshot(workspacePath)
        : null;
      const result =
        toolName === 'request_code_review'
          ? await runCodeReviewTool({
              sessionFiles: getSessionFiles(),
              config: opts.config,
              agentType: opts.agentType,
            })
          : await executeToolAsync(
              Object.freeze({
                ...call,
                params: Object.freeze({
                  ...call.params,
                  ...(toolName === 'run_project_command' || toolName === 'run_terminal_command' ? { toolCallId: toolCall.id } : {}),
                }),
              }),
              opts.toolContext,
            );
      opts.historyManager.appendToolEvidence({
        call: Object.freeze({
          name: toolName,
          params: call.params,
        }),
        result,
        toolCallId: toolCall.id,
      });
      const touchedPath =
        typeof result.meta?.filePath === 'string'
          ? result.meta.filePath
          : typeof result.meta?.targetPath === 'string'
            ? result.meta.targetPath
            : null;
      if (
        result.success &&
        touchedPath &&
        (
          ['write_file', 'insert_file_at_line', 'edit_file', 'edit_file_range', 'multi_edit_file_ranges'].includes(toolName) ||
          ['galaxy_design_init', 'galaxy_design_add'].includes(toolName)
        )
      ) {
        filesWritten.add(touchedPath);
      }
      const workflowRefreshPaths = new Set<string>();
      if (
        result.success &&
        touchedPath &&
        (
          ['write_file', 'insert_file_at_line', 'edit_file', 'edit_file_range', 'multi_edit_file_ranges', 'revert_file'].includes(toolName) ||
          ['galaxy_design_init', 'galaxy_design_add'].includes(toolName)
        )
      ) {
        workflowRefreshPaths.add(touchedPath);
      }
      if (result.success && workspaceSnapshotBefore) {
        for (const changedPath of trackWorkspaceChanges(workspacePath, workspaceSnapshotBefore)) {
          filesWritten.add(changedPath);
          workflowRefreshPaths.add(changedPath);
        }
      }
      if (result.success && workflowRefreshPaths.size > 0) {
        scheduleWorkflowGraphRefresh(workspacePath, {
          reason: `tool:${toolName}`,
          filePaths: [...workflowRefreshPaths],
        });
      }
      const toolMessage: ChatMessage = Object.freeze({
        id: createMessageId(),
        role: 'tool',
        content: result.success
          ? result.content || '(no output)'
          : `Error: ${result.error ?? (result.content || 'Unknown error')}`,
        timestamp: Date.now(),
        toolName,
        toolParams: Object.freeze(call.params),
        ...(result.meta ? { toolMeta: result.meta } : {}),
        toolSuccess: result.success,
        toolCallId: toolCall.id,
      });

      opts.historyManager.appendToolMessage(toolMessage);
      await opts.onMessage(toolMessage);
    }

    opts.historyManager.incrementRound();
  }

  return Object.freeze({
    assistantText: '',
    assistantThinking: '',
    errorMessage: `Agent exceeded the configured maximum tool rounds (${maxToolRounds ?? 'unlimited'}).`,
    filesWritten: Object.freeze([...filesWritten]),
  });
}
