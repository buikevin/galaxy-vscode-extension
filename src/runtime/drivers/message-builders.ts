/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared message and prompt builders for runtime drivers.
 */

import type { GalaxyConfig } from '../../shared/config';
import { buildSystemPrompt } from '../system-prompt';
import type { PromptContextHints, RuntimeMessage } from '../../shared/runtime';

/**
 * Derives compact turn hints from runtime messages so the system prompt can stay dynamic.
 *
 * @param messages Runtime transcript messages for the current turn.
 * @returns Turn-specific prompt hints inferred from current context blocks and attachments.
 */
export function derivePromptContextHints(
  messages: readonly RuntimeMessage[],
): PromptContextHints {
  const joinedContent = messages.map((message) => message.content).join('\n');
  const loweredContent = joinedContent.toLowerCase();
  const imageCount = messages.reduce((total, message) => total + (message.images?.length ?? 0), 0);
  const documentationMentions = [
    '.md',
    '.mdx',
    '.txt',
    '.rst',
    '.adoc',
    '[document semantic snippets]',
  ].filter((pattern) => loweredContent.includes(pattern)).length;

  return Object.freeze({
    hasImages: imageCount > 0,
    hasWorkflowContext: joinedContent.includes('[WORKFLOW GRAPH RETRIEVAL]'),
    hasPlatformContext: joinedContent.includes('[SYSTEM PLATFORM CONTEXT]'),
    hasBaseComponentProfile: joinedContent.includes('[BASE COMPONENT PROFILE]'),
    mentionsGalaxyDesign:
      loweredContent.includes('galaxy design') ||
      loweredContent.includes('galaxy_design_') ||
      joinedContent.includes('[BASE COMPONENT PROFILE]'),
    mentionsExtensionTools:
      loweredContent.includes('search_extension_tools') ||
      loweredContent.includes('activate_extension_tools') ||
      loweredContent.includes('vscode_') ||
      loweredContent.includes('problems panel') ||
      loweredContent.includes('references provider'),
    hasReviewContext:
      joinedContent.includes('[SYSTEM CODE REVIEW FEEDBACK]') ||
      joinedContent.includes('[OPEN FINDINGS TO CONTINUE]') ||
      joinedContent.includes('[LATEST REVIEW FINDINGS]'),
    hasDocumentEditLoop:
      documentationMentions > 0 &&
      loweredContent.includes('[relevant tool evidence]') &&
      loweredContent.includes('batch'),
  });
}

/**
 * Builds the provider-agnostic system prompt for a specific driver.
 *
 * @param agentType Driver name used to select prompt instructions.
 * @param config Active Galaxy config.
 * @param messages Runtime transcript messages for the current turn.
 * @returns System prompt string for the provider.
 */
export function buildDriverSystemPrompt(
  agentType: 'claude' | 'codex' | 'gemini' | 'manual' | 'ollama',
  config: GalaxyConfig,
  messages: readonly RuntimeMessage[],
): string {
  return buildSystemPrompt(agentType, config, derivePromptContextHints(messages));
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
    { role: 'system', content: buildDriverSystemPrompt(agentType, config, messages) },
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
