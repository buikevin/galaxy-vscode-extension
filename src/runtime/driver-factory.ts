import type { GalaxyConfig } from '../config/types';
import type { AgentType } from '../shared/protocol';
import type { AgentDriver } from './types';
import { createClaudeDriver } from './drivers/claude';
import { createCodexDriver } from './drivers/codex';
import { createGeminiDriver } from './drivers/gemini';
import { createManualDriver } from './drivers/manual';
import { createOllamaDriver } from './drivers/ollama';

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
