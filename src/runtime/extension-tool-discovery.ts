/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-25
 * @modify date 2026-03-26
 * @desc Discover extension-provided runtime tools for Galaxy. Prefer public VS Code language model tools from vscode.lm.tools, and keep curated MCP-capable command fallbacks only for extensions that do not expose LM tools yet.
 */

import * as vscode from 'vscode';
import type { ExtensionToolGroup, ExtensionToolItem } from '../shared/protocol';

type PackageJsonCommand = Readonly<{
  command?: string;
  title?: string;
  category?: string;
}>;

type PackageJsonLanguageModelTool = Readonly<{
  name?: string;
  displayName?: string;
  userDescription?: string;
  modelDescription?: string;
  inputSchema?: object;
  tags?: readonly string[];
}>;

type CuratedExtensionSubset = Readonly<{
  label: string;
  description: string;
  commands: readonly string[];
}>;

const CURATED_MCP_EXTENSION_SUBSETS: Readonly<Record<string, CuratedExtensionSubset>> = Object.freeze({
  'eamodio.gitlens': Object.freeze({
    label: 'GitKraken / GitLens MCP',
    description:
      'Curated Git workflows from GitLens, preferred as a compact fallback while Galaxy waits for VS Code to surface MCP-backed tools through the public LM tool registry.',
    commands: Object.freeze([
      'gitlens.git.status',
      'gitlens.git.checkout',
      'gitlens.git.branch',
      'gitlens.git.merge',
      'gitlens.git.rebase',
      'gitlens.startWork',
      'gitlens.startReview',
      'gitlens.openPullRequestOnRemote',
      'gitlens.createPullRequestOnRemote',
    ]),
  }),
  'nrwl.angular-console': Object.freeze({
    label: 'Nx MCP Server',
    description:
      'Curated Nx workspace tools from Nx Console. These remain a compact fallback until Nx surfaces runtime LM tools through MCP discovery.',
    commands: Object.freeze([
      'nx.run',
      'nx.run-many',
      'nx.generate.ui',
      'nx.affected.test',
      'nx.affected.build',
      'nx.affected.lint',
      'nxConsole.showProblems',
      'nx.configureMcpServer',
    ]),
  }),
  'mongodb.mongodb-vscode': Object.freeze({
    label: 'MongoDB MCP Server',
    description:
      'Curated MongoDB MCP management tools from the MongoDB extension. These are used until MongoDB LM tools are surfaced in the runtime registry.',
    commands: Object.freeze([
      'mdb.startMCPServer',
      'mdb.stopMCPServer',
      'mdb.getMCPServerConfig',
    ]),
  }),
});

function normalizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

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

function getRuntimeLmToolsByName(): ReadonlyMap<string, vscode.LanguageModelToolInformation> {
  const entries = new Map<string, vscode.LanguageModelToolInformation>();
  for (const tool of vscode.lm.tools) {
    entries.set(tool.name, tool);
  }
  return entries;
}

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
