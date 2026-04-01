/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Resolve the correct runtime driver implementation for the selected agent type.
 */

import type { GalaxyConfig } from '../shared/config';
import type { AgentType } from '../shared/protocol';
import type { AgentDriver } from '../shared/runtime';
import { createClaudeDriver } from './drivers/claude';
import { createCodexDriver } from './drivers/codex';
import { createGeminiDriver } from './drivers/gemini';
import { createManualDriver } from './drivers/manual';
import { createOllamaDriver } from './drivers/ollama';

/**
 * Creates the runtime driver matching the selected agent type.
 *
 * @param config Active Galaxy configuration.
 * @param agentType Agent provider selected for the current turn.
 * @param allowTools Whether the driver should expose tool schemas.
 * @returns Provider-specific runtime driver.
 */
export function createDriver(config: GalaxyConfig, agentType: AgentType, allowTools = true): AgentDriver {
  const agentConfig = config.agent.find((agent) => agent.type === agentType);

  switch (agentType) {
    case 'claude':
      return createClaudeDriver(agentConfig?.apiKey, agentConfig?.model, config, allowTools);
    case 'gemini':
      return createGeminiDriver(agentConfig?.apiKey, agentConfig?.model, config, allowTools);
    case 'ollama':
      return createOllamaDriver(agentConfig?.model, agentConfig?.baseUrl, config, allowTools);
    case 'codex':
      return createCodexDriver(agentConfig?.apiKey, agentConfig?.model, config, allowTools);
    case 'manual':
    default:
      return createManualDriver(agentConfig?.apiKey, agentConfig?.model, agentConfig?.baseUrl, config, allowTools);
  }
}
