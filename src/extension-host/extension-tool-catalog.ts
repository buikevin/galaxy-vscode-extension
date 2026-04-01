/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Extension-tool catalog discovery, search, and activation helpers for the extension host.
 */

import {
  discoverExtensionToolGroups,
  searchExtensionToolGroups,
} from "../runtime/extension-tool-discovery";
import type {
  ActivateExtensionToolsToolParams,
  SearchExtensionToolsToolParams,
} from "../shared/extension-tool-catalog";
import type { ExtensionToolGroup } from "../shared/protocol";
import type { ToolResult } from "../tools/entities/file-tools";

/** Refresh the runtime extension-tool catalog for the current extension instance. */
export function refreshExtensionToolGroups(
  extensionId: string,
): readonly ExtensionToolGroup[] {
  return discoverExtensionToolGroups(extensionId);
}

/** Search the local extension-tool catalog and format a user-facing result payload. */
export function searchExtensionTools(
  params: Readonly<{
    extensionId: string;
    query: string;
    maxResults?: number;
    extensionToolToggles: Readonly<Record<string, boolean>>;
  }>,
): Readonly<{
  groups: readonly ExtensionToolGroup[];
  result: ToolResult;
}> {
  const groups = refreshExtensionToolGroups(params.extensionId);
  const trimmed = params.query.trim();
  if (!trimmed) {
    return Object.freeze({
      groups,
      result: Object.freeze({
        success: false,
        content: "",
        error: "search_extension_tools requires a non-empty query.",
      }),
    });
  }

  const matches = searchExtensionToolGroups(
    groups,
    trimmed,
    Math.max(1, Math.min(params.maxResults ?? 8, 12)),
    8,
  );

  if (matches.length === 0) {
    return Object.freeze({
      groups,
      result: Object.freeze({
        success: true,
        content: "(no matching local extension tools)",
        meta: Object.freeze({
          query: trimmed,
          groups: 0,
          operation: "search_extension_tools",
        }),
      }),
    });
  }

  const lines: string[] = [];
  for (const group of matches) {
    lines.push(`## ${group.label} [${group.extensionId}]`);
    lines.push(group.description);
    lines.push(
      `source=${group.source}${group.recommended ? " recommended" : ""}`,
    );
    for (const tool of group.tools) {
      const enabled =
        params.extensionToolToggles[tool.key] === true ? "enabled" : "disabled";
      lines.push(`- key=${tool.key}`);
      lines.push(`  tool=${tool.runtimeName}`);
      lines.push(`  invocation=${tool.invocation}`);
      if (tool.commandId) {
        lines.push(`  command=${tool.commandId}`);
      }
      lines.push(`  status=${enabled}`);
      lines.push(`  desc=${tool.description}`);
    }
    lines.push("");
  }

  return Object.freeze({
    groups,
    result: Object.freeze({
      success: true,
      content: lines.join("\n").trim(),
      meta: Object.freeze({
        query: trimmed,
        groups: matches.length,
        operation: "search_extension_tools",
      }),
    }),
  });
}

/** Activate a subset of local extension tools and return a formatted result payload. */
export async function activateExtensionTools(
  params: Readonly<{
    extensionId: string;
    toolKeys: readonly string[];
    extensionToolToggles: Readonly<Record<string, boolean>>;
    applyExtensionToolToggles: (
      next: Readonly<Record<string, boolean>>,
      opts?: Readonly<{ logMessage?: string }>,
    ) => Promise<void>;
  }>,
): Promise<
  Readonly<{
    groups: readonly ExtensionToolGroup[];
    result: ToolResult;
  }>
> {
  const groups = refreshExtensionToolGroups(params.extensionId);
  const normalizedKeys = [
    ...new Set(params.toolKeys.map((item) => item.trim()).filter(Boolean)),
  ];
  if (normalizedKeys.length === 0) {
    return Object.freeze({
      groups,
      result: Object.freeze({
        success: false,
        content: "",
        error: "activate_extension_tools requires at least one tool key.",
      }),
    });
  }

  const discovered = new Map(
    groups.flatMap((group) =>
      group.tools.map((tool) => [tool.key, { group, tool }] as const),
    ),
  );
  const valid = normalizedKeys.filter((key) => discovered.has(key));
  if (valid.length === 0) {
    return Object.freeze({
      groups,
      result: Object.freeze({
        success: false,
        content: "",
        error:
          "None of the provided tool keys matched the local extension tool catalog.",
      }),
    });
  }

  await params.applyExtensionToolToggles(
    {
      ...params.extensionToolToggles,
      ...Object.fromEntries(valid.map((key) => [key, true])),
    },
    {
      logMessage: `Activated ${valid.length} extension tool(s) from local catalog.`,
    },
  );

  const lines = valid.map((key) => {
    const item = discovered.get(key)!;
    return `- ${item.tool.runtimeName} (${item.group.label})`;
  });

  return Object.freeze({
    groups,
    result: Object.freeze({
      success: true,
      content: `Activated extension tools:\n${lines.join("\n")}`,
      meta: Object.freeze({
        activatedCount: valid.length,
        operation: "activate_extension_tools",
        toolKeys: Object.freeze(valid),
      }),
    }),
  });
}

/** Searches extension tools from provider-owned state and keeps cached groups synchronized. */
export async function searchExtensionToolsTool(
  params: SearchExtensionToolsToolParams,
): Promise<ToolResult> {
  try {
    const outcome = searchExtensionTools({
      extensionId: params.extensionId,
      query: params.query,
      maxResults: params.maxResults,
      extensionToolToggles: params.extensionToolToggles,
    });
    params.setExtensionToolGroups(outcome.groups);
    return outcome.result;
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/** Activates extension tools from provider-owned state and keeps cached groups synchronized. */
export async function activateExtensionToolsTool(
  params: ActivateExtensionToolsToolParams,
): Promise<ToolResult> {
  try {
    const outcome = await activateExtensionTools({
      extensionId: params.extensionId,
      toolKeys: params.toolKeys,
      extensionToolToggles: params.extensionToolToggles,
      applyExtensionToolToggles: params.applyExtensionToolToggles,
    });
    params.setExtensionToolGroups(outcome.groups);
    return outcome.result;
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}
