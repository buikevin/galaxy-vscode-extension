import type { GalaxyConfig } from '../config/types';
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
import type { HistoryManager } from '../context/history-manager';
import type { AgentType, ChatMessage, ToolApprovalDecision } from '../shared/protocol';
import {
  executeToolAsync,
  getEnabledToolDefinitions,
  isToolEnabled,
  normalizeToolName,
  type FileToolContext,
  type ToolCall,
} from '../tools/file-tools';
import { runCodeReviewTool } from './code-reviewer';
import { createDriver } from './driver-factory';
import { captureWorkspaceSnapshot, getSessionFiles, trackWorkspaceChanges } from './session-tracker';
import { buildSystemPrompt } from './system-prompt';
import type { StreamChunk } from './types';

type RunResult = Readonly<{
  assistantText: string;
  assistantThinking: string;
  errorMessage?: string;
  filesWritten: readonly string[];
}>;

function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type PendingActionApproval = Readonly<{
  approvalKey: string;
  toolName: string;
  title: string;
  message: string;
  details: readonly string[];
}>;

function buildApprovalRequest(opts: {
  workspacePath: string;
  config: GalaxyConfig;
  toolName: string;
  params: Record<string, unknown>;
}): PendingActionApproval | null {
  const toolName = normalizeToolName(opts.toolName);

  if (toolName === 'run_project_command') {
    if (!opts.config.toolSafety.requireApprovalForProjectCommand) {
      return null;
    }
    const command = String(opts.params.command ?? opts.params.commandId ?? '').trim();
    const cwd = String(opts.params.cwd ?? '.').trim() || '.';
    if (command) {
      return Object.freeze({
        approvalKey: command,
        toolName,
        title: 'Cấp quyền chạy lệnh',
        message: 'AI Agent muốn chạy một lệnh trong workspace hiện tại.',
        details: Object.freeze([
          `Command: ${command}`,
          `cwd: ${cwd}`,
        ]),
      });
    }
  }

  return null;
}

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
    const workspacePath = opts.historyManager.getSessionMemory().workspacePath;
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
                  ...(toolName === 'run_project_command' ? { toolCallId: toolCall.id } : {}),
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
          ['write_file', 'edit_file'].includes(toolName) ||
          ['galaxy_design_init', 'galaxy_design_add'].includes(toolName)
        )
      ) {
        filesWritten.add(touchedPath);
      }
      if (result.success && workspaceSnapshotBefore) {
        for (const changedPath of trackWorkspaceChanges(workspacePath, workspaceSnapshotBefore)) {
          filesWritten.add(changedPath);
        }
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
