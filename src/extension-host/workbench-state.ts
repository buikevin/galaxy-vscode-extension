/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Workbench chrome and webview session-state builders extracted from the extension host entrypoint.
 */

import { getAgentConfig, loadConfig } from "../config/manager";
import type {
  AgentType,
  PlanItem,
  QualityPreferences,
  QualityDetails,
  SessionInitPayload,
} from "../shared/protocol";
import type {
  ApprovalModeSummary,
  BuildSessionInitPayloadParams,
  WorkbenchChromeUpdateParams,
} from "../shared/extension-host";
import type {
  PhasePlanItems,
  UpdateQualityDetailsParams,
} from "../shared/workbench-runtime";
import { getAgentLabel } from "./utils";

/** Returns the current selected-agent detail line used in the status bar tooltip. */
export function getSelectedAgentDetail(selectedAgent: AgentType): string {
  const config = loadConfig();
  const agentConfig = getAgentConfig(config, selectedAgent);
  if (!agentConfig) {
    return "No configured model";
  }

  const parts = [agentConfig.model?.trim(), agentConfig.baseUrl?.trim()].filter(
    (value): value is string => Boolean(value),
  );

  return parts.join(" · ") || "Configured in ~/.galaxy/config.json";
}

/** Summarizes the current approval mode for the status bar. */
export function getApprovalModeSummary(params: {
  pendingApprovalRequestId: string | null;
  pendingApprovalTitle: string | null;
  qualityPreferences: QualityPreferences;
}): ApprovalModeSummary {
  if (params.pendingApprovalRequestId) {
    return Object.freeze({
      label: "Pending",
      tooltip:
        params.pendingApprovalTitle ??
        "A Galaxy Code tool is waiting for approval.",
    });
  }

  const config = loadConfig();
  const approvalFlags = [
    ["Git pull", config.toolSafety.requireApprovalForGitPull],
    ["Git push", config.toolSafety.requireApprovalForGitPush],
    ["Git checkout", config.toolSafety.requireApprovalForGitCheckout],
    ["Delete path", config.toolSafety.requireApprovalForDeletePath],
    ["Scaffold", config.toolSafety.requireApprovalForScaffold],
    ["Project command", config.toolSafety.requireApprovalForProjectCommand],
  ] as const;
  const enabled = approvalFlags
    .filter(([, requiresApproval]) => requiresApproval)
    .map(([label]) => label);

  if (enabled.length === 0) {
    return Object.freeze({
      label: params.qualityPreferences.fullAccessEnabled ? "Full" : "Off",
      tooltip: params.qualityPreferences.fullAccessEnabled
        ? "run_project_command, git pull/push/checkout, delete_path, and scaffold actions can run without asking for approval."
        : "No tool approvals are currently required.",
    });
  }

  if (enabled.length === approvalFlags.length) {
    return Object.freeze({
      label: "On",
      tooltip: "All supported write-capable tools currently require approval.",
    });
  }

  return Object.freeze({
    label: "Mixed",
    tooltip: `Approvals required for: ${enabled.join(", ")}`,
  });
}

/** Applies the current run, agent, and approval state to the status bar items. */
export function updateWorkbenchChrome(
  params: {} & WorkbenchChromeUpdateParams,
): void {
  const runIcon = params.isRunning ? "sync~spin" : "check";
  params.chrome.runStatusItem.text = `$(${runIcon}) Galaxy ${params.statusText}`;
  params.chrome.runStatusItem.tooltip = params.isRunning
    ? `Galaxy Code is running.\n${params.statusText}\n\nClick to open runtime logs.`
    : `Galaxy Code is idle.\n${params.statusText}\n\nClick to open runtime logs.`;

  const agentLabel = getAgentLabel(params.selectedAgent);
  const agentDetail = getSelectedAgentDetail(params.selectedAgent);
  params.chrome.agentStatusItem.text = `$(hubot) ${agentLabel}`;
  params.chrome.agentStatusItem.tooltip = `Current agent: ${agentLabel}\n${agentDetail}\n\nClick to switch agent.`;

  const approval = getApprovalModeSummary({
    pendingApprovalRequestId: params.pendingApprovalRequestId,
    pendingApprovalTitle: params.pendingApprovalTitle,
    qualityPreferences: params.qualityPreferences,
  });
  const approvalIcon = params.pendingApprovalRequestId ? "warning" : "shield";
  params.chrome.approvalStatusItem.text = `$(${approvalIcon}) Approvals ${approval.label}`;
  params.chrome.approvalStatusItem.tooltip = `${approval.tooltip}\n\nClick to open the Galaxy Code config folder.`;
}

/** Builds the full session-init payload sent to the webview on load or refresh. */
export function buildSessionInitPayload(
  params: {} & BuildSessionInitPayloadParams,
): SessionInitPayload {
  return {
    workspaceName: params.workspaceName,
    files: params.files,
    messages: params.messages,
    selectedAgent: params.selectedAgent,
    phase: "phase-8",
    isRunning: params.isRunning,
    statusText: params.statusText,
    planItems: params.planItems,
    logs: params.logs,
    qualityDetails: params.qualityDetails,
    qualityPreferences: params.qualityPreferences,
    toolCapabilities: params.toolCapabilities,
    toolToggles: params.toolToggles,
    extensionToolGroups: params.extensionToolGroups,
    extensionToolToggles: params.extensionToolToggles,
    changeSummary: params.changeSummary,
    ...(params.streamingAssistant
      ? { streamingAssistant: params.streamingAssistant }
      : {}),
    ...(params.streamingThinking
      ? { streamingThinking: params.streamingThinking }
      : {}),
    ...(params.activeShellSessions && params.activeShellSessions.length > 0
      ? {
          activeShellSessions: [...params.activeShellSessions].sort(
            (a, b) => a.startedAt - b.startedAt,
          ),
        }
      : {}),
    ...(params.approvalRequest
      ? { approvalRequest: params.approvalRequest }
      : {}),
  };
}

/** Returns the static migration plan items shown in the Galaxy webview. */
export function buildPhasePlanItems(): PhasePlanItems {
  return Object.freeze([
    Object.freeze({
      id: "phase-1-runtime",
      title: "Runtime + Providers",
      detail:
        "Independent provider drivers and streaming loop now run inside the extension host.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-2-history",
      title: "History + Project Storage",
      detail:
        "Transcript, session memory, working turn, and workspace storage persist across sessions.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-3-tools",
      title: "File + Workspace Tools",
      detail:
        "The host now supports read, write, edit, diff, revert, and workspace inspection tools.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-4-approvals",
      title: "Action Approvals",
      detail:
        "Git, scaffold, delete, and project commands run behind approval gates.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-5-evidence",
      title: "Tool Evidence",
      detail:
        "Relevant tool evidence is persisted and selectively re-injected into prompts.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-6-quality",
      title: "Validation + Review",
      detail:
        "Final validation, reviewer sub-agent, and auto-repair loops now run in the host.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-7-galaxy-design",
      title: "Galaxy Design",
      detail:
        "Registry lookup, init, add, and project inspection tools are integrated.",
      status: "done" as const,
    }),
    Object.freeze({
      id: "phase-8-polish",
      title: "Plan + Logs + Quality Views",
      detail:
        "The webview now surfaces migration plan state, runtime logs, quality summaries, and tracked diffs.",
      status: "done" as const,
    }),
  ]);
}

/** Merges one partial quality update into provider state and posts the refreshed payload. */
export function updateQualityDetails(params: UpdateQualityDetailsParams): void {
  const nextQualityDetails: QualityDetails = Object.freeze({
    validationSummary:
      params.update.validationSummary ??
      params.qualityDetails.validationSummary,
    reviewSummary:
      params.update.reviewSummary ?? params.qualityDetails.reviewSummary,
    reviewFindings:
      params.update.reviewFindings ??
      params.qualityDetails.reviewFindings ??
      Object.freeze([]),
  });
  params.setQualityDetails(nextQualityDetails);
  void params.postMessage({
    type: "quality-updated",
    payload: nextQualityDetails,
  });
}
