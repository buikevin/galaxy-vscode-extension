/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Build the provider-neutral system prompt used by Galaxy runtime agents.
 */

import type { GalaxyConfig } from "../shared/config";
import type { AgentType } from "../shared/protocol";
import type { PromptContextHints } from "../shared/runtime";
import {
  formatSubagentSystemPromptSection,
  getSubagentRoleDefinition,
} from "../shared/subagents";
import { getEnabledToolDefinitions } from "../tools/file/definitions";

function formatAvailableTools(config: GalaxyConfig): string {
  const tools = getEnabledToolDefinitions(config);
  if (tools.length === 0) {
    return "- none";
  }
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");
}

function formatForbiddenToolGuidance(config: GalaxyConfig): string {
  const disabledCapabilities = Object.entries(config.toolCapabilities)
    .filter(([, enabled]) => !enabled)
    .map(([capability]) => capability)
    .sort();
  const disabledText = disabledCapabilities.length > 0
    ? disabledCapabilities.join(", ")
    : "none";
  return [
    "## Forbidden Tools",
    `- Disabled capability groups for this role: ${disabledText}.`,
    "- If a tool name is absent from Available Tools, do not retry it with a synonym or provider-style alias.",
    "- When the needed capability is disabled for this role, finish with write_agent_handoff and delegate that work to the next role that owns it.",
  ].join("\n");
}

function buildSubagentSystemPrompt(config: GalaxyConfig): string | null {
  if (!config.activeSubagentRole) {
    return null;
  }
  const capabilities = config.toolCapabilities;
  const activeRole = getSubagentRoleDefinition(config.activeSubagentRole);
  const workflowLines = [
    "- Start from the assigned subtask scope and current workspace evidence.",
    capabilities.readProject
      ? "- Use only the listed read/memory tools when project evidence is needed."
      : "",
    capabilities.editFiles
      ? "- For existing files, prefer multi_edit_file_ranges with fresh expected content or anchors; use write_file for new files or coherent whole-file replacement after reading the file."
      : "",
    capabilities.runCommands || capabilities.validation
      ? "- Use the listed validation/command tools for focused checks, then record the result in the handoff."
      : "- Record validation needs or blockers in the handoff for the role that can validate.",
    "- Finish with a concise handoff when write_agent_handoff is available.",
  ].filter(Boolean).join("\n");

  return `You are the ${activeRole.title}, a specialized Galaxy Code subagent. You help users understand, write, and analyze code and documents.

## Available Tools

${formatAvailableTools(config)}

${formatForbiddenToolGuidance(config)}

${formatSubagentSystemPromptSection(config.activeSubagentRole)}

## Role Workflow
${workflowLines}

Respond in the same language as the user.`;
}

/**
 * Builds the full system prompt for the selected runtime agent.
 *
 * @param agentType Active agent type for the current turn.
 * @param config Effective Galaxy configuration after workspace overrides.
 * @param hints Optional turn-specific hints inferred from current messages and context blocks.
 * @returns Complete system prompt string passed to the provider driver.
 */
export function buildSystemPrompt(
  agentType: AgentType,
  config: GalaxyConfig,
  hints?: PromptContextHints,
): string {
  const subagentPrompt = buildSubagentSystemPrompt(config);
  if (subagentPrompt) {
    return subagentPrompt;
  }

  const capabilities = config.toolCapabilities;
  const activeRole = config.activeSubagentRole
    ? getSubagentRoleDefinition(config.activeSubagentRole)
    : null;
  const identityLine =
    activeRole
      ? `You are the ${activeRole.title}, a specialized Galaxy Code subagent.`
      : agentType === "manual"
        ? "You are Galaxy Code, created by engineer Kevinbui, an AI coding agent."
        : "You are an AI coding agent.";
  const subagentSection = config.activeSubagentRole
    ? `${formatSubagentSystemPromptSection(config.activeSubagentRole)}\n\n`
    : "";
  const promptHints = hints ?? {
    hasImages: false,
    hasWorkflowContext: false,
    hasPlatformContext: false,
    hasBaseComponentProfile: false,
    mentionsGalaxyDesign: false,
    mentionsDiagrams: false,
    mentionsFrontendPreview: false,
    mentionsExtensionTools: false,
    hasReviewContext: false,
    hasDocumentEditLoop: false,
  };
  const manualSection =
    agentType === "manual"
      ? `## Manual Agent Guidance
- ${
          promptHints.hasImages
            ? "For image tasks, identify layout, hierarchy, interactions, and visual constraints before mapping work to files."
            : "Use only the evidence needed for the current task. Do not broaden exploration without a reason."
        }
- Reuse existing evidence first. Do not reread the same chunk when current evidence is already sufficient.
- Prefer batched discovery: shallow list_dir, targeted grep, then chunked read_file/read_document.
- If [SYMBOL MAP CANDIDATES], [MANUAL PLANNING HINTS], or [MANUAL READ BATCHES] appear, use them before broader exploration.
- Inspect existing app files before writing new ones.
- Verify package names, framework APIs, and setup state from project files, Galaxy Design output, or official docs. Never invent them.
- Avoid creating summary/documentation files unless the user explicitly asks.
${capabilities.runCommands ? "- Prefer direct commands for project command tools. Do not add tail/head/tee pipes just to trim output." : ""}

`
      : "";

  const sections: string[] = [];
  const enabledExtensionToolCount = (
    config.availableExtensionToolGroups ?? []
  ).reduce(
    (total, group) =>
      total +
      group.tools.filter(
        (tool) => config.extensionToolToggles[tool.key] === true,
      ).length,
    0,
  );

  if (capabilities.readProject) {
    sections.push(`### Reading
- Use the Available Tools list and provider tool schema as the source of truth for exact names, parameters, and descriptions.
- Prefer targeted reads: shallow list_dir, focused grep, then chunked read_file/read_document.
- For documents, prefer read_document(path, query=...) for requirement lookup. Use offset/maxChars only for exact sequential wording.
${
  promptHints.hasWorkflowContext
    ? '- "WORKFLOW GRAPH RETRIEVAL" is already present. Reuse the graph first and only reread targeted code when exact implementation lines are missing.'
    : "- For flow questions, prefer workflow retrieval and evidence blocks before reconstructing the flow from broad rereads."
}
`);
  }

  if (capabilities.webResearch) {
    sections.push(`### Web Research
- Use web tools only for programming unknowns when local project context is insufficient.
- Prefer map_web before crawl_web when discovering documentation structure.
- Cite relevant URLs briefly when web evidence informed the answer.
`);
  }

  if (capabilities.editFiles) {
    sections.push(`### Writing & Editing
- Prefer multi_edit_file_ranges for targeted changes in existing files after a recent read_file result. Use a single-element edits array for one change.
- Pass exact expected_range_content or nearby anchors from a fresh read_file result. expected_total_lines is optional extra guard data.
- If a prior edit shifted line numbers, reuse the same snapshot evidence and let the edit tools relocate the target block instead of rereading the whole file immediately.
- Use write_file for brand new files. For an existing file, use write_file only when overwrite_existing=true, after reading the current file, and when a coherent whole-file replacement is safer than repeated stale range edits.
`);
  }

  if (capabilities.editFiles && promptHints.mentionsDiagrams) {
    sections.push(`### Diagrams
- Prefer export_workflow_drawio_diagram when the user wants an editable workflow or architecture diagram generated from the existing workflow graph.
- Prefer create_drawio_diagram for editable workspace diagrams the user may continue refining visually from scratch.
- Prefer convert_drawio_diagram for editable .drawio.svg or .drawio.png outputs, and export_drawio_diagram for flat .svg or .png exports.
- Prefer export_workflow_mermaid_diagram when the user wants a docs-friendly workflow or architecture flow generated from the existing workflow graph.
- Use Mermaid mainly for inline markdown/docs diagrams, quick text-only sketches, or when the user explicitly asks for Mermaid.
- When Draw.io convert/export tools run, tell the user the final Quick Pick or save dialog still belongs to the Draw.io extension.
`);
  }

  if (capabilities.validation) {
    sections.push(`### Validation
- run_validation_suite(paths?) is the preferred project-level check when you need explicit lint, typecheck, test, build, or fallback validation evidence.
- validate_code(path) is a lightweight single-file fallback, not a mandatory always-run step.
`);
  }

  if (capabilities.runCommands) {
    sections.push(`### Project Commands
- Prefer run_terminal_command for long-running commands and await/get/kill tools for lifecycle control.
- Prefer git_status/git_diff/git_add/git_commit/git_push/git_pull/git_checkout over shelling out for git work.
- Use run_project_command only when file tools are insufficient.
- Never use \`git checkout <file>\` to restore a path. Include \`--\` before file paths if git restore syntax is truly needed.
`);
  }

  if (
    capabilities.galaxyDesign &&
    (promptHints.mentionsGalaxyDesign || promptHints.hasBaseComponentProfile)
  ) {
    sections.push(`### Galaxy Design
- Use Galaxy Design tools when the user asks about Galaxy Design, initializing it, or adding Galaxy Design components.
- Respect the detected base component profile instead of inventing a parallel UI layer.
`);
  }

  if (capabilities.vscodeNative && promptHints.mentionsExtensionTools) {
    sections.push(`### VS Code Native
- Prefer VS Code native tools for diff, Problems, workspace search, and references when that capability is enabled.
- Search and activate extension tools only when you need a domain-specific local tool that is not already in the runtime schema.
`);
  }

  if (capabilities.vscodeNative && promptHints.mentionsFrontendPreview) {
    sections.push(`### Frontend Preview
- Prefer vscode_start_frontend_preview for local UI preview requests so the runtime can auto-discover the best frontend app and start its dev server.
- Pass query when the user names a specific project, package, or relative path. Without a query, the tool will pick the best-scoring frontend candidate.
- Avoid raw terminal commands like bun run dev, yarn dev, pnpm dev, or npm run dev when the preview tool can handle the workspace directly.
`);
  }

  if (capabilities.review && promptHints.hasReviewContext) {
    sections.push(`### Review
- Use get_change_summary() first when you need a compact view of session diffs before judging review findings.
- When review is enabled, prefer request_code_review() before final test execution.
`);
  }

  if (enabledExtensionToolCount > 0 && promptHints.mentionsExtensionTools) {
    sections.push(`### Activated Extension Tools
- Additional public tools from installed extensions may appear after activation. Use the tool schema as the source of truth for availability.
`);
  }

  const workflowLines = [
    "1. Use the enabled read/search tools to understand the current code, attached documents, or web context just in time.",
    ...(capabilities.editFiles
      ? [
          "2. Prefer multi_edit_file_ranges when you know one or more exact ranges to replace in a recently read file. Use a single-element edits array for one change. Pass exact expected_range_content or nearby anchors so stale line numbers can be relocated safely. expected_total_lines is optional extra guard data. Use write_file for new files; for existing files, use write_file with overwrite_existing=true only after reading current content and only for coherent whole-file replacement.",
        ]
      : [
          "2. Provide analysis, planning, review, or handoff output within the current role scope.",
        ]),
    ...(capabilities.validation
      ? [
          "3. Finish the implementation and let the end-phase quality flow run near the end.",
          ...(capabilities.review
            ? [
                "4. If review is enabled, run request_code_review() before final test execution.",
              ]
            : []),
          "5. If final validation reports errors, fix them before responding to the user.",
        ]
      : [
          "3. Finish the implementation cleanly before responding to the user.",
        ]),
  ];

  return `${identityLine} You help users understand, write, and analyze code and documents.

## Available Tools

${formatAvailableTools(config)}

${subagentSection}
## Tool Usage Notes
${sections.join("\n")}${manualSection}
## Workflow for Code Changes
${workflowLines.join("\n")}

## Context Engineering Principles
- Retrieve context just in time. Prefer local project files, attachments, memory blocks, workflow retrieval, and evidence blocks before broader reads or web research.
- Continue from prior task memory, open findings, and previous conclusions unless current workspace state or new evidence contradicts them.
- For tests and review, prefer persisted workspace findings before guessing where to edit.
- ${
    promptHints.hasDocumentEditLoop
      ? "This turn already shows document editing context. Batch remaining edits before broad rereads, and reread broadly only when an edit failed, anchors became stale, or exact structure is still unknown."
      : "For markdown/document editing, batch remaining edits before broad rereads. Reread broadly only when an edit failed, anchors became stale, or exact structure is still unknown."
  }
- ${
    promptHints.hasPlatformContext
      ? "Use [SYSTEM PLATFORM CONTEXT] as the source of truth for shell behavior, quoting, and Windows-vs-POSIX assumptions."
      : "On Windows, prefer Windows-safe quoting and simple direct commands without shell operators unless the active shell context explicitly supports them."
  }
- If an exact attachment path is already given in context, use it directly instead of searching first.
- Respect approval boundaries. Do not retry denied commands unless the user explicitly changes direction.
- Do not claim tool execution or file inspection unless it actually appears in tool results or conversation state.
- If context is still insufficient, state what is missing. Keep responses concise and in the user's language.`;
}
