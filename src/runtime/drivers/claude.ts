import type Anthropic from '@anthropic-ai/sdk';
import type { GalaxyConfig } from '../../config/types';
import { getConfigPath } from '../../config/manager';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../types';
import { buildSystemPrompt } from '../system-prompt';
import { getEnabledToolDefinitions } from '../../tools/file-tools';

function buildMessages(messages: readonly RuntimeMessage[]) {
  const apiMessages: Array<Record<string, unknown>> = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content) {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.params,
        });
      }
      apiMessages.push({ role: 'assistant', content: blocks });
      index += 1;
      continue;
    }

    if (message.role === 'tool' && message.toolCallId) {
      const toolResults: Array<Record<string, unknown>> = [];
      while (index < messages.length && messages[index]!.role === 'tool') {
        const toolMessage = messages[index]!;
        if (toolMessage.toolCallId) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMessage.toolCallId,
            content: toolMessage.content,
          });
        }
        index += 1;
      }
      if (toolResults.length > 0) {
        apiMessages.push({ role: 'user', content: toolResults });
      }
      continue;
    }

    if (message.role !== 'tool') {
      apiMessages.push({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content,
      });
    }
    index += 1;
  }

  return apiMessages;
}

export function createClaudeDriver(apiKey: string | undefined, model: string | undefined, config: GalaxyConfig, allowTools = true): AgentDriver {
  const selectedModel = model ?? 'claude-sonnet-4-5-20250929';

  return {
    name: 'claude',
    async chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void> {
      if (!apiKey) {
        onChunk({
          type: 'error',
          message: `Claude API key not configured in config file. Please check your Galaxy config at: ${getConfigPath()}`,
        });
        return;
      }

      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        const tools = allowTools
          ? getEnabledToolDefinitions(config).map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Anthropic.Tool.InputSchema,
            }))
          : undefined;
        const stream = client.messages.stream({
          model: selectedModel,
          max_tokens: 4096,
          system: buildSystemPrompt('claude', config),
          messages: buildMessages(messages) as never,
          ...(tools ? { tools } : {}),
        } as never);

        let currentToolName = '';
        let currentToolInput = '';
        let inToolUse = false;
        let doneSent = false;

        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            inToolUse = true;
            currentToolName = event.content_block.name;
            currentToolInput = '';
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            onChunk({ type: 'text', delta: event.delta.text });
          } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json;
          } else if (event.type === 'content_block_stop' && inToolUse && currentToolName) {
            try {
              onChunk({
                type: 'tool_call',
                call: {
                  name: currentToolName,
                  params: JSON.parse(currentToolInput || '{}') as Record<string, unknown>,
                },
              });
            } catch {
              onChunk({
                type: 'tool_call',
                call: {
                  name: currentToolName,
                  params: {},
                },
              });
            }
            inToolUse = false;
            currentToolName = '';
            currentToolInput = '';
          }

          if (event.type === 'message_stop' && !doneSent) {
            doneSent = true;
            onChunk({ type: 'done' });
          }
        }

        if (!doneSent) {
          onChunk({ type: 'done' });
        }
      } catch (error) {
        onChunk({
          type: 'error',
          message: `Claude error: ${String(error).slice(0, 300)}`,
        });
      }
    },
  };
}
