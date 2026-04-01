/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Constants for managed project command execution in the VS Code runtime.
 */

/** Grace period for background startup commands before they are handed off. */
export const BACKGROUND_STARTUP_GRACE_MS = 15_000;
/** Grace period for finite async commands before they are handed off. */
export const ASYNC_COMMAND_HANDOFF_MS = 12_000;
/** Maximum number of output characters retained in the rolling capture buffer. */
export const MAX_CAPTURED_OUTPUT_CHARS = 20_000;
/** Maximum number of managed commands retained in memory. */
export const MAX_MANAGED_COMMANDS = 32;
/** Output heuristics that suggest a background server is ready for handoff. */
export const BACKGROUND_READY_PATTERNS: readonly RegExp[] = Object.freeze([
  /ready in \d+/i,
  /compiled successfully/i,
  /local:\s+https?:\/\//i,
  /listening on/i,
  /server running/i,
  /app ready/i,
  /tauri app started/i,
  /watching for file changes/i,
]);
/** Command patterns that are finite but should still be handed off asynchronously. */
export const ASYNC_FINITE_COMMAND_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+install\b/i,
  /\b(?:cargo|cargo-tauri|tauri)\s+(?:build|check|test)\b/i,
  /\b(?:pip|pip3|uv)\s+(?:install|sync)\b/i,
  /\b(?:poetry)\s+install\b/i,
]);
