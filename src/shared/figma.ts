/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared Figma entities used by the bridge server, design store, attachment pipeline, and extension runtime.
 */

/** Exported asset embedded in a Figma design payload. */
export type FigmaDesignAsset = Readonly<{
  /** Stable asset id within the exported document. */
  id: string;
  /** Asset rendering kind used for preview and filtering. */
  kind: 'svg' | 'png';
  /** Human-readable asset name. */
  name: string;
  /** Base64-encoded asset payload. */
  contentBase64: string;
}>;

/** Absolute Figma bounding box in design-space coordinates. */
export type FigmaBoundingBox = Readonly<{
  /** Left coordinate. */
  x: number;
  /** Top coordinate. */
  y: number;
  /** Width of the node. */
  width: number;
  /** Height of the node. */
  height: number;
}>;

/** Simplified auto-layout information for one Figma node. */
export type FigmaLayoutInfo = Readonly<{
  /** Layout mode of the node. */
  mode?: 'none' | 'horizontal' | 'vertical';
  /** Whether items wrap across rows or columns. */
  wrap?: boolean;
  /** Gap between children. */
  gap?: number;
  /** Top padding. */
  paddingTop?: number;
  /** Right padding. */
  paddingRight?: number;
  /** Bottom padding. */
  paddingBottom?: number;
  /** Left padding. */
  paddingLeft?: number;
  /** Main-axis alignment. */
  alignMain?: string;
  /** Cross-axis alignment. */
  alignCross?: string;
  /** Horizontal sizing behavior. */
  sizingHorizontal?: 'hug' | 'fill' | 'fixed';
  /** Vertical sizing behavior. */
  sizingVertical?: 'hug' | 'fill' | 'fixed';
}>;

/** Simplified visual styling for one Figma node. */
export type FigmaStyleInfo = Readonly<{
  /** Fill paints. */
  fills?: readonly unknown[];
  /** Stroke paints. */
  strokes?: readonly unknown[];
  /** Stroke width. */
  strokeWidth?: number;
  /** Corner radius or per-corner radii. */
  radius?: number | Readonly<{ tl: number; tr: number; br: number; bl: number }>;
  /** Node opacity. */
  opacity?: number;
  /** Layer effects. */
  effects?: readonly unknown[];
}>;

/** Simplified text styling for one Figma text node. */
export type FigmaTextInfo = Readonly<{
  /** Text characters. */
  characters: string;
  /** Font family. */
  fontFamily?: string;
  /** Font weight. */
  fontWeight?: number;
  /** Font size. */
  fontSize?: number;
  /** Line height. */
  lineHeight?: number;
  /** Letter spacing. */
  letterSpacing?: number;
  /** Horizontal alignment. */
  textAlignHorizontal?: string;
  /** Vertical alignment. */
  textAlignVertical?: string;
}>;

/** Simplified component-instance metadata for one Figma node. */
export type FigmaComponentInfo = Readonly<{
  /** Stable component key when available. */
  componentKey?: string;
  /** Human-readable component name. */
  componentName?: string;
  /** Variant properties selected on the instance. */
  variantProperties?: Readonly<Record<string, string>>;
}>;

/** Simplified layout constraints for one Figma node. */
export type FigmaConstraintInfo = Readonly<{
  /** Horizontal constraint. */
  horizontal?: string;
  /** Vertical constraint. */
  vertical?: string;
}>;

/** Recursive Figma node used in imported design payloads. */
export type FigmaDesignNode = Readonly<{
  /** Stable node id. */
  id: string;
  /** Human-readable node name. */
  name: string;
  /** Figma node type. */
  type: string;
  /** Whether the node is visible. */
  visible: boolean;
  /** Absolute bounding box. */
  absoluteBoundingBox?: FigmaBoundingBox;
  /** Simplified auto-layout metadata. */
  layout?: FigmaLayoutInfo;
  /** Simplified style metadata. */
  style?: FigmaStyleInfo;
  /** Simplified text metadata. */
  text?: FigmaTextInfo;
  /** Simplified component metadata. */
  component?: FigmaComponentInfo;
  /** Layout constraints. */
  constraints?: FigmaConstraintInfo;
  /** Asset reference for vector/image previews. */
  assetRef?: string;
  /** Child nodes. */
  children?: readonly FigmaDesignNode[];
}>;

/** Imported Figma document payload stored by Galaxy. */
export type FigmaDesignDocument = Readonly<{
  /** Schema version for the exported document. */
  version: 1;
  /** Upstream design source identifier. */
  source: 'figma';
  /** Export timestamp in milliseconds. */
  exportedAt: number;
  /** Top-level selected nodes. */
  selection: readonly FigmaDesignNode[];
  /** Optional embedded asset previews. */
  assets?: readonly FigmaDesignAsset[];
  /** Optional Figma file key. */
  fileKey?: string;
  /** Optional page id. */
  pageId?: string;
  /** Optional page name. */
  pageName?: string;
}>;

/** Raw payload sent by the Figma bridge plugin into Galaxy. */
export type FigmaImportRequest = Readonly<{
  /** Source identifier for import validation. */
  source: 'figma-plugin';
  /** Optional workspace hint emitted by the plugin. */
  workspaceHint?: string;
  /** Exported Figma document payload. */
  document: FigmaDesignDocument;
}>;

/** Persisted record stored for one imported Figma payload. */
export type FigmaImportRecord = Readonly<{
  /** Stable import id assigned by Galaxy. */
  importId: string;
  /** Workspace storage id owning the record. */
  workspaceId: string;
  /** Import timestamp in milliseconds. */
  importedAt: number;
  /** Source identifier for the import. */
  source: 'figma-plugin';
  /** Optional workspace hint emitted by the plugin. */
  workspaceHint?: string;
  /** Short import summary used in UI and prompts. */
  summary: string;
  /** Exported Figma document payload. */
  document: FigmaDesignDocument;
}>;

/** Result returned by the bridge import handler after one successful import. */
export type FigmaBridgeImportResult = Readonly<{
  /** Stable Galaxy import id. */
  importId: string;
  /** Storage path where the import was persisted. */
  storedAt: string;
  /** Short summary of the imported design selection. */
  summary: string;
}>;

/** Handler invoked by the bridge server when a valid Figma payload is received. */
export type FigmaBridgeImportHandler = (payload: FigmaImportRequest) => Promise<FigmaBridgeImportResult>;

/** Running Figma bridge server handle. */
export type FigmaBridgeServer = Readonly<{
  /** Host address the bridge server is listening on. */
  host: string;
  /** TCP port the bridge server is listening on. */
  port: number;
  /** Stops the running bridge server. */
  stop(): Promise<void>;
}>;
