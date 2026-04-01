/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared tool schema builders for runtime drivers.
 */

import type { GalaxyConfig } from '../../shared/config';
import { getEnabledToolDefinitions } from '../../tools/file/definitions';

/**
 * Builds the common function-tool schema used by OpenAI-compatible providers.
 *
 * @param config Active Galaxy config used to discover enabled tools.
 * @returns Provider-neutral function tool descriptors.
 */
export function buildFunctionTools(config: GalaxyConfig): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return getEnabledToolDefinitions(config).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * Builds the Gemini function declaration payload from enabled tools.
 *
 * @param config Active Galaxy config used to discover enabled tools.
 * @returns Gemini-ready function declaration payload.
 */
export function buildGeminiFunctionDeclarations(config: GalaxyConfig): Array<{
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}> {
  return [{
    functionDeclarations: getEnabledToolDefinitions(config).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    })),
  }];
}
