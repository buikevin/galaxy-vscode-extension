/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared message and prompt builders for runtime drivers.
 */

import type { GalaxyConfig } from '../../shared/config';
import { buildSystemPrompt } from '../system-prompt';
import type { RuntimeMessage } from '../../shared/runtime';

/**
 * Builds the provider-agnostic system prompt for a specific driver.
 *
 * @param agentType Driver name used to select prompt instructions.
 * @param config Active Galaxy config.
 * @returns System prompt string for the provider.
 */
export function buildDriverSystemPrompt(
  agentType: 'claude' | 'codex' | 'gemini' | 'manual' | 'ollama',
  config: GalaxyConfig,
): string {
  return buildSystemPrompt(agentType, config);
}

/**
 * Builds the shared Ollama-compatible message format used by the local and manual drivers.
 *
 * @param agentType Driver name used to select prompt instructions.
 * @param messages Runtime transcript messages for the current turn.
 * @param config Active Galaxy config used to build the system prompt.
 * @returns API-ready message list for Ollama-compatible chat APIs.
 */
export function buildOllamaCompatibleMessages(
  agentType: 'manual' | 'ollama',
  messages: readonly RuntimeMessage[],
  config: GalaxyConfig,
): readonly Record<string, unknown>[] {
  return [
    { role: 'system', content: buildDriverSystemPrompt(agentType, config) },
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
