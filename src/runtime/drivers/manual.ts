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
    message.includes('und_err')
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

      const client = new Ollama({
        host,
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      for (let attempt = 0; attempt < MANUAL_DRIVER_RETRY_ATTEMPTS; attempt += 1) {
        const tools = allowTools ? buildFunctionTools(config) : undefined;
        let emittedAnyChunk = false;

        try {
          const emitDone = createDoneEmitter(onChunk);
          const stream = await client.chat({
            model: selectedModel,
            messages: buildOllamaCompatibleMessages('manual', messages, config) as unknown as import('ollama').Message[],
            ...(tools ? { tools } : {}),
            think: /qwen|deepseek|r1/i.test(selectedModel) ? true : undefined,
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
        }
      }
    },
  };
}
