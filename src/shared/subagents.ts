/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Role registry, default model routing, and tool profiles for sub-agent orchestration.
 */

import type { GalaxyConfig } from "./config";
import {
  BA_SUB_AGENT_MODEL,
  CODER_SUB_AGENT_MODEL,
  MAIN_SUB_AGENT_MODEL,
  PLANNING_SUB_AGENT_MODEL,
  REVIEW_SUB_AGENT_MODEL,
  SA_SUB_AGENT_MODEL,
  TESTING_SUB_AGENT_MODEL,
} from "./constants";
import type {
  SelectiveMultiAgentSubtask,
  SubagentHandoffRecord,
  SubagentHandoffStatus,
  SubagentRoleDefinition,
  SubagentRoleId,
  SubagentToolProfile,
} from "./runtime";

const HOSTED_OLLAMA_BASE_URL = "https://ollama.com";

const FULL_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: true,
  webResearch: true,
  validation: true,
  review: true,
  vscodeNative: true,
  galaxyDesign: true,
});

const DISCOVERY_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: false,
  webResearch: true,
  validation: false,
  review: false,
  vscodeNative: true,
  galaxyDesign: true,
});

const ARCHITECTURE_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: true,
  webResearch: true,
  validation: false,
  review: false,
  vscodeNative: true,
  galaxyDesign: true,
});

const CODING_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: true,
  webResearch: true,
  validation: true,
  review: false,
  vscodeNative: true,
  galaxyDesign: true,
});

const TESTING_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: true,
  runCommands: true,
  webResearch: false,
  validation: true,
  review: false,
  vscodeNative: true,
  galaxyDesign: false,
});

const REVIEW_TOOL_PROFILE: SubagentToolProfile = Object.freeze({
  readProject: true,
  editFiles: false,
  runCommands: true,
  webResearch: false,
  validation: true,
  review: true,
  vscodeNative: true,
  galaxyDesign: false,
});

function manualModel(model: string): SubagentRoleDefinition["model"] {
  return Object.freeze({
    agentType: "manual",
    model,
    baseUrl: HOSTED_OLLAMA_BASE_URL,
  });
}

/** Registry of every first-class sub-agent role supported by the runtime. */
export const SUBAGENT_ROLE_REGISTRY: Readonly<Record<SubagentRoleId, SubagentRoleDefinition>> = Object.freeze({
  main: Object.freeze({
    id: "main",
    title: "Main Agent",
    mission: "Own turn-level orchestration, decide whether to delegate, and keep the final response coherent.",
    model: manualModel(MAIN_SUB_AGENT_MODEL),
    toolProfile: FULL_TOOL_PROFILE,
    canAskUser: true,
    canEditFiles: true,
  }),
  ba: Object.freeze({
    id: "ba",
    title: "Business Analyst Agent",
    mission: "Clarify requirements, user flows, constraints, acceptance criteria, and blocking product decisions before implementation starts.",
    model: manualModel(BA_SUB_AGENT_MODEL),
    toolProfile: DISCOVERY_TOOL_PROFILE,
    canAskUser: true,
    canEditFiles: false,
  }),
  planning: Object.freeze({
    id: "planning",
    title: "Planning Agent",
    mission: "Break the request into an execution plan, sequencing, risks, and handoff notes without editing project files.",
    model: manualModel(PLANNING_SUB_AGENT_MODEL),
    toolProfile: DISCOVERY_TOOL_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
  sa: Object.freeze({
    id: "sa",
    title: "Solution Architect Agent",
    mission: "Choose the technical approach, module boundaries, contracts, and integration strategy using current project evidence.",
    model: manualModel(SA_SUB_AGENT_MODEL),
    toolProfile: ARCHITECTURE_TOOL_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
  coding: Object.freeze({
    id: "coding",
    title: "Coding Agent",
    mission: "Implement the scoped code changes with the smallest practical blast radius and preserve existing project conventions.",
    model: manualModel(CODER_SUB_AGENT_MODEL),
    toolProfile: CODING_TOOL_PROFILE,
    canAskUser: false,
    canEditFiles: true,
  }),
  testing: Object.freeze({
    id: "testing",
    title: "Testing Agent",
    mission: "Run or add focused validation for the changed surface and fix test-related defects within the assigned scope.",
    model: manualModel(TESTING_SUB_AGENT_MODEL),
    toolProfile: TESTING_TOOL_PROFILE,
    canAskUser: false,
    canEditFiles: true,
  }),
  review: Object.freeze({
    id: "review",
    title: "Review Agent",
    mission: "Review changed code as a code leader, identify correctness gaps, and decide whether the work is complete.",
    model: manualModel(REVIEW_SUB_AGENT_MODEL),
    toolProfile: REVIEW_TOOL_PROFILE,
    canAskUser: false,
    canEditFiles: false,
  }),
});

/** Returns the static definition for one sub-agent role. */
export function getSubagentRoleDefinition(roleId: SubagentRoleId): SubagentRoleDefinition {
  return SUBAGENT_ROLE_REGISTRY[roleId];
}

/** Returns a config copy whose model and available tool surface are narrowed for one role. */
export function buildSubagentRoleConfig(config: GalaxyConfig, roleId: SubagentRoleId): GalaxyConfig {
  const role = getSubagentRoleDefinition(roleId);
  const nextAgent = [...config.agent];
  const manualIndex = nextAgent.findIndex((agent) => agent.type === "manual");
  const baseUrl = role.model.baseUrl ?? HOSTED_OLLAMA_BASE_URL;

  if (manualIndex >= 0) {
    const existingManualAgent = nextAgent[manualIndex]!;
    nextAgent[manualIndex] = {
      type: "manual",
      model: role.model.model,
      baseUrl: existingManualAgent.baseUrl ?? baseUrl,
      ...(existingManualAgent.apiKey ? { apiKey: existingManualAgent.apiKey } : {}),
    };
  } else {
    nextAgent.unshift({
      type: "manual",
      model: role.model.model,
      baseUrl,
      apiKey: "",
    });
  }

  return {
    ...config,
    agent: nextAgent,
    toolCapabilities: Object.freeze({
      readProject: config.toolCapabilities.readProject && role.toolProfile.readProject,
      editFiles: config.toolCapabilities.editFiles && role.toolProfile.editFiles,
      runCommands: config.toolCapabilities.runCommands && role.toolProfile.runCommands,
      webResearch: config.toolCapabilities.webResearch && role.toolProfile.webResearch,
      validation: config.toolCapabilities.validation && role.toolProfile.validation,
      review: config.toolCapabilities.review && role.toolProfile.review,
      vscodeNative: config.toolCapabilities.vscodeNative && role.toolProfile.vscodeNative,
      galaxyDesign: config.toolCapabilities.galaxyDesign && role.toolProfile.galaxyDesign,
    }),
  };
}

/** Formats the role's allowed high-level tool groups for scoped prompts. */
export function formatSubagentToolProfile(roleId: SubagentRoleId): string {
  const profile = getSubagentRoleDefinition(roleId).toolProfile;
  return Object.entries(profile)
    .filter(([, enabled]) => enabled)
    .map(([name]) => `- ${name}`)
    .join("\n");
}

/** Builds a structured handoff record after one sub-agent role finishes. */
export function buildSubagentHandoffRecord(opts: {
  planId: string;
  index: number;
  total: number;
  subtask: SelectiveMultiAgentSubtask;
  status: SubagentHandoffStatus;
  filesWritten: readonly string[];
  startedAt: number;
  completedAt: number;
  nextRole?: SubagentRoleId;
}): SubagentHandoffRecord {
  const role = getSubagentRoleDefinition(opts.subtask.role);
  const filesText = opts.filesWritten.length > 0
    ? opts.filesWritten.join(", ")
    : "No files written.";
  const summary = [
    `${role.title} finished "${opts.subtask.title}" with status ${opts.status}.`,
    `Objective: ${opts.subtask.objective}`,
    `Files: ${filesText}`,
    opts.nextRole ? `Next role: ${opts.nextRole}` : "Next role: none",
  ].join("\n");

  return Object.freeze({
    planId: opts.planId,
    handoffId: `${opts.planId}-${opts.index}-${opts.subtask.id}-${opts.subtask.role}`,
    index: opts.index,
    total: opts.total,
    subtaskId: opts.subtask.id,
    role: opts.subtask.role,
    roleTitle: role.title,
    model: role.model.model,
    title: opts.subtask.title,
    objective: opts.subtask.objective,
    status: opts.status,
    acceptanceCriteria: Object.freeze([...opts.subtask.acceptanceCriteria]),
    ...(opts.subtask.scopeNotes?.length ? { scopeNotes: Object.freeze([...opts.subtask.scopeNotes]) } : {}),
    filesWritten: Object.freeze([...opts.filesWritten]),
    ...(opts.nextRole ? { nextRole: opts.nextRole } : {}),
    summary,
    startedAt: opts.startedAt,
    completedAt: opts.completedAt,
  });
}

/** Formats a handoff record as retrieval-friendly task memory text. */
export function formatSubagentHandoffForMemory(handoff: SubagentHandoffRecord): string {
  return [
    "[SUBAGENT HANDOFF]",
    `Plan: ${handoff.planId}`,
    `Step: ${handoff.index}/${handoff.total}`,
    `Role: ${handoff.roleTitle} (${handoff.role})`,
    `Model: ${handoff.model}`,
    `Scope: ${handoff.subtaskId}`,
    `Status: ${handoff.status}`,
    `Title: ${handoff.title}`,
    `Objective: ${handoff.objective}`,
    handoff.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${handoff.acceptanceCriteria.map((line) => `- ${line}`).join("\n")}`
      : "",
    handoff.scopeNotes?.length
      ? `Scope notes:\n${handoff.scopeNotes.map((line) => `- ${line}`).join("\n")}`
      : "",
    handoff.filesWritten.length > 0
      ? `Files written:\n${handoff.filesWritten.map((filePath) => `- ${filePath}`).join("\n")}`
      : "Files written: none",
    handoff.nextRole ? `Next role: ${handoff.nextRole}` : "Next role: none",
    "",
    handoff.summary,
  ].filter(Boolean).join("\n");
}
