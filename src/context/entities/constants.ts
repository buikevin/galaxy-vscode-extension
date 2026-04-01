/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared context-level constants used across context, semantic retrieval, and history flows.
 */

/**
 * Loopback host used for locally managed Chroma instances.
 */
export const CHROMA_HOST = '127.0.0.1';

/**
 * First candidate port in the local Chroma allocation range.
 */
export const CHROMA_PORT_BASE = 41000;

/**
 * Width of the local Chroma port allocation range.
 */
export const CHROMA_PORT_RANGE = 20000;

/**
 * Maximum number of candidate ports scanned before giving up.
 */
export const CHROMA_PORT_SCAN_LIMIT = 256;

/**
 * Timeout for probing local port and heartbeat health.
 */
export const CHROMA_HEALTH_TIMEOUT_MS = 750;

/**
 * Maximum time spent waiting for a spawned local Chroma instance to become healthy.
 */
export const CHROMA_START_TIMEOUT_MS = 8000;

/**
 * Poll interval used while waiting for local Chroma startup health.
 */
export const CHROMA_POLL_INTERVAL_MS = 200;

/**
 * Hard ceiling for prompt token usage before compaction becomes mandatory.
 */
export const MAX_TOKENS = 256_000;

/**
 * Preferred prompt budget before emergency pressure starts.
 */
export const SOFT_PROMPT_TOKENS = 228_000;

/**
 * Threshold that marks the prompt as near capacity.
 */
export const HARD_PROMPT_TOKENS = 238_000;

/**
 * Minimum budget reserved for the active working turn after compaction.
 */
export const MIN_WORKING_CONTEXT_TOKENS = 64_000;

/**
 * Character-to-token fallback ratio used when a tokenizer is unavailable.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.5;

/**
 * Maximum input size eligible for token count memoization.
 */
export const MAX_CACHED_TEXT_CHARS = 12_000;

/**
 * Maximum number of token count entries kept in the in-memory LRU-like cache.
 */
export const TOKEN_CACHE_LIMIT = 256;

/**
 * Target size for one semantic document chunk before splitting.
 */
export const DOCUMENT_CHUNK_TARGET_CHARS = 1_400;

/**
 * Minimum size preferred for one semantic document chunk.
 */
export const DOCUMENT_CHUNK_MIN_CHARS = 240;

/**
 * Number of trailing characters reused between adjacent document chunks.
 */
export const DOCUMENT_CHUNK_OVERLAP_CHARS = 180;

/**
 * Timeout for Chroma operations used by document semantic retrieval.
 */
export const DOCUMENT_CHROMA_TIMEOUT_MS = 2_500;

/**
 * Timeout for resolving the active Chroma endpoint before falling back locally.
 */
export const DOCUMENT_CHROMA_RESOLVE_TIMEOUT_MS = 600;

/**
 * Cache offset used for whole-document source snapshots.
 */
export const DOCUMENT_SOURCE_CACHE_OFFSET = 0;

/**
 * Cache limit used for whole-document source snapshots.
 */
export const DOCUMENT_SOURCE_CACHE_LIMIT = 0;

/**
 * Gemini embedding model name used for semantic retrieval.
 */
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Timeout applied to one Gemini embedding request.
 */
export const EMBEDDING_TIMEOUT_MS = 2500;

/**
 * Soft token budget for active task memory compaction.
 */
export const ACTIVE_TASK_MEMORY_SOFT_LIMIT = 32_000;

/**
 * Soft token budget for long-lived project memory compaction.
 */
export const PROJECT_MEMORY_SOFT_LIMIT = 24_000;

/**
 * Maximum number of list entries retained in normalized active task memory sections.
 */
export const MAX_ACTIVE_LIST_ITEMS = 8;

/**
 * Maximum number of key file paths retained in normalized memory sections.
 */
export const MAX_KEY_FILES = 12;

/**
 * Maximum number of recent project decisions retained in project memory.
 */
export const MAX_PROJECT_DECISIONS = 10;

/**
 * Maximum length of the persisted project summary text.
 */
export const MAX_PROJECT_SUMMARY_CHARS = 3_200;

/**
 * Maximum length of the persisted working-turn handoff summary.
 */
export const MAX_HANDOFF_SUMMARY_CHARS = 900;

/**
 * Canonical notes file name stored under the shared config directory.
 */
export const NOTES_FILE = 'NOTE.md';

/**
 * Current storage layout version for workspace project metadata.
 */
export const STORAGE_VERSION = 1;

/**
 * Maximum number of recent tool evidence rows loaded from the JSONL store.
 */
export const MAX_RECENT_EVIDENCE = 80;

/**
 * Transcript size below which the full JSONL file is read directly.
 */
export const FULL_READ_THRESHOLD_BYTES = 256 * 1024;

/**
 * Tail size read from large transcript files for efficient recent-history loading.
 */
export const TAIL_READ_BYTES = 128 * 1024;

/**
 * Soft token budget reserved for evidence blocks injected into prompt context.
 */
export const MAX_EVIDENCE_TOKENS = 1200;
