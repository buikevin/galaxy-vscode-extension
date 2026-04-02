/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-02
 * @desc Centralized workflow constants and runtime thresholds.
 */

/**
 * Maximum number of directories scanned while building a workflow snapshot.
 */
export const MAX_SCAN_DIRS = 72;

/**
 * Maximum number of source files scanned while building a workflow snapshot.
 */
export const MAX_SCAN_FILES = 320;

/**
 * Maximum supported source file size for workflow parsing.
 */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * Source suffixes considered eligible for any workflow extraction adapter.
 */
export const SUPPORTED_SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.java', '.py', '.go', '.rs', '.dart', '.php'];

/**
 * Source suffixes parsed by the TypeScript and JavaScript generic extractor.
 */
export const TYPESCRIPT_SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directory names excluded from workflow source scanning because they are generated output,
 * dependency caches, or workspace metadata that would pollute graph extraction.
 */
export const IGNORED_SEGMENTS = new Set([
  '.git',
  '.galaxy',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
]);

/**
 * HTTP method names used to detect route registrations and fetch calls.
 */
export const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

/**
 * Method names treated as database queries during workflow extraction.
 */
export const DB_QUERY_METHODS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'query',
  'queryRaw',
  '$queryRaw',
  'execute',
  'executeRaw',
  '$executeRaw',
  'insert',
  'select',
  'save',
  'remove',
  'aggregate',
  'count',
]);

/**
 * Method names treated as queue publish operations.
 */
export const QUEUE_PUBLISH_METHODS = new Set(['publish', 'emit', 'enqueue', 'add', 'produce', 'send']);

/**
 * Method names treated as queue or message consume operations.
 */
export const QUEUE_CONSUME_METHODS = new Set(['consume', 'subscribe', 'process', 'handle', 'onMessage']);

/**
 * Method names treated as scheduler registration operations.
 */
export const SCHEDULE_METHODS = new Set(['schedule', 'cron', 'addCronJob', 'registerCron']);

/**
 * Node categories that can become workflow map entry points.
 */
export const WORKFLOW_MAP_ENTRY_TYPES = new Set([
  'screen',
  'component',
  'entrypoint',
  'api_endpoint',
  'rpc_endpoint',
  'webhook_handler',
  'controller',
  'worker',
  'job',
  'message_handler',
  'queue_topic',
  'desktop_entrypoint',
]);

/**
 * Maximum number of workflow artifacts generated from a single snapshot.
 */
export const MAX_WORKFLOW_ARTIFACTS = 18;

/**
 * Maximum number of summarized steps retained in workflow map text.
 */
export const MAX_WORKFLOW_SUMMARY_STEPS = 4;

/**
 * Maximum number of steps retained in workflow trace narratives.
 */
export const MAX_WORKFLOW_TRACE_STEPS = 6;

/**
 * Default debounce delay before a background workflow refresh runs.
 */
export const DEFAULT_WORKFLOW_REFRESH_DELAY_MS = 900;

/**
 * Maximum number of workflow artifacts embedded in a single batch request.
 */
export const WORKFLOW_ARTIFACT_EMBED_BATCH_SIZE = 12;

/**
 * Timeout for Chroma operations used by workflow artifact sync and query.
 */
export const WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS = 1200;

/**
 * Timeout for embedding a workflow retrieval query.
 */
export const WORKFLOW_ARTIFACT_QUERY_EMBED_TIMEOUT_MS = 900;

/**
 * Maximum file lines allowed before a raw reread is considered too broad.
 */
export const MAX_UNTARGETED_FILE_LINES = 120;

/**
 * Maximum document characters allowed before a raw reread is considered too broad.
 */
export const MAX_UNTARGETED_DOCUMENT_CHARS = 12_000;

/**
 * Manual embedding adapter passed to Chroma because embeddings are supplied externally.
 */
export const MANUAL_WORKFLOW_EMBEDDING_FUNCTION = Object.freeze({
  name: 'galaxy-manual-embedding',
  async generate(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide embeddings explicitly.');
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide query embeddings explicitly.');
  },
});
