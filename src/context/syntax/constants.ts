/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Constants used by syntax-aware indexing and retrieval.
 */

/** Syntax index schema version persisted to disk. */
export const SYNTAX_INDEX_VERSION = 3;
/** Maximum files surfaced in the final syntax context block. */
export const MAX_CONTEXT_FILES = 6;
/** Maximum related definition/reference files added per primary file. */
export const MAX_RELATED_CONTEXT_FILES = 3;
/** Maximum symbol signatures rendered per file in the prompt. */
export const MAX_SYMBOLS_PER_FILE = 8;
/** Maximum primary/definition/reference symbol candidates retained. */
export const MAX_SYMBOL_CANDIDATES = 8;
/** Maximum focus symbols inferred from the query. */
export const MAX_FOCUS_SYMBOLS = 6;
/** Maximum import records retained per file. */
export const MAX_IMPORTS_PER_FILE = 6;
/** Maximum exported names retained per file. */
export const MAX_EXPORTS_PER_FILE = 8;
/** Maximum file size eligible for syntax indexing. */
export const MAX_FILE_BYTES = 256 * 1024;
/** Maximum directory count scanned during seed discovery. */
export const MAX_SCAN_DIRS = 48;
/** Maximum file count scanned during seed discovery. */
export const MAX_SCAN_FILES = 240;
/** Maximum seed files refreshed on each indexing pass. */
export const MAX_SEED_FILES = 12;
/** Maximum primary context files selected from candidates. */
export const MAX_PRIMARY_CONTEXT_FILES = 4;
/** Source suffixes supported by syntax indexing. */
export const SUPPORTED_SOURCE_SUFFIXES: readonly string[] = ['.d.ts', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'];
/** Directory names ignored when scanning a workspace. */
export const IGNORED_SEGMENTS = new Set(['.git', '.galaxy', 'node_modules', 'dist', 'build', 'out', 'coverage']);
/** Directory names scanned first because they usually contain relevant source. */
export const PREFERRED_DIR_NAMES: readonly string[] = ['src', 'app', 'server', 'client', 'components', 'packages', 'libs', 'lib', 'api', 'pages', 'routes', 'webview'];
