/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Gemini driver for the extension runtime.
 */

import type { GalaxyConfig } from '../../shared/config';
import { getConfigPath } from '../../config/manager';
import type { AgentDriver, RuntimeMessage, StreamHandler } from '../../shared/runtime';
import { buildGeminiFunctionDeclarations } from './tool-schemas';
import { buildDriverSystemPrompt } from './message-builders';
import { buildDriverErrorChunk, createDoneEmitter } from './stream-utils';

/**
 * Translates runtime messages into Gemini content parts.
 *
 * @param messages Runtime transcript messages for the current turn.
 * @returns API-ready Gemini content payloads.
 */
function buildContents(messages: readonly RuntimeMessage[]) {
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: unknown[] = [];
      if (message.content) {
        parts.push({ text: message.content });
      }
      for (const toolCall of message.toolCalls) {
        parts.push({
          functionCall: {
            name: toolCall.name,
            args: toolCall.params,
          },
        });
      }
      contents.push({ role: 'model', parts });
      index += 1;
      continue;
    }

    if (message.role === 'tool' && message.toolCallId) {
      const parts: unknown[] = [];
      while (index < messages.length && messages[index]!.role === 'tool') {
        const toolMessage = messages[index]!;
        if (toolMessage.toolCallId && toolMessage.toolName) {
          parts.push({
            functionResponse: {
              name: toolMessage.toolName,
              response: { result: toolMessage.content },
            },
          });
        }
        index += 1;
      }
      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
      continue;
    }

    if (message.role !== 'tool') {
      contents.push({
        role: message.role === 'user' ? 'user' : 'model',
        parts: [{ text: message.content }],
      });
    }
    index += 1;
  }

  return contents;
}

/**
 * Creates the Gemini driver used by the extension runtime.
 *
 * @param apiKey Google API key.
 * @param model Optional model override selected by the user.
 * @param config Active Galaxy config used to build prompts and tool definitions.
 * @param allowTools Whether tool definitions should be exposed to the provider.
 * @returns Agent driver implementation for Gemini.
 */
export function createGeminiDriver(apiKey: string | undefined, model: string | undefined, config: GalaxyConfig, allowTools = true): AgentDriver {
  const selectedModel = model ?? 'gemini-2.5-flash';

  return {
    name: 'gemini',
    async chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void> {
      if (!apiKey) {
        onChunk({
          type: 'error',
          message: `Gemini API key not configured in config file. Please check your Galaxy config at: ${getConfigPath()}`,
        });
        return;
      }

      try {
        const { GoogleGenAI } = await import('@google/genai');
        const client = new GoogleGenAI({ apiKey });
        const tools = allowTools ? buildGeminiFunctionDeclarations(config) : undefined;
        const streamResult = await client.models.generateContentStream({
          model: selectedModel,
          contents: buildContents(messages) as never,
          config: {
            systemInstruction: buildDriverSystemPrompt('gemini', config, messages),
            ...(tools ? { tools } : {}),
            maxOutputTokens: 4096,
          },
        });

        const emitDone = createDoneEmitter(onChunk);
        for await (const chunk of streamResult) {
          if (chunk.text) {
            onChunk({ type: 'text', delta: chunk.text });
          }

          if (chunk.functionCalls) {
            for (const functionCall of chunk.functionCalls) {
              onChunk({
                type: 'tool_call',
                call: {
                  name: functionCall.name ?? '',
                  params: (functionCall.args ?? {}) as Record<string, unknown>,
                },
              });
            }
          }
        }

        emitDone();
      } catch (error) {
        onChunk(buildDriverErrorChunk('Gemini error: ', error));
      }
    },
  };
}
