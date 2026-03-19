import type OpenAI from 'openai';
import type { GalaxyConfig } from '../../config/types';
import { getConfigPath } from '../../config/manager';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../types';
import { buildSystemPrompt } from '../system-prompt';
import { getEnabledToolDefinitions } from '../../tools/file-tools';

function buildMessages(messages: readonly RuntimeMessage[], config: GalaxyConfig): OpenAI.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system' as const,
      content: buildSystemPrompt('codex', config),
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

      return [{
        role: (message.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: message.content,
      }] as OpenAI.ChatCompletionMessageParam[];
    }),
  ];
}

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
        const stream = await client.chat.completions.create({
          model: selectedModel,
          messages: buildMessages(messages, config) as never,
          ...(tools ? { tools } : {}),
          stream: true,
        });

        const toolCallAccum: Record<number, { name: string; args: string }> = {};
        let doneSent = false;

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
                try {
                  onChunk({
                    type: 'tool_call',
                    call: {
                      name: entry.name,
                      params: JSON.parse(entry.args || '{}') as Record<string, unknown>,
                    },
                  });
                } catch {
                  onChunk({
                    type: 'tool_call',
                    call: {
                      name: entry.name,
                      params: {},
                    },
                  });
                }
              }
            }

            if (choice.finish_reason === 'stop' && !doneSent) {
              doneSent = true;
              onChunk({ type: 'done' });
            }
          }
        }

        if (!doneSent) {
          onChunk({ type: 'done' });
        }
      } catch (error) {
        onChunk({
          type: 'error',
          message: `OpenAI error: ${String(error).slice(0, 300)}`,
        });
      }
    },
  };
}
