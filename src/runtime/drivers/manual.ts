/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Manual driver for the extension runtime, backed by the hosted Ollama-compatible API.
 */

import { Ollama } from 'ollama';
import type { GalaxyConfig } from '../../shared/config';
import { getConfigPath } from '../../config/manager';
import {
  MANUAL_DRIVER_RETRY_ATTEMPTS,
  MANUAL_DRIVER_RETRY_DELAY_MS,
} from '../../shared/constants';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../../shared/runtime';
import { getSubagentChatTimeoutMs, getSubagentRetryModels } from '../../shared/subagents';
import { buildFunctionTools } from './tool-schemas';
import { buildOllamaCompatibleMessages } from './message-builders';
import { buildDriverErrorChunk, createDoneEmitter } from './stream-utils';

/**
 * Determines whether a manual-driver error is transient enough to retry.
 *
 * @param error Unknown error thrown by the chat client.
 * @returns `true` when the error looks network-related and worth retrying.
 */
function isRetryableManualError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('terminated') ||
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('aborterror') ||
    message.includes('und_err') ||
    message.includes('internal server error') ||
    message.includes('status 500') ||
    message.includes('http 500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  );
}

/**
 * Waits for a short retry backoff interval.
 *
 * @param ms Delay duration in milliseconds.
 * @returns Promise resolved after the delay elapses.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = init?.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      if (!controller.signal.aborted) {
        clearTimeout(timeout);
      }
    }
  }) as typeof fetch;
}

/**
 * Creates the manual driver used by the extension runtime.
 *
 * @param apiKey API key configured for the manual provider.
 * @param model Optional model override selected by the user.
 * @param baseUrl Optional host override for Ollama-compatible backends.
 * @param config Active Galaxy config used to build prompts and tool definitions.
 * @param allowTools Whether tool definitions should be exposed to the provider.
 * @returns Agent driver implementation for the manual provider.
 */
export function createManualDriver(
  apiKey: string | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
  config: GalaxyConfig,
  allowTools = true,
): AgentDriver {
  const host = baseUrl?.replace(/\/$/, '') ?? 'https://ollama.com';
  const selectedModel = model ?? 'qwen3.5:397b-cloud';
  const retryModels = getSubagentRetryModels(config, selectedModel);

  return {
    name: 'manual',
    async chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void> {
      if (!apiKey) {
        onChunk({
          type: 'error',
          message: `Manual agent requires an API key in config file. Please check your Galaxy config at: ${getConfigPath()}`,
        });
        return;
      }

      const chatTimeoutMs = getSubagentChatTimeoutMs(config);
      const client = new Ollama({
        host,
        headers: { Authorization: `Bearer ${apiKey}` },
        ...(chatTimeoutMs ? { fetch: createTimeoutFetch(chatTimeoutMs) } : {}),
      });

      for (let attempt = 0; attempt < MANUAL_DRIVER_RETRY_ATTEMPTS; attempt += 1) {
        const attemptModel = retryModels[Math.min(attempt, retryModels.length - 1)] ?? selectedModel;
        const enableThink = !config.activeSubagentRole && /qwen|deepseek|r1/i.test(attemptModel);
        const tools = allowTools ? buildFunctionTools(config) : undefined;
        let emittedAnyChunk = false;
        let timedOut = false;
        const timeout = chatTimeoutMs
          ? setTimeout(() => {
              timedOut = true;
              client.abort();
            }, chatTimeoutMs)
          : null;
        timeout?.unref?.();

        try {
          const emitDone = createDoneEmitter(onChunk);
          const stream = await client.chat({
            model: attemptModel,
            messages: buildOllamaCompatibleMessages('manual', messages, config) as unknown as import('ollama').Message[],
            ...(tools ? { tools } : {}),
            think: enableThink,
            stream: true,
          } as never);

          for await (const chunk of stream) {
            if (chunk.message?.content) {
              emittedAnyChunk = true;
              onChunk({ type: 'text', delta: chunk.message.content });
            }

            const thinking = (chunk.message as { thinking?: string } | undefined)?.thinking;
            if (thinking) {
              emittedAnyChunk = true;
              onChunk({ type: 'thinking', delta: thinking });
            }

            if (chunk.message?.tool_calls) {
              for (const toolCall of chunk.message.tool_calls) {
                if (toolCall.function) {
                  emittedAnyChunk = true;
                  onChunk({
                    type: 'tool_call',
                    call: {
                      name: toolCall.function.name,
                      params: (toolCall.function.arguments ?? {}) as Record<string, unknown>,
                    },
                  });
                }
              }
            }

            if (chunk.done) {
              emitDone();
            }
          }

          emitDone();
          return;
        } catch (error) {
          if (timedOut && !emittedAnyChunk && attempt < MANUAL_DRIVER_RETRY_ATTEMPTS - 1) {
            await sleep(MANUAL_DRIVER_RETRY_DELAY_MS * (attempt + 1));
            continue;
          }
          if (timedOut || String(error).toLowerCase().includes('abort')) {
            onChunk(buildDriverErrorChunk(`Manual agent timed out after ${chatTimeoutMs}ms. `, error));
            return;
          }
          const shouldRetry =
            !emittedAnyChunk &&
            attempt < MANUAL_DRIVER_RETRY_ATTEMPTS - 1 &&
            isRetryableManualError(error);
          if (shouldRetry) {
            await sleep(MANUAL_DRIVER_RETRY_DELAY_MS * (attempt + 1));
            continue;
          }

          onChunk(buildDriverErrorChunk('Manual agent error: ', error));
          return;
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      }
    },
  };
}
