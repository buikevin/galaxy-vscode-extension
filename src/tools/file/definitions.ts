/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Tool schema definitions and enablement rules for VS Code file tools.
 */

import type { GalaxyConfig, ToolCapabilityConfig } from '../../shared/config';
import type { DiscoveredExtensionTool, ToolDefinition } from '../entities/file-tools';
import { ACTION_TOOL_DEFINITIONS } from './definitions/action-tools';
import { FILE_TOOL_DEFINITIONS } from './definitions/file-tools';
import { GALAXY_DESIGN_TOOL_DEFINITIONS } from './definitions/galaxy-design-tools';
import { QUALITY_TOOL_DEFINITIONS } from './definitions/quality-tools';
import { VSCODE_NATIVE_TOOL_DEFINITIONS } from './definitions/vscode-native-tools';
import { normalizeToolName } from './tooling';

/**
 * Returns all extension tools discoverable from the active config.
 *
 * @param config Active Galaxy config.
 * @returns Immutable list of discovered extension tools.
 */
export function getAvailableExtensionTools(config: GalaxyConfig): readonly DiscoveredExtensionTool[] {
  return Object.freeze(
    (config.availableExtensionToolGroups ?? []).flatMap((group) =>
      group.tools.map((tool) =>
        Object.freeze({
          group,
          tool,
        }),
      ),
    ),
  );
}

/**
 * Locates one discovered extension tool by runtime name, command id, or key.
 *
 * @param config Active Galaxy config.
 * @param rawName Raw tool name emitted by the model.
 * @returns Matching extension tool or null when none exists.
 */
export function findDiscoveredExtensionTool(
  config: GalaxyConfig,
  rawName: string,
): DiscoveredExtensionTool | null {
  const normalizedRaw = String(rawName ?? '').trim().toLowerCase();
  if (!normalizedRaw) {
    return null;
  }

  return (
    getAvailableExtensionTools(config).find(
      ({ tool }) =>
        tool.runtimeName.trim().toLowerCase() === normalizedRaw ||
        (tool.commandId?.trim().toLowerCase() ?? '') === normalizedRaw ||
        tool.key.trim().toLowerCase() === normalizedRaw,
    ) ?? null
  );
}

/**
 * Maps one canonical tool id to its top-level capability toggle.
 *
 * @param toolName Raw or canonical tool name.
 * @returns Matching capability key or null when the tool is always allowed.
 */
function getToolCapability(toolName: string): keyof ToolCapabilityConfig | null {
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'read_file':
    case 'find_test_files':
    case 'get_latest_test_failure':
    case 'get_latest_review_findings':
    case 'get_next_review_finding':
    case 'dismiss_review_finding':
    case 'grep':
    case 'list_dir':
    case 'head':
    case 'tail':
    case 'read_document':
      return 'readProject';
    case 'write_file':
    case 'insert_file_at_line':
    case 'edit_file':
    case 'edit_file_range':
    case 'multi_edit_file_ranges':
      return 'editFiles';
    case 'run_project_command':
    case 'run_terminal_command':
    case 'await_terminal_command':
    case 'get_terminal_output':
    case 'kill_terminal_command':
    case 'git_status':
    case 'git_diff':
    case 'git_add':
    case 'git_commit':
    case 'git_push':
    case 'git_pull':
    case 'git_checkout':
      return 'runCommands';
    case 'search_web':
    case 'extract_web':
    case 'map_web':
    case 'crawl_web':
      return 'webResearch';
    case 'validate_code':
      return 'validation';
    case 'request_code_review':
      return 'review';
    case 'vscode_open_diff':
    case 'vscode_show_problems':
    case 'vscode_workspace_search':
    case 'vscode_find_references':
    case 'search_extension_tools':
    case 'activate_extension_tools':
      return 'vscodeNative';
    case 'galaxy_design_project_info':
    case 'galaxy_design_registry':
    case 'galaxy_design_init':
    case 'galaxy_design_add':
      return 'galaxyDesign';
    default:
      return null;
  }
}

/**
 * Returns whether one tool is enabled by capability toggles and extension-tool state.
 *
 * @param toolName Raw or canonical tool name.
 * @param config Active Galaxy config.
 * @returns True when the tool should be exposed to the model.
 */
export function isToolEnabled(toolName: string, config: GalaxyConfig): boolean {
  const extensionTool = findDiscoveredExtensionTool(config, toolName);
  if (extensionTool) {
    return config.extensionToolToggles[extensionTool.tool.key] === true;
  }

  const normalized = normalizeToolName(toolName);
  const capability = getToolCapability(normalized);
  const capabilityEnabled = capability ? config.toolCapabilities[capability] : true;
  const toolEnabled = normalized in config.toolToggles
    ? config.toolToggles[normalized as keyof GalaxyConfig['toolToggles']]
    : true;
  if (
    !config.toolSafety.enableGitWriteTools &&
    (normalized === 'git_add' ||
      normalized === 'git_commit' ||
      normalized === 'git_push' ||
      normalized === 'git_pull' ||
      normalized === 'git_checkout')
  ) {
    return false;
  }
  return capabilityEnabled && toolEnabled;
}

/**
 * Builds the active tool schema exposed to the model.
 *
 * @param config Active Galaxy config.
 * @returns Immutable tool definition list filtered by runtime toggles.
 */
export function getEnabledToolDefinitions(config: GalaxyConfig): readonly ToolDefinition[] {
  const fileTools = FILE_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  const actionTools = ACTION_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  const qualityTools = QUALITY_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  const vscodeNativeTools = VSCODE_NATIVE_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  const galaxyDesignTools = GALAXY_DESIGN_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  const extensionTools = getAvailableExtensionTools(config)
    .filter(({ tool }) => config.extensionToolToggles[tool.key] === true)
    .map(({ group, tool }) =>
      Object.freeze({
        name: tool.runtimeName,
        description:
          tool.invocation === 'lm_tool'
            ? `Run the public VS Code language model tool "${tool.runtimeName}" from ${group.label}. ${tool.description}`
            : `Run the curated public VS Code extension command "${tool.commandId ?? tool.runtimeName}" from ${group.label}. ${tool.description}`,
        parameters:
          (tool.inputSchema as Readonly<Record<string, unknown>> | undefined) ??
          Object.freeze({
            type: 'object',
            properties: Object.freeze({}),
            required: Object.freeze([]),
          }),
      } satisfies ToolDefinition),
    );
  return Object.freeze([
    ...fileTools,
    ...actionTools,
    ...qualityTools,
    ...vscodeNativeTools,
    ...galaxyDesignTools,
    ...extensionTools,
  ]);
}
