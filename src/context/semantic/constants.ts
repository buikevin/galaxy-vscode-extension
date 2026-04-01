/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Constants used by semantic indexing and retrieval.
 */

/** Semantic index schema version persisted on disk. */
export const SEMANTIC_INDEX_VERSION = 3;
/** Maximum file size eligible for semantic indexing. */
export const MAX_FILE_BYTES = 256 * 1024;
/** Maximum chunks emitted for one file. */
export const MAX_CHUNKS_PER_FILE = 6;
/** Maximum semantic retrieval results injected into the prompt. */
export const MAX_RESULTS = 5;
/** Batch size used when embedding semantic chunks. */
export const EMBEDDING_BATCH_SIZE = 32;
/** Timeout for Chroma interactions during semantic sync/query. */
export const SEMANTIC_CHROMA_TIMEOUT_MS = 2500;
/** Maximum excerpt size stored per chunk. */
export const MAX_EXCERPT_CHARS = 280;
/** Maximum lexical terms retained per chunk vector. */
export const MAX_TERMS_PER_CHUNK = 48;
/** Maximum directories scanned when discovering document candidates. */
export const MAX_SCAN_DIRS = 24;
/** Maximum files scanned when discovering document candidates. */
export const MAX_SCAN_FILES = 120;
/** Documentation file suffixes supported by semantic indexing. */
export const DOC_SUFFIXES: readonly string[] = ['.md', '.mdx', '.txt', '.json', '.yaml', '.yml'];
/** Source file suffixes supported by semantic indexing. */
export const SOURCE_SUFFIXES: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'];
/** Stop words removed from lexical term vectors. */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then', 'than',
  'are', 'was', 'were', 'been', 'have', 'has', 'had', 'not', 'but', 'use', 'using',
  'your', 'you', 'they', 'them', 'their', 'file', 'files', 'code', 'will', 'just',
  'about', 'after', 'before', 'into', 'onto', 'over', 'under', 'also', 'each',
]);
/** Preferred directory names scanned first for semantic discovery. */
export const PREFERRED_DIR_NAMES: readonly string[] = ['docs', 'doc', 'spec', 'specs', 'src', 'app', 'packages', 'components', 'webview'];
/** Directory names ignored during semantic scanning. */
export const IGNORED_SEGMENTS = new Set(['.git', '.galaxy', 'node_modules', 'dist', 'build', 'out', 'coverage']);
/** Manual Chroma embedding function placeholder used with precomputed vectors. */
export const MANUAL_EMBEDDING_FUNCTION = Object.freeze({
  name: 'galaxy-manual-embedding',
  async generate(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide embeddings explicitly.');
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide query embeddings explicitly.');
  },
});
