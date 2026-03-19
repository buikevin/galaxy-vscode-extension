import type { AgentType } from '../shared/protocol';

export interface AgentConfig {
  type: AgentType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface QualityConfig {
  review: boolean;
  test: boolean;
}

export interface ToolSafetyConfig {
  enableGitWriteTools: boolean;
  enableDeletePathTool: boolean;
  enableProjectScaffoldTool: boolean;
  enableProjectCommandTool: boolean;
  requireApprovalForGitPull: boolean;
  requireApprovalForGitPush: boolean;
  requireApprovalForGitCheckout: boolean;
  requireApprovalForDeletePath: boolean;
  requireApprovalForScaffold: boolean;
  requireApprovalForProjectCommand: boolean;
}

export interface GalaxyConfig {
  agent: AgentConfig[];
  quality: QualityConfig;
  toolSafety: ToolSafetyConfig;
}

export const DEFAULT_CONFIG: GalaxyConfig = {
  agent: [
    { type: 'manual', apiKey: '' },
    { type: 'claude', model: 'claude-sonnet-4-5-20250929', apiKey: '' },
    { type: 'gemini', model: 'gemini-2.5-flash', apiKey: '' },
    { type: 'codex', model: 'gpt-4o', apiKey: '' },
    { type: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434' },
  ],
  quality: {
    review: true,
    test: true,
  },
  toolSafety: {
    enableGitWriteTools: true,
    enableDeletePathTool: false,
    enableProjectScaffoldTool: true,
    enableProjectCommandTool: true,
    requireApprovalForGitPull: true,
    requireApprovalForGitPush: true,
    requireApprovalForGitCheckout: true,
    requireApprovalForDeletePath: true,
    requireApprovalForScaffold: true,
    requireApprovalForProjectCommand: false,
  },
};
