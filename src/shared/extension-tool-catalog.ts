/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for extension-tool catalog wrappers extracted from the extension entrypoint.
 */

import type { ExtensionToolGroup } from "./protocol";

/** Parameters required to search the local extension-tool catalog from provider-owned state. */
export type SearchExtensionToolsToolParams = Readonly<{
  /** Extension id used to discover local extension tool groups. */
  extensionId: string;
  /** Search query forwarded to the local extension-tool catalog. */
  query: string;
  /** Optional maximum number of groups returned in the formatted result. */
  maxResults?: number;
  /** Current enablement map used to annotate discovered tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Stores the refreshed tool groups after the search completes. */
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
}>;

/** Parameters required to activate local extension tools from provider-owned state. */
export type ActivateExtensionToolsToolParams = Readonly<{
  /** Extension id used to discover local extension tool groups. */
  extensionId: string;
  /** Requested extension tool keys to activate. */
  toolKeys: readonly string[];
  /** Current enablement map used as the activation baseline. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Applies the next extension tool toggle map into provider state. */
  applyExtensionToolToggles: (
    next: Readonly<Record<string, boolean>>,
    opts?: Readonly<{ logMessage?: string }>,
  ) => Promise<void>;
  /** Stores the refreshed tool groups after activation completes. */
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
}>;
