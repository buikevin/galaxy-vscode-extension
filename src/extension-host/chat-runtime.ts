/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Selective multi-agent orchestration and repair-turn runtime helpers extracted from the extension host entrypoint.
 */

import path from "node:path";
import { appendTelemetryEvent } from "../context/telemetry";
import { getProjectStorageInfo } from "../context/project-store";
import {
  appendTaskMemoryEntry,
  replaceTaskMemoryFindings,
} from "../context/rag-metadata/task-memory";
import {
  buildSubAgentConfig,
  buildSelectiveMultiAgentPlanMessage,
  buildSelectiveMultiAgentSubtaskMessage,
  buildSelectiveMultiAgentPlanWithRouter,
} from "../runtime/selective-multi-agent";
import { runExtensionChat } from "../runtime/run-chat";
import { runProjectCommandTool } from "../tools/project-command";
import { MAX_EMPTY_CONTINUE_ATTEMPTS } from "../shared/constants";
import type { AgentType, ChatMessage } from "../shared/protocol";
import {
  buildClarificationRequestFromUnderstanding,
  formatClarificationAnswer,
  formatClarificationRequest,
} from "../shared/clarification";
import {
  buildArchitectureApprovalRequest,
  formatArchitectureApprovalRequest,
  needsArchitectureApproval,
} from "../shared/architecture-approval";
import {
  buildEnvironmentReadinessReport,
  buildEnvironmentSetupPlan,
  buildEnvironmentSetupDecisionRequest,
  formatEnvironmentSetupPlan,
  formatEnvironmentSetupRunSummary,
  formatEnvironmentReadinessReport,
  formatEnvironmentSetupDecisionRequest,
  isEnvironmentProfileFresh,
  loadEnvironmentProfile,
  saveEnvironmentProfile,
  shouldRunEnvironmentPreflightForPlan,
} from "../shared/environment-preflight";
import { buildTaskUnderstanding } from "../shared/task-understanding";
import {
  buildSubagentHandoffRecord,
  formatSubagentHandoffForMemory,
  formatSubagentHandoffForTranscript,
  getSubagentRoleDefinition,
  resolveSubagentModelProfile,
} from "../shared/subagents";
import type { GalaxyConfig } from "../shared/config";
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
import type {
  ClarificationAnswer,
  SelectiveMultiAgentPlan,
  SubagentHandoffRecord,
  SubagentHandoffStatus,
} from "../shared/runtime";
import type { EnvironmentSetupDecision } from "../shared/environment-preflight";
import type {
  EnvironmentSetupCommand,
  EnvironmentSetupRunSummary,
} from "../shared/environment-preflight";
import { createAssistantMessage, createMessageId } from "./utils";

const MAX_ZERO_FILE_CODING_RETRIES = 1;

function buildAgentMessageMetadata(
  config: GalaxyConfig,
  agentType: AgentType,
): Readonly<{
  agentRole: string;
  agentModel: string;
  phase: string;
}> {
  const agentModel =
    config.agent.find((agent) => agent.type === agentType)?.model ??
    config.agent.find((agent) => agent.type === "manual")?.model ??
    agentType;
  if (config.activeSubagentRole) {
    const role = getSubagentRoleDefinition(config.activeSubagentRole);
    return Object.freeze({
      agentRole: role.title,
      agentModel,
      phase: `Subagent: ${config.activeSubagentRole}`,
    });
  }
  return Object.freeze({
    agentRole: "Main Agent",
    agentModel,
    phase: "Main turn",
  });
}

function persistClarificationAnswerToTaskMemory(
  callbacks: ChatRuntimeCallbacks,
  answer: ClarificationAnswer,
  originalUserContent: string,
): void {
  appendTaskMemoryEntry(callbacks.workspacePath, {
    workspaceId: callbacks.historyManager.getWorkspaceId(),
    turnId: answer.requestId,
    turnKind: "clarification",
    userIntent: `Clarification answer for: ${originalUserContent.slice(0, 1200)}`,
    assistantConclusion: formatClarificationAnswer(answer).slice(0, 2400),
    attachmentsJson: JSON.stringify([
      `decisions:${answer.decisions.join(",")}`,
      ...(answer.selectedOptionId ? [`option:${answer.selectedOptionId}`] : []),
    ]),
    confidence: 0.95,
    freshnessScore: 1,
    createdAt: answer.answeredAt,
  });
  replaceTaskMemoryFindings(callbacks.workspacePath, answer.requestId, [
    Object.freeze({
      id: `${answer.requestId}-decision`,
      entryTurnId: answer.requestId,
      kind: "decision" as const,
      summary: answer.answerText.slice(0, 800),
      status: "resolved" as const,
      createdAt: answer.answeredAt,
    }),
  ]);
}

function persistSubagentHandoffToTaskMemory(
  callbacks: ChatRuntimeCallbacks,
  handoff: SubagentHandoffRecord,
  originalUserContent: string,
): void {
  const conclusion = formatSubagentHandoffForMemory(handoff);
  appendTaskMemoryEntry(callbacks.workspacePath, {
    workspaceId: callbacks.historyManager.getWorkspaceId(),
    turnId: handoff.handoffId,
    turnKind: "subagent_handoff",
    userIntent: `Sub-agent handoff for ${handoff.role}: ${originalUserContent.slice(0, 1200)}`,
    assistantConclusion: conclusion.slice(0, 2400),
    filesJson: JSON.stringify(handoff.filesWritten),
    attachmentsJson: JSON.stringify([
      `plan:${handoff.planId}`,
      `role:${handoff.role}`,
      `model:${handoff.model}`,
      `status:${handoff.status}`,
    ]),
    confidence: handoff.status === "failed" ? 0.65 : 0.9,
    freshnessScore: 1,
    createdAt: handoff.completedAt,
  });
  replaceTaskMemoryFindings(callbacks.workspacePath, handoff.handoffId, [
    Object.freeze({
      id: `${handoff.handoffId}-summary`,
      entryTurnId: handoff.handoffId,
      kind: "handoff" as const,
      summary: `${handoff.roleTitle} ${handoff.status}: ${handoff.title}`,
      status: handoff.status === "completed" ? "resolved" as const : "open" as const,
      createdAt: handoff.completedAt,
    }),
  ]);
}

async function prepareEnvironmentPreflight(
  callbacks: ChatRuntimeCallbacks,
  opts: SelectiveMultiAgentPlanRequest,
  plan: SelectiveMultiAgentPlan,
  currentUserMessage: ChatMessage,
): Promise<Readonly<{ proceed: boolean; userMessage: ChatMessage }>> {
  if (!shouldRunEnvironmentPreflightForPlan(plan)) {
    return Object.freeze({ proceed: true, userMessage: currentUserMessage });
  }

  const report = buildEnvironmentReadinessReport(callbacks.workspacePath);
  const storage = getProjectStorageInfo(callbacks.workspacePath);
  const profilePath = path.join(storage.projectDirPath, "environment-profile.json");
  const profile = loadEnvironmentProfile(profilePath);
  const cachedDecision = isEnvironmentProfileFresh(profile, report.fingerprint)
    ? profile.decision
    : undefined;
  let decision: EnvironmentSetupDecision | undefined =
    report.status === "ready" || report.status === "missing_optional"
      ? "continue"
      : cachedDecision;

  if (report.status === "missing_required" && !decision) {
    const request = buildEnvironmentSetupDecisionRequest(report);
    await callbacks.addMessage({
      ...createAssistantMessage(formatEnvironmentSetupDecisionRequest(request)),
      agentType: opts.agentType,
      ...buildAgentMessageMetadata(opts.config, opts.agentType),
    });
    callbacks.appendLog("approval", "Environment setup decision is required before Coding Agent starts.");
    decision = await callbacks.askEnvironmentSetupDecision(request) ?? undefined;
  }

  saveEnvironmentProfile(profilePath, report, decision);
  const reportContext = [
    formatEnvironmentReadinessReport(report),
    decision ? `Environment decision: ${decision}` : "Environment decision: not provided",
  ].join("\n");

  if (!decision && report.status === "missing_required") {
    return Object.freeze({ proceed: false, userMessage: currentUserMessage });
  }

  if (decision === "manual_install" || decision === "change_architecture" || decision === "cancel") {
    await callbacks.addMessage({
      ...createAssistantMessage(reportContext),
      agentType: opts.agentType,
      ...buildAgentMessageMetadata(opts.config, opts.agentType),
    });
    return Object.freeze({ proceed: false, userMessage: currentUserMessage });
  }

  if (decision === "ai_install") {
    const setupPlan = buildEnvironmentSetupPlan(report);
    await callbacks.addMessage({
      ...createAssistantMessage(formatEnvironmentSetupPlan(setupPlan)),
      agentType: opts.agentType,
      ...buildAgentMessageMetadata(opts.config, opts.agentType),
    });
    if (setupPlan.commands.length === 0 || setupPlan.unsupported.length > 0) {
      await callbacks.addMessage({
        ...createAssistantMessage(
          `Environment setup cannot continue automatically until the unsupported system tools are installed or the architecture is changed.\n\n${reportContext}`,
        ),
        agentType: opts.agentType,
        ...buildAgentMessageMetadata(opts.config, opts.agentType),
      });
      return Object.freeze({ proceed: false, userMessage: currentUserMessage });
    }

    const setupResults = [];
    for (const command of setupPlan.commands) {
      const approval = await callbacks.requestToolApproval({
        toolName: "run_project_command",
        approvalKey: `environment-setup:${command.command}`,
        title: command.label,
        message: `Galaxy wants to run an environment setup command before Coding starts: ${command.command}`,
        details: [command.reason, `Workspace: ${callbacks.workspacePath}`],
      });
      if (approval !== "allow") {
        setupResults.push(Object.freeze({
          command,
          success: false,
          content: "",
          error: "User denied setup command.",
        }));
        continue;
      }
      const result = await runProjectCommandTool(callbacks.workspacePath, command.command, { cwd: command.cwd, maxChars: 8000 });
      setupResults.push(Object.freeze({
        command,
        success: result.success,
        content: result.content,
        ...(result.error ? { error: result.error } : {}),
      }));
    }

    const reportAfter = buildEnvironmentReadinessReport(callbacks.workspacePath);
    const setupSummary: EnvironmentSetupRunSummary = Object.freeze({
      plan: setupPlan,
      results: Object.freeze(setupResults as readonly Readonly<{
        command: EnvironmentSetupCommand;
        success: boolean;
        content: string;
        error?: string;
      }>[]),
      reportAfter,
    });
    saveEnvironmentProfile(profilePath, reportAfter, reportAfter.status === "missing_required" ? "manual_install" : "continue");
    const setupContext = formatEnvironmentSetupRunSummary(setupSummary);
    await callbacks.addMessage({
      ...createAssistantMessage(setupContext),
      agentType: opts.agentType,
      ...buildAgentMessageMetadata(opts.config, opts.agentType),
    });
    if (reportAfter.status === "missing_required") {
      return Object.freeze({ proceed: false, userMessage: currentUserMessage });
    }
    return Object.freeze({
      proceed: true,
      userMessage: Object.freeze({
        ...currentUserMessage,
        content: [
          currentUserMessage.content,
          "",
          setupContext,
        ].join("\n"),
      }),
    });
  }

  callbacks.appendLog("info", `Environment preflight status: ${report.status}.`);
  callbacks.writeDebugBlock("environment-preflight", reportContext);
  return Object.freeze({
    proceed: true,
    userMessage: Object.freeze({
      ...currentUserMessage,
      content: [
        currentUserMessage.content,
        "",
        reportContext,
      ].join("\n"),
    }),
  });
}

/** Runs the selective multi-agent planner and executes scoped repair turns when a plan is produced. */
export async function runSelectiveMultiAgentPlan(
  callbacks: ChatRuntimeCallbacks,
  opts: SelectiveMultiAgentPlanRequest,
): Promise<SelectiveMultiAgentPlanResult> {
  let originalUserMessage = opts.originalUserMessage;
  if (opts.config.subagent && opts.agentType === "manual") {
    const taskUnderstanding = await buildTaskUnderstanding(
      opts.config,
      opts.originalUserMessage.content,
    );
    const clarificationRequest =
      buildClarificationRequestFromUnderstanding(taskUnderstanding);
    if (clarificationRequest) {
      callbacks.appendLog(
        "status",
        `Clarification required: ${clarificationRequest.decisions.join(", ")}`,
      );
      appendTelemetryEvent(callbacks.workspacePath, {
        kind: "clarification_requested",
        agentType: opts.agentType,
        decisions: Object.freeze([...clarificationRequest.decisions]),
        optionCount: clarificationRequest.options.length,
        reason: clarificationRequest.reason,
      });
      const clarificationAnswer =
        await callbacks.askUserClarification(clarificationRequest);
      if (!clarificationAnswer) {
        await callbacks.addMessage({
          ...createAssistantMessage(
            `${formatClarificationRequest(clarificationRequest)}\n\nReply with your choice to continue.`,
          ),
          agentType: opts.agentType,
        });
        return Object.freeze({
          handled: true,
          hadError: false,
          filesWritten: Object.freeze([]),
        });
      }

      persistClarificationAnswerToTaskMemory(
        callbacks,
        clarificationAnswer,
        opts.originalUserMessage.content,
      );
      originalUserMessage = Object.freeze({
        ...opts.originalUserMessage,
        content: [
          opts.originalUserMessage.content,
          "",
          formatClarificationAnswer(clarificationAnswer),
        ].join("\n"),
      });
    }
  }

  const plan = await buildSelectiveMultiAgentPlanWithRouter(
    opts.config,
    opts.agentType,
    originalUserMessage.content,
  );
  if (!plan) {
    appendTelemetryEvent(callbacks.workspacePath, {
      kind: "subagent_routing",
      enabled: opts.config.subagent,
      agentType: opts.agentType,
      routed: false,
      reason:
        opts.config.subagent && opts.agentType === "manual"
          ? "No selective subagent plan matched the user request."
          : "Subagent orchestration is disabled or unavailable for this agent type.",
      roles: Object.freeze([]),
      subtaskCount: 0,
    });
    return Object.freeze({
      handled: false,
      hadError: false,
      filesWritten: Object.freeze([]),
    });
  }
  appendTelemetryEvent(callbacks.workspacePath, {
    kind: "subagent_routing",
    enabled: opts.config.subagent,
    agentType: opts.agentType,
    routed: true,
    reason: plan.reason,
    roles: Object.freeze(plan.subtasks.map((subtask) => subtask.role)),
    subtaskCount: plan.subtasks.length,
  });

  await callbacks.addMessage({
    ...createAssistantMessage(buildSelectiveMultiAgentPlanMessage(plan)),
    agentType: opts.agentType,
    ...buildAgentMessageMetadata(opts.config, opts.agentType),
  });
  callbacks.appendLog(
    "info",
    `Selective multi-agent plan activated: ${plan.subtasks
      .map((subtask) => {
        const role = getSubagentRoleDefinition(subtask.role);
        const model = resolveSubagentModelProfile(opts.config, subtask.role).model;
        return `${role.title}/${model}`;
      })
      .join(", ")}.`,
  );

  const planId = `subagent-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const written = new Set<string>();
  const completedHandoffs: SubagentHandoffRecord[] = [];
  const requiresArchitectureApproval = needsArchitectureApproval(plan);
  let architectureApproved = !requiresArchitectureApproval;
  let environmentPreflightDone = false;
  let postCodingEnvironmentPreflightDone = false;
  let hadError = false;
  const hasDesignContext =
    Boolean(originalUserMessage.images?.length) ||
    Boolean(originalUserMessage.figmaAttachments?.length) ||
    Boolean(
      originalUserMessage.attachments?.some(
        (attachment) =>
          attachment.kind === "figma" || attachment.kind === "image",
      ),
    );

  for (let index = 0; index < plan.subtasks.length; index += 1) {
    const subtask = plan.subtasks[index]!;
    if (!environmentPreflightDone && subtask.role === "coding") {
      const preflight = await prepareEnvironmentPreflight(
        callbacks,
        opts,
        plan,
        originalUserMessage,
      );
      environmentPreflightDone = true;
      if (!preflight.proceed) {
        return Object.freeze({
          handled: true,
          hadError: false,
          filesWritten: Object.freeze([...written]),
        });
      }
      originalUserMessage = preflight.userMessage;
    }
    if (
      !postCodingEnvironmentPreflightDone &&
      subtask.role === "testing" &&
      written.size > 0
    ) {
      const preflight = await prepareEnvironmentPreflight(
        callbacks,
        opts,
        plan,
        originalUserMessage,
      );
      postCodingEnvironmentPreflightDone = true;
      if (!preflight.proceed) {
        return Object.freeze({
          handled: true,
          hadError: false,
          filesWritten: Object.freeze([...written]),
        });
      }
      originalUserMessage = preflight.userMessage;
    }
    if (!architectureApproved && subtask.role === "coding") {
      const approvalRequest = buildArchitectureApprovalRequest({
        plan,
        completedHandoffs,
      });
      await callbacks.addMessage({
        ...createAssistantMessage(formatArchitectureApprovalRequest(approvalRequest)),
        agentType: opts.agentType,
        ...buildAgentMessageMetadata(opts.config, opts.agentType),
      });
      callbacks.appendLog("approval", "Architecture approval is required before Coding Agent starts.");
      const decision = await callbacks.askArchitectureApproval(approvalRequest);
      if (decision !== "approve") {
        const status = decision === "revise"
          ? "Architecture approval requested revisions before coding."
          : decision === "cancel"
            ? "Architecture approval was cancelled before coding."
            : "Architecture approval was not provided before coding.";
        await callbacks.addMessage({
          ...createAssistantMessage(status),
          agentType: opts.agentType,
          ...buildAgentMessageMetadata(opts.config, opts.agentType),
        });
        return Object.freeze({
          handled: true,
          hadError: false,
          filesWritten: Object.freeze([...written]),
        });
      }
      architectureApproved = true;
    }
    const subAgentConfig = buildSubAgentConfig(opts.config, subtask.role);
    const roleDefinition = getSubagentRoleDefinition(subtask.role);
    const modelProfile = resolveSubagentModelProfile(opts.config, subtask.role);
    const subtaskLabel = `Sub-agent ${index + 1}/${plan.subtasks.length} - ${roleDefinition.title} (${subtask.role}, ${modelProfile.model}): ${subtask.title}`;
    const startedAt = Date.now();
    callbacks.setStatusText(subtaskLabel);
    callbacks.appendLog("status", subtaskLabel);
    callbacks.reportProgress(subtaskLabel);
    await callbacks.postRunState();

    let result: RepairTurnResult;
    for (let codingAttempt = 0; ; codingAttempt += 1) {
      const subtaskMessage = buildSelectiveMultiAgentSubtaskMessage({
        config: opts.config,
        originalUserMessage,
        subtask,
      });
      result = await runInternalRepairTurn(callbacks, {
        config: subAgentConfig,
        agentType: opts.agentType,
        userMessage:
          codingAttempt === 0 || subtask.role !== "coding"
            ? subtaskMessage
            : {
                ...subtaskMessage,
                id: createMessageId(),
                content: [
                  subtaskMessage.content,
                  "",
                  "[RETRY REQUIREMENT]",
                  "Your previous Coding Agent turn completed with zero file edits. This coding scope requires actual workspace changes.",
                  "Do not claim files were created or modified unless you call write_file, multi_edit_file_ranges, or another available edit tool successfully.",
                  "Before handing off, verify the requested files exist in the current workspace.",
                ].join("\n"),
              },
        suppressAssistantTranscript: true,
        ...(opts.contextNote &&
        (index === 0 ||
          (hasDesignContext &&
            (subtask.id === "frontend" || subtask.id === "integration")))
          ? { contextNote: opts.contextNote }
          : {}),
      });

      const zeroFileCodingTurn =
        subtask.role === "coding" &&
        result.filesWritten.length === 0 &&
        !result.hadError;
      if (!zeroFileCodingTurn || codingAttempt >= MAX_ZERO_FILE_CODING_RETRIES) {
        break;
      }
      const retryStatus = `${roleDefinition.title} reported completion without file edits; retrying once with explicit edit-tool requirement.`;
      callbacks.setStatusText(retryStatus);
      callbacks.appendLog("status", retryStatus);
      callbacks.reportProgress(retryStatus);
      await callbacks.postRunState();
    }

    for (const filePath of result.filesWritten) {
      written.add(filePath);
    }
    appendTelemetryEvent(callbacks.workspacePath, {
      kind: "sub_agent_turn",
      scope: subtask.id,
      filesWritten: result.filesWritten.length,
      hadError: result.hadError,
    });
    const zeroFileCodingFailure =
      subtask.role === "coding" &&
      result.filesWritten.length === 0 &&
      !result.hadError;
    if (zeroFileCodingFailure) {
      const message = "Coding Agent finished without any successful file edits. Treating this subagent phase as failed to prevent downstream testing/review from validating hallucinated files.";
      await callbacks.addMessage({
        ...createAssistantMessage(message),
        agentType: opts.agentType,
        ...buildAgentMessageMetadata(opts.config, opts.agentType),
      });
      callbacks.appendLog("error", message);
    }
    const handoffStatus: SubagentHandoffStatus = result.hadError || zeroFileCodingFailure
      ? "failed"
      : subtask.role === "ba" && result.filesWritten.length === 0
        ? "needs_user_input"
        : "completed";
    const nextSubtask = plan.subtasks[index + 1];
    const handoff = buildSubagentHandoffRecord({
      planId,
      index: index + 1,
      total: plan.subtasks.length,
      subtask,
      status: handoffStatus,
      filesWritten: result.filesWritten,
      startedAt,
      completedAt: Date.now(),
      ...(nextSubtask ? { nextRole: nextSubtask.role } : {}),
      model: modelProfile.model,
    });
    persistSubagentHandoffToTaskMemory(
      callbacks,
      handoff,
      opts.originalUserMessage.content,
    );
    completedHandoffs.push(handoff);
    await callbacks.addMessage({
      ...createAssistantMessage(formatSubagentHandoffForTranscript(handoff)),
      agentType: opts.agentType,
      agentRole: handoff.roleTitle,
      agentModel: handoff.model,
      phase: `Subagent handoff ${handoff.index}/${handoff.total}`,
    });
    callbacks.appendLog(
      handoff.status === "failed" ? "error" : "info",
      `${handoff.roleTitle} ${handoff.status}: ${handoff.title}`,
    );

    if (result.hadError || zeroFileCodingFailure) {
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
        agentType: opts.agentType,
        ...buildAgentMessageMetadata(opts.config, opts.agentType),
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
  const runtimeMetadata = buildAgentMessageMetadata(opts.config, opts.agentType);
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
      if (!opts.suppressAssistantTranscript || chunk.type === "error") {
        await callbacks.onChunk(chunk, opts.agentType);
      }
      if (chunk.type === "error") {
        hadError = true;
      }
    },
    onMessage: async (chatMessage) => {
      if (opts.suppressAssistantTranscript && chatMessage.role === "assistant") {
        return;
      }
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
    if (
      !opts.suppressAssistantTranscript &&
      !callbacks.shouldGateAssistantFinalMessage(result.filesWritten)
    ) {
      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: result.assistantText,
        agentType: opts.agentType,
        ...runtimeMetadata,
        ...(result.assistantThinking.trim()
          ? { thinking: result.assistantThinking }
          : {}),
        timestamp: Date.now(),
      };
      await callbacks.addMessage(assistantMessage);
    } else if (!opts.suppressAssistantTranscript && result.filesWritten.length > 0) {
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
