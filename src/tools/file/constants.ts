/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Constants shared by VS Code file tools.
 */

/** File extensions eligible for recursive grep/text-file discovery. */
export const GREP_INCLUDE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.css', '.scss', '.html',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.dart',
]);

/** Maximum entries returned by `list_dir`. */
export const MAX_LIST_DIR_ENTRIES = 100;
/** Maximum recursive depth allowed by `list_dir`. */
export const MAX_LIST_DIR_DEPTH = 8;
/** Maximum grep hits returned to the model. */
export const MAX_GREP_HITS = 60;
/** Built-in Tavily API key fallback for web tools. */
export const TAVILY_API_KEY = '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';
