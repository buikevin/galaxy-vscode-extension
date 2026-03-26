import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentType } from '../shared/protocol';
import { DEFAULT_CONFIG, type AgentConfig, type GalaxyConfig, type ToolCapabilityConfig } from './types';

type RawGalaxyConfig = Partial<GalaxyConfig> & {
  review?: boolean;
  test?: boolean;
  git?: boolean;
};

function normalizeToolCapabilities(input: Partial<ToolCapabilityConfig> | undefined, config: Pick<GalaxyConfig, 'quality' | 'toolSafety'>): ToolCapabilityConfig {
  return {
    ...DEFAULT_CONFIG.toolCapabilities,
    ...(input ?? {}),
    review: config.quality.review,
    validation: config.quality.test,
    runCommands: config.toolSafety.enableProjectCommandTool,
  };
}

function normalizeToolToggles(input: Partial<GalaxyConfig['toolToggles']> | undefined): GalaxyConfig['toolToggles'] {
  return {
    ...DEFAULT_CONFIG.toolToggles,
    ...(input ?? {}),
  };
}

function normalizeExtensionToolToggles(
  input: Readonly<Record<string, boolean>> | undefined,
): GalaxyConfig['extensionToolToggles'] {
  return Object.freeze({
    ...(input ?? {}),
  });
}

export function getConfigDir(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), '.galaxy');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'galaxy');
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, 'galaxy');
  }

  return path.join(os.homedir(), '.config', 'galaxy');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): GalaxyConfig {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as RawGalaxyConfig;
    const quality = {
      ...DEFAULT_CONFIG.quality,
      ...(parsed.quality ?? {}),
      ...(typeof parsed.review === 'boolean' ? { review: parsed.review } : {}),
      ...(typeof parsed.test === 'boolean' ? { test: parsed.test } : {}),
    };
    const toolSafety = {
      ...DEFAULT_CONFIG.toolSafety,
      ...(parsed.toolSafety ?? {}),
      ...(typeof parsed.git === 'boolean' ? { enableGitWriteTools: parsed.git } : {}),
    };

    return {
      agent: parsed.agent ?? DEFAULT_CONFIG.agent,
      quality,
      maxToolRounds:
        typeof parsed.maxToolRounds === 'number' || parsed.maxToolRounds === null
          ? parsed.maxToolRounds
          : DEFAULT_CONFIG.maxToolRounds,
      toolSafety,
      toolCapabilities: normalizeToolCapabilities(parsed.toolCapabilities, { quality, toolSafety }),
      toolToggles: normalizeToolToggles(parsed.toolToggles),
      extensionToolToggles: normalizeExtensionToolToggles(parsed.extensionToolToggles),
    };
  } catch {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: GalaxyConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const normalizedConfig: GalaxyConfig = {
    ...config,
    toolCapabilities: normalizeToolCapabilities(config.toolCapabilities, config),
    toolToggles: normalizeToolToggles(config.toolToggles),
    extensionToolToggles: normalizeExtensionToolToggles(config.extensionToolToggles),
  };

  const { availableExtensionToolGroups: _availableExtensionToolGroups, ...persistedConfig } = normalizedConfig;

  fs.writeFileSync(configPath, JSON.stringify({
    ...persistedConfig,
    review: persistedConfig.quality.review,
    test: persistedConfig.quality.test,
    git: persistedConfig.toolSafety.enableGitWriteTools,
  }, null, 2), 'utf-8');
}

export function getAgentConfig(config: GalaxyConfig, type: AgentType): AgentConfig | undefined {
  return config.agent.find((agent) => agent.type === type);
}
