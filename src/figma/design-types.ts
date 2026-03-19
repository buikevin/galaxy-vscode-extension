export type FigmaDesignAsset = Readonly<{
  id: string;
  kind: 'svg' | 'png';
  name: string;
  contentBase64: string;
}>;

export type FigmaBoundingBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type FigmaLayoutInfo = Readonly<{
  mode?: 'none' | 'horizontal' | 'vertical';
  wrap?: boolean;
  gap?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  alignMain?: string;
  alignCross?: string;
  sizingHorizontal?: 'hug' | 'fill' | 'fixed';
  sizingVertical?: 'hug' | 'fill' | 'fixed';
}>;

export type FigmaStyleInfo = Readonly<{
  fills?: readonly unknown[];
  strokes?: readonly unknown[];
  strokeWidth?: number;
  radius?: number | Readonly<{ tl: number; tr: number; br: number; bl: number }>;
  opacity?: number;
  effects?: readonly unknown[];
}>;

export type FigmaTextInfo = Readonly<{
  characters: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
}>;

export type FigmaComponentInfo = Readonly<{
  componentKey?: string;
  componentName?: string;
  variantProperties?: Readonly<Record<string, string>>;
}>;

export type FigmaConstraintInfo = Readonly<{
  horizontal?: string;
  vertical?: string;
}>;

export type FigmaDesignNode = Readonly<{
  id: string;
  name: string;
  type: string;
  visible: boolean;
  absoluteBoundingBox?: FigmaBoundingBox;
  layout?: FigmaLayoutInfo;
  style?: FigmaStyleInfo;
  text?: FigmaTextInfo;
  component?: FigmaComponentInfo;
  constraints?: FigmaConstraintInfo;
  assetRef?: string;
  children?: readonly FigmaDesignNode[];
}>;

export type FigmaDesignDocument = Readonly<{
  version: 1;
  source: 'figma';
  exportedAt: number;
  selection: readonly FigmaDesignNode[];
  assets?: readonly FigmaDesignAsset[];
  fileKey?: string;
  pageId?: string;
  pageName?: string;
}>;

export type FigmaImportRequest = Readonly<{
  source: 'figma-plugin';
  workspaceHint?: string;
  document: FigmaDesignDocument;
}>;

export type FigmaImportRecord = Readonly<{
  importId: string;
  workspaceId: string;
  importedAt: number;
  source: 'figma-plugin';
  workspaceHint?: string;
  summary: string;
  document: FigmaDesignDocument;
}>;
