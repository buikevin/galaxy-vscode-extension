import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentType } from '../shared/protocol';
import { DEFAULT_CONFIG, type AgentConfig, type GalaxyConfig } from './types';

type RawGalaxyConfig = Partial<GalaxyConfig> & {
  review?: boolean;
  test?: boolean;
  git?: boolean;
};

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
    return {
      agent: parsed.agent ?? DEFAULT_CONFIG.agent,
      quality: {
        ...DEFAULT_CONFIG.quality,
        ...(parsed.quality ?? {}),
        ...(typeof parsed.review === 'boolean' ? { review: parsed.review } : {}),
        ...(typeof parsed.test === 'boolean' ? { test: parsed.test } : {}),
      },
      toolSafety: {
        ...DEFAULT_CONFIG.toolSafety,
        ...(parsed.toolSafety ?? {}),
        ...(typeof parsed.git === 'boolean' ? { enableGitWriteTools: parsed.git } : {}),
      },
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

  fs.writeFileSync(configPath, JSON.stringify({
    ...config,
    review: config.quality.review,
    test: config.quality.test,
    git: config.toolSafety.enableGitWriteTools,
  }, null, 2), 'utf-8');
}

export function getAgentConfig(config: GalaxyConfig, type: AgentType): AgentConfig | undefined {
  return config.agent.find((agent) => agent.type === type);
}
