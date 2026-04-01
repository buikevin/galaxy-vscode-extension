/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared extension-tool discovery entities used to map VS Code extension contributions into Galaxy tool groups.
 */

/** Package.json command contribution used as a fallback tool source. */
export type PackageJsonCommand = Readonly<{
  /** Command id contributed by the extension. */
  command?: string;
  /** Human-readable title shown in VS Code. */
  title?: string;
  /** Optional category prefix shown in VS Code command palette. */
  category?: string;
}>;

/** Package.json language model tool contribution declared by an extension. */
export type PackageJsonLanguageModelTool = Readonly<{
  /** Runtime LM tool name used to match the VS Code registry. */
  name?: string;
  /** Display label shown to users. */
  displayName?: string;
  /** User-facing description of the tool. */
  userDescription?: string;
  /** Model-facing description of the tool. */
  modelDescription?: string;
  /** Input schema declared by the extension. */
  inputSchema?: object;
  /** Tags contributed by the extension for search and grouping. */
  tags?: readonly string[];
}>;

/** Curated fallback subset for an extension that is not yet fully exposed through the LM tool registry. */
export type CuratedExtensionSubset = Readonly<{
  /** User-facing label for the curated extension group. */
  label: string;
  /** Description shown in Galaxy when the fallback group is listed. */
  description: string;
  /** Command ids included in the curated fallback group. */
  commands: readonly string[];
}>;
