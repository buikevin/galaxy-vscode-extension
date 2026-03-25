import { Ollama } from 'ollama';
import type { GalaxyConfig } from '../../config/types';
import { getConfigPath } from '../../config/manager';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../types';
import { buildSystemPrompt } from '../system-prompt';
import { getEnabledToolDefinitions } from '../../tools/file-tools';

const MANUAL_RETRY_ATTEMPTS = 2;
const MANUAL_RETRY_DELAY_MS = 800;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildApiMessages(messages: readonly RuntimeMessage[], config: GalaxyConfig) {
  return [
    { role: 'system', content: buildSystemPrompt('manual', config) },
    ...messages.flatMap((message): Array<Record<string, unknown>> => {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return [{
          role: 'assistant',
          content: message.content || '',
          tool_calls: message.toolCalls.map((toolCall) => ({
            function: {
              name: toolCall.name,
              arguments: toolCall.params,
            },
          })),
        }];
      }

      if (message.role === 'tool') {
        if (!message.toolName) {
          return [];
        }

        return [{
          role: 'tool',
          content: message.content,
          tool_name: message.toolName,
        }];
      }

      if (message.role === 'user' && message.images?.length) {
        return [{
          role: message.role,
          content: message.content,
          images: [...message.images],
        }];
      }

      return [{
        role: message.role,
        content: message.content,
      }];
    }),
  ];
}

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

      for (let attempt = 0; attempt < MANUAL_RETRY_ATTEMPTS; attempt += 1) {
        const tools = allowTools
          ? getEnabledToolDefinitions(config).map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters as Record<string, unknown>,
              },
            }))
          : undefined;
        let emittedAnyChunk = false;

        try {
          const stream = await client.chat({
            model: selectedModel,
            messages: buildApiMessages(messages, config) as unknown as import('ollama').Message[],
            ...(tools ? { tools } : {}),
            think: /qwen|deepseek|r1/i.test(selectedModel) ? true : undefined,
            stream: true,
          } as never);

          let doneSent = false;

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

            if (chunk.done && !doneSent) {
              doneSent = true;
              onChunk({ type: 'done' });
            }
          }

          if (!doneSent) {
            onChunk({ type: 'done' });
          }
          return;
        } catch (error) {
          const shouldRetry =
            !emittedAnyChunk &&
            attempt < MANUAL_RETRY_ATTEMPTS - 1 &&
            isRetryableManualError(error);
          if (shouldRetry) {
            await sleep(MANUAL_RETRY_DELAY_MS * (attempt + 1));
            continue;
          }

          onChunk({
            type: 'error',
            message: `Manual agent error: ${String(error)}`,
          });
          return;
        }
      }
    },
  };
}
