/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions used by semantic indexing and retrieval.
 */

/**
 * Supported semantic chunk kinds produced by semantic indexing.
 */
export type SemanticChunkKind = 'code_symbol' | 'code_module' | 'doc_section';

/**
 * One normalized semantic chunk persisted in the semantic store.
 */
export type SemanticChunkRecord = Readonly<{
  /** Stable semantic chunk identifier. */
  id: string;
  /** Workspace-relative file path owning the chunk. */
  filePath: string;
  /** Display title for the chunk. */
  title: string;
  /** Chunk classification. */
  kind: SemanticChunkKind;
  /** Optional symbol name represented by the chunk. */
  symbolName?: string;
  /** Optional symbol kind represented by the chunk. */
  symbolKind?: string;
  /** Whether the represented symbol is exported. */
  exported?: boolean;
  /** 1-based starting line. */
  startLine?: number;
  /** 1-based ending line. */
  endLine?: number;
  /** Short description used during retrieval. */
  description?: string;
  /** Provenance of the description content. */
  descriptionSource?: 'comment' | 'signature' | 'module_overview' | 'section_title';
  /** Text excerpt stored for retrieval context. */
  excerpt: string;
  /** Lexical term weights derived from title/description/excerpt. */
  terms: Readonly<Record<string, number>>;
  /** Vector magnitude of the lexical term weights. */
  magnitude: number;
  /** Optional Gemini embedding vector. */
  embedding?: readonly number[];
  /** Embedding model used to create the vector. */
  embeddingModel?: string;
  /** Source file mtime in milliseconds. */
  mtimeMs: number;
  /** Timestamp when the chunk was indexed. */
  indexedAt: number;
}>;

/**
 * On-disk semantic store snapshot for one workspace.
 */
export type SemanticIndexStore = Readonly<{
  /** Storage schema version. */
  version: number;
  /** Absolute workspace path for the store. */
  workspacePath: string;
  /** Last store update timestamp in milliseconds. */
  updatedAt: number;
  /** Chunk map keyed by chunk identifier. */
  chunks: Readonly<Record<string, SemanticChunkRecord>>;
}>;

/**
 * Final semantic retrieval payload injected into the prompt.
 */
export type SemanticRetrievalResult = Readonly<{
  /** Human-readable retrieval summary block. */
  content: string;
  /** Detailed chunk excerpt block. */
  chunkContent: string;
  /** Token estimate for both blocks. */
  tokens: number;
  /** Number of retrieved entries. */
  entryCount: number;
  /** Candidate file paths surfaced by semantic retrieval. */
  candidatePaths: readonly string[];
}>;
