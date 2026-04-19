/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc OpenAI/Codex driver for the extension runtime.
 */

import type OpenAI from 'openai';
import type { GalaxyConfig } from '../../shared/config';
import { getConfigPath } from '../../config/manager';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../../shared/runtime';
import { buildFunctionTools } from './tool-schemas';
import { buildDriverSystemPrompt } from './message-builders';
import { buildOpenAIImageContentParts } from './image-content';
import { buildDriverErrorChunk, createDoneEmitter, parseToolArguments } from './stream-utils';

/**
 * Translates runtime messages into OpenAI chat-completions message payloads.
 *
 * @param messages Runtime transcript messages for the current turn.
 * @param config Active Galaxy config used to build the system prompt.
 * @returns API-ready OpenAI message payloads.
 */
function buildMessages(messages: readonly RuntimeMessage[], config: GalaxyConfig): OpenAI.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system' as const,
      content: buildDriverSystemPrompt('codex', config, messages),
    },
    ...messages.flatMap((message) => {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return [{
          role: 'assistant' as const,
          content: message.content || null,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.params),
            },
          })),
        }] as OpenAI.ChatCompletionMessageParam[];
      }

      if (message.role === 'tool') {
        if (!message.toolCallId) {
          return [];
        }

        return [{
          role: 'tool' as const,
          tool_call_id: message.toolCallId,
          content: message.content,
        }] as OpenAI.ChatCompletionMessageParam[];
      }

      if (message.role === 'user' && message.images?.length) {
        const contentParts: OpenAI.ChatCompletionContentPart[] = [];
        if (message.content) {
          contentParts.push({
            type: 'text',
            text: message.content,
          } as OpenAI.ChatCompletionContentPart);
        }
        contentParts.push(
          ...(buildOpenAIImageContentParts(
            message.images,
          ) as unknown as OpenAI.ChatCompletionContentPart[]),
        );
        return [{
          role: 'user' as const,
          content: contentParts,
        }] as OpenAI.ChatCompletionMessageParam[];
      }

      return [{
        role: (message.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: message.content,
      }] as OpenAI.ChatCompletionMessageParam[];
    }),
  ];
}

/**
 * Creates the Codex/OpenAI driver used by the extension runtime.
 *
 * @param apiKey OpenAI API key.
 * @param model Optional model override selected by the user.
 * @param config Active Galaxy config used to build prompts and tool definitions.
 * @param allowTools Whether tool definitions should be exposed to the provider.
 * @returns Agent driver implementation for OpenAI-compatible chat completions.
 */
export function createCodexDriver(apiKey: string | undefined, model: string | undefined, config: GalaxyConfig, allowTools = true): AgentDriver {
  const selectedModel = model ?? 'gpt-4o';

  return {
    name: 'codex',
    async chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void> {
      if (!apiKey) {
        onChunk({
          type: 'error',
          message: `OpenAI API key not configured in config file. Please check your Galaxy config at: ${getConfigPath()}`,
        });
        return;
      }

      try {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey });
        const tools = allowTools ? buildFunctionTools(config) : undefined;
        const stream = await client.chat.completions.create({
          model: selectedModel,
          messages: buildMessages(messages, config) as never,
          ...(tools ? { tools } : {}),
          stream: true,
        });

        const toolCallAccum: Record<number, { name: string; args: string }> = {};
        const emitDone = createDoneEmitter(onChunk);

        for await (const chunk of stream) {
          for (const choice of chunk.choices) {
            if (choice.delta.content) {
              onChunk({ type: 'text', delta: choice.delta.content });
            }

            if (choice.delta.tool_calls) {
              for (const toolCall of choice.delta.tool_calls) {
                const index = toolCall.index ?? 0;
                if (!toolCallAccum[index]) {
                  toolCallAccum[index] = { name: '', args: '' };
                }

                if (toolCall.function?.name) {
                  toolCallAccum[index]!.name += toolCall.function.name;
                }
                if (toolCall.function?.arguments) {
                  toolCallAccum[index]!.args += toolCall.function.arguments;
                }
              }
            }

            if (choice.finish_reason === 'tool_calls') {
              for (const entry of Object.values(toolCallAccum)) {
                onChunk({
                  type: 'tool_call',
                  call: {
                    name: entry.name,
                    params: parseToolArguments(entry.args),
                  },
                });
              }
            }

            if (choice.finish_reason === 'stop') {
              emitDone();
            }
          }
        }

        emitDone();
      } catch (error) {
        onChunk(buildDriverErrorChunk('OpenAI error: ', error));
      }
    },
  };
}
