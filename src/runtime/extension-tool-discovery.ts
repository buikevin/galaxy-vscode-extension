/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-25
 * @modify date 2026-03-25
 * @desc Discover public commands contributed by installed VS Code extensions so Galaxy can expose them as optional extension tool groups in Configure Tools.
 */

import * as vscode from 'vscode';
import type { ExtensionToolGroup, ExtensionToolItem } from '../shared/protocol';

type PackageJsonCommand = Readonly<{
  command?: string;
  title?: string;
  category?: string;
}>;

function normalizeSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildToolDescription(command: PackageJsonCommand): string {
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

function buildToolItem(extensionId: string, command: PackageJsonCommand): ExtensionToolItem | null {
  if (!command.command || !command.title) {
    return null;
  }

  const extensionNamespace = normalizeSegment(extensionId.split('.').pop() ?? extensionId);
  const titleSegment = normalizeSegment(command.title);
  const commandSegment = normalizeSegment(command.command.split('.').pop() ?? command.command);
  const localName = titleSegment || commandSegment || 'command';

  return Object.freeze({
    key: `${extensionId}:${command.command}`,
    command: command.command,
    qualifiedName: `${extensionNamespace}.${localName}`,
    title: command.title,
    description: buildToolDescription(command),
  });
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

/**
 * Discover installed VS Code extensions that publicly contribute commands suitable for optional Galaxy tool listing.
 */
export function discoverExtensionToolGroups(contextExtensionId: string): readonly ExtensionToolGroup[] {
  return Object.freeze(
    vscode.extensions.all
      .filter((extension) => extension.id !== contextExtensionId)
      .filter((extension) => !extension.packageJSON?.isBuiltin)
      .map((extension) => {
        const commands = Array.isArray(extension.packageJSON?.contributes?.commands)
          ? (extension.packageJSON.contributes.commands as PackageJsonCommand[])
          : [];

        const tools = commands
          .map((command) => buildToolItem(extension.id, command))
          .filter((tool): tool is ExtensionToolItem => Boolean(tool));

        if (tools.length === 0) {
          return null;
        }

        const displayName =
          typeof extension.packageJSON?.displayName === 'string' && extension.packageJSON.displayName.trim()
            ? extension.packageJSON.displayName.trim()
            : extension.id;
        const description =
          typeof extension.packageJSON?.description === 'string' && extension.packageJSON.description.trim()
            ? extension.packageJSON.description.trim()
            : `Public commands contributed by ${displayName}.`;

        return Object.freeze({
          extensionId: extension.id,
          label: displayName,
          description,
          version: String(extension.packageJSON?.version ?? ''),
          tools: Object.freeze(
            [...tools].sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
          ),
        } satisfies ExtensionToolGroup);
      })
      .filter((group): group is ExtensionToolGroup => Boolean(group))
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
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
      const groupScore = scoreMatch(
        queryTokens,
        `${group.extensionId} ${group.label} ${group.description}`,
      );
      const tools = group.tools
        .map((tool) => ({
          tool,
          score: scoreMatch(
            queryTokens,
            `${tool.qualifiedName} ${tool.command} ${tool.title} ${tool.description}`,
          ),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.tool.qualifiedName.localeCompare(right.tool.qualifiedName))
        .slice(0, maxToolsPerGroup)
        .map((entry) => entry.tool);

      return {
        group,
        score: groupScore + tools.length,
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
