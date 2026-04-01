/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Local Ollama driver for the extension runtime.
 */

import { Ollama } from 'ollama';
import type { GalaxyConfig } from '../../shared/config';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../../shared/runtime';
import { buildFunctionTools } from './tool-schemas';
import { buildOllamaCompatibleMessages } from './message-builders';
import { buildDriverErrorChunk, createDoneEmitter } from './stream-utils';

/**
 * Creates the Ollama driver used by the extension runtime.
 *
 * @param model Optional model override selected by the user.
 * @param baseUrl Optional Ollama host override.
 * @param config Active Galaxy config used to build prompts and tool definitions.
 * @param allowTools Whether tool definitions should be exposed to the provider.
 * @returns Agent driver implementation for Ollama.
 */
export function createOllamaDriver(model: string | undefined, baseUrl: string | undefined, config: GalaxyConfig, allowTools = true): AgentDriver {
  const host = baseUrl ?? 'http://localhost:11434';
  const selectedModel = model ?? 'llama3.2';

  return {
    name: 'ollama',
    async chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void> {
      const client = new Ollama({ host });

      try {
        const tools = allowTools ? buildFunctionTools(config) : undefined;
        const emitDone = createDoneEmitter(onChunk);
        const stream = await client.chat({
          model: selectedModel,
          messages: buildOllamaCompatibleMessages('ollama', messages, config) as unknown as import('ollama').Message[],
          ...(tools ? { tools } : {}),
          think: /qwen|deepseek|r1/i.test(selectedModel) ? true : undefined,
          stream: true,
        } as never);

        for await (const chunk of stream) {
          if (chunk.message?.content) {
            onChunk({ type: 'text', delta: chunk.message.content });
          }

          const thinking = (chunk.message as { thinking?: string } | undefined)?.thinking;
          if (thinking) {
            onChunk({ type: 'thinking', delta: thinking });
          }

          if (chunk.message?.tool_calls) {
            for (const toolCall of chunk.message.tool_calls) {
              if (toolCall.function) {
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
      } catch (error) {
        onChunk(buildDriverErrorChunk(`Cannot connect to Ollama at ${host}. `, error));
      }
    },
  };
}
