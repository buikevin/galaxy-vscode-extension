import type { ChatMessage } from '../shared/protocol';

export const MAX_TOKENS = 256_000;
export const SOFT_PROMPT_TOKENS = 228_000;
export const HARD_PROMPT_TOKENS = 238_000;
export const MIN_WORKING_CONTEXT_TOKENS = 64_000;
const FALLBACK_CHARS_PER_TOKEN = 3.5;
const MAX_CACHED_TEXT_CHARS = 12_000;
const TOKEN_CACHE_LIMIT = 256;

type TokenEncoder = Readonly<{
  encode(text: string): ArrayLike<number>;
}>;

let encoder: TokenEncoder | null = null;
const tokenCache = new Map<string, number>();

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

function estimateTokensFallback(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

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

export function countContextTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
