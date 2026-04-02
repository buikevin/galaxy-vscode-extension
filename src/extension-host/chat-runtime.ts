/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Selective multi-agent orchestration and repair-turn runtime helpers extracted from the extension host entrypoint.
 */

import { appendTelemetryEvent } from "../context/telemetry";
import {
  buildCoderSubAgentConfig,
  buildSelectiveMultiAgentPlanMessage,
  buildSelectiveMultiAgentSubtaskMessage,
  maybeBuildSelectiveMultiAgentPlan,
} from "../runtime/selective-multi-agent";
import { runExtensionChat } from "../runtime/run-chat";
import { MAX_EMPTY_CONTINUE_ATTEMPTS } from "../shared/constants";
import type { ChatMessage } from "../shared/protocol";
import type {
  ChatRuntimeCallbacks,
  MainChatTurnOutcomeRequest,
  MainChatTurnOutcomeResult,
  MainChatTurnRequest,
  MainChatTurnResult,
  RepairTurnRequest,
  RepairTurnResult,
  SelectiveMultiAgentPlanRequest,
  SelectiveMultiAgentPlanResult,
} from "../shared/chat-runtime";
import { createAssistantMessage, createMessageId } from "./utils";

/** Runs the selective multi-agent planner and executes scoped repair turns when a plan is produced. */
export async function runSelectiveMultiAgentPlan(
  callbacks: ChatRuntimeCallbacks,
  opts: SelectiveMultiAgentPlanRequest,
): Promise<SelectiveMultiAgentPlanResult> {
  const plan = maybeBuildSelectiveMultiAgentPlan(
    opts.agentType,
    opts.originalUserMessage.content,
  );
  if (!plan) {
    return Object.freeze({
      handled: false,
      hadError: false,
      filesWritten: Object.freeze([]),
    });
  }

  await callbacks.addMessage({
    ...createAssistantMessage(buildSelectiveMultiAgentPlanMessage(plan)),
    agentType: opts.agentType,
  });
  callbacks.appendLog(
    "info",
    `Selective multi-agent plan activated: ${plan.subtasks.map((subtask) => subtask.id).join(", ")}.`,
  );

  const coderConfig = buildCoderSubAgentConfig(opts.config);
  const written = new Set<string>();
  let hadError = false;
  const hasDesignContext =
    Boolean(opts.originalUserMessage.images?.length) ||
    Boolean(opts.originalUserMessage.figmaAttachments?.length) ||
    Boolean(
      opts.originalUserMessage.attachments?.some(
        (attachment) =>
          attachment.kind === "figma" || attachment.kind === "image",
      ),
    );

  for (let index = 0; index < plan.subtasks.length; index += 1) {
    const subtask = plan.subtasks[index]!;
    const subtaskLabel = `Sub-agent ${index + 1}/${plan.subtasks.length}: ${subtask.title}`;
    callbacks.setStatusText(subtaskLabel);
    callbacks.appendLog("status", subtaskLabel);
    callbacks.reportProgress(subtaskLabel);
    await callbacks.postRunState();

    const result = await runInternalRepairTurn(callbacks, {
      config: coderConfig,
      agentType: opts.agentType,
      userMessage: buildSelectiveMultiAgentSubtaskMessage({
        originalUserMessage: opts.originalUserMessage,
        subtask,
      }),
      ...(opts.contextNote &&
      (index === 0 ||
        (hasDesignContext &&
          (subtask.id === "frontend" || subtask.id === "integration")))
        ? { contextNote: opts.contextNote }
        : {}),
    });

    for (const filePath of result.filesWritten) {
      written.add(filePath);
    }
    appendTelemetryEvent(callbacks.workspacePath, {
      kind: "sub_agent_turn",
      scope: subtask.id,
      filesWritten: result.filesWritten.length,
      hadError: result.hadError,
    });

    if (result.hadError) {
      hadError = true;
      break;
    }
  }

  appendTelemetryEvent(callbacks.workspacePath, {
    kind: "multi_agent_plan",
    subtaskCount: plan.subtasks.length,
    scopes: plan.subtasks.map((subtask) => subtask.id),
    completed: !hadError,
    filesWritten: written.size,
  });

  return Object.freeze({
    handled: true,
    hadError,
    filesWritten: Object.freeze([...written]),
  });
}

/** Runs one normal chat turn and returns the raw runtime result for provider-side post-processing. */
export async function runMainChatTurn(
  callbacks: ChatRuntimeCallbacks,
  opts: MainChatTurnRequest,
): Promise<MainChatTurnResult> {
  let hadError = false;
  let thinkingLogged = false;
  callbacks.historyManager.startTurn(opts.userMessage, opts.contextNote);

  const result = await runExtensionChat({
    config: opts.config,
    agentType: opts.agentType,
    historyManager: callbacks.historyManager,
    toolContext: callbacks.buildToolContext(opts.config),
    onChunk: async (chunk) => {
      if (chunk.type === "thinking" && !thinkingLogged && chunk.delta.trim()) {
        thinkingLogged = true;
        callbacks.appendLog(
          "status",
          `Received thinking stream from ${opts.agentType}.`,
        );
      }
      await callbacks.onChunk(chunk, opts.agentType);
      if (chunk.type === "error") {
        hadError = true;
      }
    },
    onMessage: async (chatMessage) => {
      await callbacks.onMessage(chatMessage);
    },
    onToolCalls: async (toolCalls) => {
      await callbacks.onToolCalls("turn", toolCalls);
    },
    onStatus: async (statusText) => {
      callbacks.setStatusText(statusText);
      callbacks.appendLog("status", statusText);
      callbacks.reportProgress(statusText);
      await callbacks.postRunState();
    },
    onEvidenceContext: async (payload) => {
      await callbacks.onEvidenceContext("turn", payload);
    },
    requestToolApproval: async (approval) =>
      callbacks.requestToolApproval(approval),
  });

  return Object.freeze({
    hadError,
    result,
  });
}

/** Post-processes a main chat turn result, including quality gates and auto-continue handling. */
export async function handleMainChatTurnResult(
  callbacks: ChatRuntimeCallbacks,
  opts: MainChatTurnOutcomeRequest,
): Promise<MainChatTurnOutcomeResult> {
  let hadError = opts.hadError;

  if (opts.result.errorMessage && !hadError) {
    hadError = true;
    callbacks.historyManager.clearCurrentTurn();
    callbacks.writeDebug(
      "turn-result",
      `agent=${opts.agentType} error text_len=${opts.result.assistantText.length} thinking_len=${opts.result.assistantThinking.length} files_written=${opts.result.filesWritten.length}`,
    );
    if (opts.result.assistantThinking.trim()) {
      callbacks.writeDebugBlock(
        "turn-error-thinking",
        opts.result.assistantThinking,
      );
    }
    if (opts.result.assistantText.trim()) {
      callbacks.writeDebugBlock(
        "turn-error-content",
        opts.result.assistantText,
      );
    }
    await callbacks.postErrorMessage(opts.result.errorMessage);
    callbacks.showWorkbenchError(opts.result.errorMessage);
  } else if (opts.result.assistantText.trim()) {
    callbacks.writeDebug(
      "turn-result",
      `agent=${opts.agentType} success text_len=${opts.result.assistantText.length} thinking_len=${opts.result.assistantThinking.length} files_written=${opts.result.filesWritten.length}`,
    );
    callbacks.writeDebugBlock("turn-final-content", opts.result.assistantText);
    if (opts.result.assistantThinking.trim()) {
      callbacks.writeDebugBlock(
        "turn-final-thinking",
        opts.result.assistantThinking,
      );
    }
    if (!opts.result.assistantThinking.trim()) {
      callbacks.appendLog(
        "status",
        `No thinking stream was returned by ${opts.agentType} for this turn.`,
      );
    }
    const gateFinalConclusion = callbacks.shouldGateAssistantFinalMessage(
      opts.result.filesWritten,
    );
    callbacks.historyManager.finalizeTurn({
      assistantText: opts.result.assistantText,
      commitConclusion: !gateFinalConclusion,
    });
    let publishAssistantMessage = true;
    if (gateFinalConclusion) {
      if (callbacks.hasStreamingBuffers()) {
        callbacks.clearStreamingBuffers();
        await callbacks.postInit();
      }
      const qualityOutcome = await callbacks.runValidationAndReviewFlow(
        opts.agentType,
      );
      publishAssistantMessage =
        qualityOutcome.passed && !qualityOutcome.repaired;
    } else if (opts.result.filesWritten.length > 0) {
      await callbacks.runValidationAndReviewFlow(opts.agentType);
    }
    if (publishAssistantMessage) {
      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: opts.result.assistantText,
        ...(opts.result.assistantThinking.trim()
          ? { thinking: opts.result.assistantThinking }
          : {}),
        timestamp: Date.now(),
      };
      await callbacks.addMessage(assistantMessage);
    }
  } else if (!hadError) {
    callbacks.writeDebug(
      "turn-result",
      `agent=${opts.agentType} empty text_len=${opts.result.assistantText.length} thinking_len=${opts.result.assistantThinking.length} files_written=${opts.result.filesWritten.length}`,
    );
    if (opts.result.assistantThinking.trim()) {
      callbacks.writeDebugBlock(
        "turn-empty-thinking",
        opts.result.assistantThinking,
      );
    }
    const previousTurn = callbacks.historyManager.getWorkingTurn();
    callbacks.historyManager.clearCurrentTurn();
    const nextAttempt = 1;
    callbacks.appendLog(
      "status",
      `Empty assistant result detected. Auto-continuing (${nextAttempt}/${MAX_EMPTY_CONTINUE_ATTEMPTS})...`,
    );
    callbacks.writeDebug(
      "turn-empty-continue",
      `agent=${opts.agentType} attempt=${nextAttempt}`,
    );
    const continueResult = await runInternalRepairTurn(callbacks, {
      config: callbacks.getEffectiveConfig(),
      agentType: opts.agentType,
      userMessage: callbacks.buildContinueMessage({
        attempt: nextAttempt,
        lastUserGoal: previousTurn?.userMessage.content,
        lastThinking: opts.result.assistantThinking,
        filesWritten: opts.result.filesWritten,
        recentToolSummaries:
          previousTurn?.toolDigests.map((digest) => digest.summary) ?? [],
      }),
    });
    hadError = continueResult.hadError;
    if (!hadError && continueResult.filesWritten.length > 0) {
      await callbacks.runValidationAndReviewFlow(opts.agentType);
    }
  }

  return Object.freeze({
    hadError,
  });
}

/** Runs one internal repair turn with retry, evidence logging, and gated final-message behavior. */
export async function runInternalRepairTurn(
  callbacks: ChatRuntimeCallbacks,
  opts: RepairTurnRequest,
): Promise<RepairTurnResult> {
  let hadError = false;
  let thinkingLogged = false;
  callbacks.historyManager.startTurn(opts.userMessage, opts.contextNote);
  if (opts.showUserMessageInTranscript) {
    await callbacks.onMessage(opts.userMessage);
  }

  const result = await runExtensionChat({
    config: opts.config,
    agentType: opts.agentType,
    historyManager: callbacks.historyManager,
    toolContext: callbacks.buildToolContext(opts.config),
    onChunk: async (chunk) => {
      if (chunk.type === "thinking" && !thinkingLogged && chunk.delta.trim()) {
        thinkingLogged = true;
        callbacks.appendLog(
          "status",
          `Received thinking stream from ${opts.agentType}.`,
        );
      }
      await callbacks.onChunk(chunk, opts.agentType);
      if (chunk.type === "error") {
        hadError = true;
      }
    },
    onMessage: async (chatMessage) => {
      await callbacks.onMessage(chatMessage);
    },
    onToolCalls: async (toolCalls) => {
      await callbacks.onToolCalls("repair-turn", toolCalls);
    },
    onStatus: async (statusText) => {
      callbacks.setStatusText(statusText);
      callbacks.reportProgress(statusText);
      await callbacks.postRunState();
    },
    onEvidenceContext: async (payload) => {
      await callbacks.onEvidenceContext("repair-turn", payload);
    },
    requestToolApproval: async (approval) =>
      callbacks.requestToolApproval(approval),
  });

  if (result.errorMessage && !hadError) {
    hadError = true;
    callbacks.historyManager.clearCurrentTurn();
    callbacks.writeDebug(
      "repair-turn-result",
      `agent=${opts.agentType} error text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
    );
    if (result.assistantThinking.trim()) {
      callbacks.writeDebugBlock(
        "repair-turn-thinking",
        result.assistantThinking,
      );
    }
    if (result.assistantText.trim()) {
      callbacks.writeDebugBlock("repair-turn-content", result.assistantText);
    }
    await callbacks.postErrorMessage(result.errorMessage);
  } else if (result.assistantText.trim()) {
    callbacks.writeDebug(
      "repair-turn-result",
      `agent=${opts.agentType} success text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
    );
    callbacks.writeDebugBlock("repair-turn-content", result.assistantText);
    if (result.assistantThinking.trim()) {
      callbacks.writeDebugBlock(
        "repair-turn-thinking",
        result.assistantThinking,
      );
    }
    if (!result.assistantThinking.trim()) {
      callbacks.appendLog(
        "status",
        `No thinking stream was returned by ${opts.agentType} for this turn.`,
      );
    }
    callbacks.historyManager.finalizeTurn({
      assistantText: result.assistantText,
      commitConclusion: !callbacks.shouldGateAssistantFinalMessage(
        result.filesWritten,
      ),
    });
    if (!callbacks.shouldGateAssistantFinalMessage(result.filesWritten)) {
      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: result.assistantText,
        agentType: opts.agentType,
        ...(result.assistantThinking.trim()
          ? { thinking: result.assistantThinking }
          : {}),
        timestamp: Date.now(),
      };
      await callbacks.addMessage(assistantMessage);
    } else if (result.filesWritten.length > 0) {
      callbacks.clearStreamingBuffers();
      await callbacks.postInit();
    }
  } else if (!hadError) {
    callbacks.writeDebug(
      "repair-turn-result",
      `agent=${opts.agentType} empty text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
    );
    const previousTurn = callbacks.historyManager.getWorkingTurn();
    callbacks.historyManager.clearCurrentTurn();

    const emptyContinueAttempt = opts.emptyContinueAttempt ?? 0;
    if (emptyContinueAttempt < MAX_EMPTY_CONTINUE_ATTEMPTS) {
      const nextAttempt = emptyContinueAttempt + 1;
      callbacks.appendLog(
        "status",
        `Empty assistant result detected. Auto-continuing (${nextAttempt}/${MAX_EMPTY_CONTINUE_ATTEMPTS})...`,
      );
      callbacks.writeDebug(
        "turn-empty-continue",
        `agent=${opts.agentType} attempt=${nextAttempt} repair_turn=true`,
      );

      const nextResult = await runInternalRepairTurn(callbacks, {
        ...opts,
        userMessage: callbacks.buildContinueMessage({
          attempt: nextAttempt,
          lastUserGoal: previousTurn?.userMessage.content,
          lastThinking: result.assistantThinking,
          filesWritten: result.filesWritten,
          recentToolSummaries:
            previousTurn?.toolDigests.map((digest) => digest.summary) ?? [],
        }),
        showUserMessageInTranscript: false,
        emptyContinueAttempt: nextAttempt,
      });

      return Object.freeze({
        hadError: nextResult.hadError,
        filesWritten: Object.freeze([
          ...new Set([...result.filesWritten, ...nextResult.filesWritten]),
        ]),
      });
    }

    hadError = true;
    const message =
      result.filesWritten.length > 0
        ? `Agent stopped after writing ${result.filesWritten.length} file(s) but still returned no final summary after ${MAX_EMPTY_CONTINUE_ATTEMPTS} auto-continue attempts.`
        : `Agent returned an empty result after ${MAX_EMPTY_CONTINUE_ATTEMPTS} auto-continue attempts.`;
    callbacks.appendLog("error", message);
    await callbacks.postErrorMessage(message);
    callbacks.showWorkbenchError(message);
  }

  return Object.freeze({
    hadError,
    filesWritten: result.filesWritten,
  });
}
