/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Token estimation helpers and working-context compaction utilities.
 */

import type { ChatMessage } from '../shared/protocol';
import {
  FALLBACK_CHARS_PER_TOKEN,
  HARD_PROMPT_TOKENS,
  MAX_CACHED_TEXT_CHARS,
  MAX_TOKENS,
  MIN_WORKING_CONTEXT_TOKENS,
  SOFT_PROMPT_TOKENS,
  TOKEN_CACHE_LIMIT,
} from './entities/constants';
import type { TokenEncoder } from './entities/compaction';

let encoder: TokenEncoder | null = null;
const tokenCache = new Map<string, number>();

/**
 * Lazily creates the tokenizer used for precise token estimates.
 */
function getEncoder(): TokenEncoder | null {
  if (encoder) {
    return encoder;
  }

  try {
    const { Tiktoken: TiktokenCtor } = require('js-tiktoken/lite') as {
      Tiktoken: new (ranks: object) => TokenEncoder;
    };
    const { default: o200k_base } = require('js-tiktoken/ranks/o200k_base') as {
      default: object;
    };
    encoder = new TiktokenCtor(o200k_base);
    return encoder;
  } catch {
    return null;
  }
}

/**
 * Estimates token count using a character heuristic when tokenizer loading fails.
 */
function estimateTokensFallback(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

/**
 * Stores token counts for short inputs to avoid repeated encoding work.
 */
function rememberTokenCount(text: string, tokens: number): void {
  if (!text || text.length > MAX_CACHED_TEXT_CHARS) {
    return;
  }

  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldestKey = tokenCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      tokenCache.delete(oldestKey);
    }
  }

  tokenCache.set(text, tokens);
}

/**
 * Estimates the token count for one text fragment.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  const cached = tokenCache.get(text);
  if (typeof cached === 'number') {
    return cached;
  }

  const encoding = getEncoder();
  const tokens = encoding ? encoding.encode(text).length : estimateTokensFallback(text);
  rememberTokenCount(text, tokens);
  return tokens;
}

/**
 * Sums token estimates for the current prompt context.
 */
export function countContextTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

/**
 * Restricts a numeric value to a closed interval.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes the budget reserved for the active working turn inside the prompt.
 */
export function computeWorkingContextBudget(opts: {
  promptTokensEstimate: number;
  workingTurnTokens: number;
}): number {
  const nonWorkingTokens = Math.max(0, opts.promptTokensEstimate - opts.workingTurnTokens);
  return clamp(
    SOFT_PROMPT_TOKENS - nonWorkingTokens,
    MIN_WORKING_CONTEXT_TOKENS,
    MAX_TOKENS,
  );
}
