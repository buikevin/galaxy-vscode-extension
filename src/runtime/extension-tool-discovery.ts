/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-25
 * @modify date 2026-03-26
 * @desc Discover extension-provided runtime tools for Galaxy. Prefer public VS Code language model tools from vscode.lm.tools, and keep curated MCP-capable command fallbacks only for extensions that do not expose LM tools yet.
 */

import * as vscode from 'vscode';
import { CURATED_MCP_EXTENSION_SUBSETS } from '../shared/constants';
import type {
  PackageJsonCommand,
  PackageJsonLanguageModelTool,
} from '../shared/extension-tools';
import type { ExtensionToolGroup, ExtensionToolItem } from '../shared/protocol';

/**
 * Normalizes one text segment for use in runtime tool keys and lexical matching.
 *
 * @param input Raw text segment.
 * @returns Lowercased, underscore-delimited identifier.
 */
function normalizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Tokenizes searchable text into lowercase segments for ranking.
 *
 * @param value Raw search text.
 * @returns Search tokens extracted from the value.
 */
function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Scores a haystack string against a set of query tokens.
 *
 * @param queryTokens Tokenized search query.
 * @param haystack Text being scored.
 * @returns Higher score for better lexical matches.
 */
function scoreMatch(queryTokens: readonly string[], haystack: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalized = haystack.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!token) {
      continue;
    }
    if (normalized.includes(token)) {
      score += normalized.startsWith(token) ? 4 : 2;
    }
  }
  return score;
}

/**
 * Builds a human-readable description for a fallback command contribution.
 *
 * @param command Package.json command contribution from an extension.
 * @returns User-facing description string.
 */
function buildCommandDescription(command: PackageJsonCommand): string {
  const title = command.title?.trim();
  const category = command.category?.trim();
  if (category && title) {
    return `${category}: ${title}`;
  }
  if (title) {
    return title;
  }
  return command.command?.trim() ?? 'Public command exposed by the extension.';
}

/**
 * Converts one extension command contribution into a fallback Galaxy tool item.
 *
 * @param extensionId Owning extension id.
 * @param command Package.json command contribution.
 * @returns Tool item, or `null` when the command lacks the required metadata.
 */
function buildCommandFallbackToolItem(extensionId: string, command: PackageJsonCommand): ExtensionToolItem | null {
  if (!command.command || !command.title) {
    return null;
  }

  const extensionNamespace = normalizeSegment(extensionId.split('.').pop() ?? extensionId);
  const titleSegment = normalizeSegment(command.title);
  const commandSegment = normalizeSegment(command.command.split('.').pop() ?? command.command);
  const localName = titleSegment || commandSegment || 'command';

  return Object.freeze({
    key: `${extensionId}:command:${command.command}`,
    runtimeName: `${extensionNamespace}.${localName}`,
    title: command.title,
    description: buildCommandDescription(command),
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
    invocation: 'command',
    tags: Object.freeze([]),
    commandId: command.command,
  });
}

/**
 * Builds one tool item from a public VS Code language model tool contribution.
 *
 * @param extensionId Owning extension id.
 * @param runtimeInfo Runtime LM tool information exposed by VS Code.
 * @param contribution Optional package.json contribution metadata.
 * @returns Extension tool item for Galaxy.
 */
function buildLmToolItem(
  extensionId: string,
  runtimeInfo: vscode.LanguageModelToolInformation,
  contribution?: PackageJsonLanguageModelTool,
): ExtensionToolItem {
  const description =
    contribution?.modelDescription?.trim() ||
    contribution?.userDescription?.trim() ||
    runtimeInfo.description?.trim() ||
    contribution?.displayName?.trim() ||
    runtimeInfo.name;

  return Object.freeze({
    key: `${extensionId}:lm:${runtimeInfo.name}`,
    runtimeName: runtimeInfo.name,
    title: contribution?.displayName?.trim() || runtimeInfo.name,
    description,
    inputSchema: runtimeInfo.inputSchema,
    invocation: 'lm_tool',
    tags: Object.freeze([...(runtimeInfo.tags ?? contribution?.tags ?? [])]),
  });
}

/**
 * Indexes currently exposed VS Code LM tools by runtime name.
 *
 * @returns Map of runtime LM tools keyed by tool name.
 */
function getRuntimeLmToolsByName(): ReadonlyMap<string, vscode.LanguageModelToolInformation> {
  const entries = new Map<string, vscode.LanguageModelToolInformation>();
  for (const tool of vscode.lm.tools) {
    entries.set(tool.name, tool);
  }
  return entries;
}

/**
 * Builds extension tool groups backed by the public VS Code LM tool registry.
 *
 * @param contextExtensionId Current Galaxy extension id that should be excluded from discovery.
 * @returns Discoverable extension tool groups sourced from runtime LM tools.
 */
function buildLmToolGroups(contextExtensionId: string): readonly ExtensionToolGroup[] {
  const runtimeToolsByName = getRuntimeLmToolsByName();
  const claimedRuntimeNames = new Set<string>();

  const groups = vscode.extensions.all
    .filter((extension) => extension.id !== contextExtensionId)
    .filter((extension) => !extension.packageJSON?.isBuiltin)
    .flatMap((extension) => {
      const contributedTools = Array.isArray(extension.packageJSON?.contributes?.languageModelTools)
        ? (extension.packageJSON.contributes.languageModelTools as PackageJsonLanguageModelTool[])
        : [];

      if (contributedTools.length === 0) {
        return [];
      }

      const tools = contributedTools
        .map((contribution) => {
          const runtimeInfo = contribution.name ? runtimeToolsByName.get(contribution.name) : undefined;
          if (!runtimeInfo) {
            return null;
          }
          claimedRuntimeNames.add(runtimeInfo.name);
          return buildLmToolItem(extension.id, runtimeInfo, contribution);
        })
        .filter((tool): tool is ExtensionToolItem => Boolean(tool));

      if (tools.length === 0) {
        return [];
      }

      const displayName =
        typeof extension.packageJSON?.displayName === 'string' && extension.packageJSON.displayName.trim()
          ? extension.packageJSON.displayName.trim()
          : extension.id;
      const description =
        typeof extension.packageJSON?.description === 'string' && extension.packageJSON.description.trim()
          ? extension.packageJSON.description.trim()
          : `Language model tools contributed by ${displayName}.`;

      return [
        Object.freeze({
          extensionId: extension.id,
          label: displayName,
          description,
          version: String(extension.packageJSON?.version ?? ''),
          source: 'lm_tool',
          tools: Object.freeze([...tools].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))),
        } satisfies ExtensionToolGroup),
      ];
    });

  const unclaimed = [...runtimeToolsByName.values()]
    .filter((tool) => !claimedRuntimeNames.has(tool.name))
    .reduce<Map<string, vscode.LanguageModelToolInformation[]>>((map, tool) => {
      const prefix = normalizeSegment(tool.name.split(/[-_.]/)[0] ?? 'runtime');
      const key = prefix || 'runtime';
      const items = map.get(key) ?? [];
      items.push(tool);
      map.set(key, items);
      return map;
    }, new Map());

  for (const [prefix, tools] of unclaimed.entries()) {
    groups.push(
      Object.freeze({
        extensionId: `runtime.${prefix}`,
        label: `${prefix.toUpperCase()} LM Tools`,
        description: 'Runtime-discovered language model tools that are available through VS Code but are not mapped to a specific installed extension contribution yet.',
        version: '',
        source: 'lm_tool',
        tools: Object.freeze(
          tools
            .map((tool) => buildLmToolItem(`runtime.${prefix}`, tool))
            .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName)),
        ),
      } satisfies ExtensionToolGroup),
    );
  }

  return Object.freeze(groups.sort((left, right) => left.label.localeCompare(right.label)));
}

/**
 * Builds curated MCP fallback groups for extensions that do not yet expose public LM tools.
 *
 * @param contextExtensionId Current Galaxy extension id that should be excluded from discovery.
 * @returns Curated extension tool groups used as fallbacks.
 */
function buildCuratedMcpFallbackGroups(contextExtensionId: string): readonly ExtensionToolGroup[] {
  return Object.freeze(
    vscode.extensions.all
      .filter((extension) => extension.id !== contextExtensionId)
      .filter((extension) => !extension.packageJSON?.isBuiltin)
      .flatMap((extension) => {
        const curated = CURATED_MCP_EXTENSION_SUBSETS[extension.id];
        if (!curated) {
          return [];
        }

        const commands = Array.isArray(extension.packageJSON?.contributes?.commands)
          ? (extension.packageJSON.contributes.commands as PackageJsonCommand[])
          : [];

        const tools = commands
          .filter((command) => curated.commands.includes(String(command.command ?? '').trim()))
          .map((command) => buildCommandFallbackToolItem(extension.id, command))
          .filter((tool): tool is ExtensionToolItem => Boolean(tool));

        if (tools.length === 0) {
          return [];
        }

        return [
          Object.freeze({
            extensionId: extension.id,
            label: curated.label,
            description: curated.description,
            version: String(extension.packageJSON?.version ?? ''),
            source: 'mcp_curated',
            recommended: true,
            tools: Object.freeze(tools.sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))),
          } satisfies ExtensionToolGroup),
        ];
      })
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
}

/**
 * Discover installed VS Code extensions that expose public runtime tools.
 * Prefer public language model tools, then keep compact MCP-capable command fallbacks.
 */
export function discoverExtensionToolGroups(contextExtensionId: string): readonly ExtensionToolGroup[] {
  const groups = [...buildLmToolGroups(contextExtensionId), ...buildCuratedMcpFallbackGroups(contextExtensionId)];
  return Object.freeze(groups.sort((left, right) => left.label.localeCompare(right.label)));
}

/**
 * Searches discovered extension tool groups using a simple lexical ranking strategy.
 *
 * @param groups Candidate extension tool groups to search.
 * @param query Search query entered by the user or model.
 * @param maxGroups Maximum number of matched groups to return.
 * @param maxToolsPerGroup Maximum number of matched tools kept in one group.
 * @returns Matched extension tool groups with filtered tool lists.
 */
export function searchExtensionToolGroups(
  groups: readonly ExtensionToolGroup[],
  query: string,
  maxGroups = 8,
  maxToolsPerGroup = 8,
): readonly ExtensionToolGroup[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return Object.freeze(groups.slice(0, maxGroups));
  }

  const ranked = groups
    .map((group) => {
      const groupScore = scoreMatch(queryTokens, `${group.extensionId} ${group.label} ${group.description}`);
      const tools = group.tools
        .map((tool) => ({
          tool,
          score: scoreMatch(
            queryTokens,
            `${tool.runtimeName} ${tool.title} ${tool.description} ${tool.tags.join(' ')}`,
          ),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.tool.runtimeName.localeCompare(right.tool.runtimeName),
        )
        .slice(0, maxToolsPerGroup)
        .map((entry) => entry.tool);

      const sourceBoost =
        group.source === 'lm_tool'
          ? 8
          : group.source === 'mcp_curated'
            ? 4
            : 0;

      return {
        group,
        score: groupScore + tools.length + sourceBoost,
        tools,
      };
    })
    .filter((entry) => entry.score > 0 && entry.tools.length > 0)
    .sort((left, right) => right.score - left.score || left.group.label.localeCompare(right.group.label))
    .slice(0, maxGroups)
    .map((entry) =>
      Object.freeze({
        ...entry.group,
        tools: Object.freeze(entry.tools),
      } satisfies ExtensionToolGroup),
    );

  return Object.freeze(ranked);
}
