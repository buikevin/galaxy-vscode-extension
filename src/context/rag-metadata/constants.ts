/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Constants used by the RAG metadata persistence layer.
 */

/**
 * Minimum assistant conclusion length required before persisting task memory.
 */
export const TASK_MEMORY_MIN_ASSISTANT_CHARS = 24;

/**
 * Retention window for task memory entries before pruning old rows.
 */
export const TASK_MEMORY_RETENTION_DAYS = 45;

/**
 * Hard cap on retained task memory entries per workspace.
 */
export const TASK_MEMORY_MAX_ENTRIES = 250;

/**
 * Batch size used when embedding task memory entries.
 */
export const TASK_MEMORY_EMBED_BATCH_SIZE = 24;

/**
 * Number of recent task memory entries considered during retrieval.
 */
export const TASK_MEMORY_SEMANTIC_CANDIDATE_LIMIT = 80;

/**
 * Timeout for best-effort task memory Chroma operations.
 */
export const TASK_MEMORY_CHROMA_TIMEOUT_MS = 1500;

/**
 * Manual Chroma embedding function placeholder used with precomputed vectors.
 */
export const MANUAL_EMBEDDING_FUNCTION = Object.freeze({
  name: 'galaxy-manual-embedding',
  async generate(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide embeddings explicitly.');
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide query embeddings explicitly.');
  },
});

