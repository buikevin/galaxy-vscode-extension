/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Load, normalize, and persist Galaxy extension configuration from the user config directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentType } from '../shared/protocol';
import { DEFAULT_CONFIG } from '../shared/constants';
import type {
  AgentConfig,
  GalaxyConfig,
  RawGalaxyConfig,
  ToolCapabilityConfig,
  ValidationPreferencesConfig,
} from '../shared/config';

/**
 * Normalizes tool-capability flags while keeping dependent quality and safety toggles in sync.
 *
 * @param input Partial persisted capability map.
 * @param config Quality and tool-safety settings that drive derived capability flags.
 * @returns Fully populated tool-capability config.
 */
function normalizeToolCapabilities(
  input: Partial<ToolCapabilityConfig> | undefined,
  config: Pick<GalaxyConfig, 'quality' | 'toolSafety'>,
): ToolCapabilityConfig {
  return {
    ...DEFAULT_CONFIG.toolCapabilities,
    ...(input ?? {}),
    review: config.quality.review,
    validation: config.quality.test,
    runCommands: config.toolSafety.enableProjectCommandTool,
  };
}

/**
 * Normalizes built-in tool toggles by merging them with defaults.
 *
 * @param input Partial persisted tool-toggle map.
 * @returns Fully populated built-in tool-toggle config.
 */
function normalizeToolToggles(input: Partial<GalaxyConfig['toolToggles']> | undefined): GalaxyConfig['toolToggles'] {
  return {
    ...DEFAULT_CONFIG.toolToggles,
    ...(input ?? {}),
  };
}

/**
 * Freezes extension tool toggles so runtime code can treat them as immutable state.
 *
 * @param input Persisted extension-tool toggle state.
 * @returns Frozen extension-tool toggle map.
 */
function normalizeExtensionToolToggles(
  input: Readonly<Record<string, boolean>> | undefined,
): GalaxyConfig['extensionToolToggles'] {
  return Object.freeze({
    ...(input ?? {}),
  });
}

/**
 * Normalizes one unknown value into a frozen trimmed string list.
 *
 * @param value Raw persisted JSON value.
 * @returns Frozen list of non-empty strings.
 */
function normalizeStringList(value: unknown): readonly string[] {
  return Object.freeze(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [],
  );
}

/**
 * Normalizes validation command preferences by trimming and freezing each command list.
 *
 * @param input Partial persisted validation preferences.
 * @returns Fully normalized validation preferences.
 */
function normalizeValidationConfig(input: Partial<ValidationPreferencesConfig> | undefined): ValidationPreferencesConfig {
  return Object.freeze({
    lint: normalizeStringList(input?.lint),
    staticCheck: normalizeStringList(input?.staticCheck),
    test: normalizeStringList(input?.test),
    build: normalizeStringList(input?.build),
  });
}

/**
 * Resolves the per-user Galaxy config directory for the current operating system.
 *
 * @returns Absolute config directory path.
 */
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

/**
 * Resolves the JSON config file path inside the Galaxy config directory.
 *
 * @returns Absolute config file path.
 */
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * Loads Galaxy config from disk and repairs missing or malformed fields with defaults.
 *
 * @returns Fully normalized Galaxy config.
 */
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
      validation: normalizeValidationConfig(parsed.validation),
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

/**
 * Persists one normalized Galaxy config object to disk.
 *
 * @param config Config object to persist.
 */
export function saveConfig(config: GalaxyConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const normalizedConfig: GalaxyConfig = {
    ...config,
    toolCapabilities: normalizeToolCapabilities(config.toolCapabilities, config),
    validation: normalizeValidationConfig(config.validation),
    toolToggles: normalizeToolToggles(config.toolToggles),
    extensionToolToggles: normalizeExtensionToolToggles(config.extensionToolToggles),
  };

  const { availableExtensionToolGroups: _availableExtensionToolGroups, ...persistedConfig } = normalizedConfig;

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...persistedConfig,
        review: persistedConfig.quality.review,
        test: persistedConfig.quality.test,
        git: persistedConfig.toolSafety.enableGitWriteTools,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

/**
 * Finds one agent configuration by provider type.
 *
 * @param config Loaded Galaxy config.
 * @param type Agent provider to look up.
 * @returns Matching agent config when present.
 */
export function getAgentConfig(config: GalaxyConfig, type: AgentType): AgentConfig | undefined {
  return config.agent.find((agent) => agent.type === type);
}
