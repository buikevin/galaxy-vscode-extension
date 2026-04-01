/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared stream and error helpers for runtime drivers.
 */

import type { StreamChunk, StreamHandler } from '../../shared/runtime';

/**
 * Safely parses a JSON argument payload for tool calls.
 *
 * @param rawArguments Raw JSON string emitted by a provider.
 * @returns Parsed argument object or an empty object when parsing fails.
 */
export function parseToolArguments(rawArguments: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArguments || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Creates a handler that guarantees the `done` chunk is emitted at most once.
 *
 * @param onChunk Stream callback provided by the runtime.
 * @returns Callback used by drivers to signal completion exactly once.
 */
export function createDoneEmitter(onChunk: StreamHandler): () => void {
  let doneSent = false;
  return () => {
    if (doneSent) {
      return;
    }
    doneSent = true;
    onChunk({ type: 'done' });
  };
}

/**
 * Normalizes a provider error into a concise error stream chunk.
 *
 * @param prefix Provider-specific message prefix.
 * @param error Unknown provider error.
 * @returns Error stream chunk safe to surface in the UI.
 */
export function buildDriverErrorChunk(prefix: string, error: unknown): StreamChunk {
  return {
    type: 'error',
    message: `${prefix}${String(error).slice(0, 300)}`,
  };
}
