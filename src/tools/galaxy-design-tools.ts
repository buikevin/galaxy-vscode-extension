import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ToolResult } from './file-tools';

export type GalaxyDesignFramework =
  | 'react'
  | 'nextjs'
  | 'vue'
  | 'nuxtjs'
  | 'angular'
  | 'react-native'
  | 'flutter';

export type GalaxyDesignRunner = 'bun' | 'pnpm' | 'yarn' | 'npm';

type GalaxyDesignCanonicalFramework =
  | 'react'
  | 'vue'
  | 'angular'
  | 'react-native'
  | 'flutter';

type RegistryComponent = Readonly<{
  name?: string;
  type?: string;
  description?: string;
  files?: readonly string[];
  dependencies?: readonly string[];
  devDependencies?: readonly string[];
  peerDependencies?: readonly string[];
  registryDependencies?: readonly string[];
  category?: string;
  props?: readonly Readonly<Record<string, unknown>>[];
}>;

type RegistryGroup = Readonly<{
  name?: string;
  description?: string;
  components?: readonly string[];
}>;

type GalaxyDesignRegistry = Readonly<{
  $schema?: string;
  name?: string;
  version?: string;
  platform?: string;
  components: Readonly<Record<string, RegistryComponent>>;
  groups: Readonly<Record<string, RegistryGroup>>;
}>;

export type GalaxyDesignProjectInfo = Readonly<{
  targetPath: string;
  framework: GalaxyDesignFramework | 'unknown';
  packageManager: GalaxyDesignRunner;
  packageManagerSource:
    | 'package-json'
    | 'bun-lock'
    | 'pnpm-lock'
    | 'yarn-lock'
    | 'npm-lock'
    | 'fallback';
  galaxyDesignInitialized: boolean;
  componentsConfigPath?: string;
  registryFramework?: GalaxyDesignCanonicalFramework;
}>;

export type GalaxyDesignActionPlan = Readonly<{
  action: 'init' | 'add';
  targetPath: string;
  framework: GalaxyDesignFramework;
  registryFramework: GalaxyDesignCanonicalFramework;
  packageManager: GalaxyDesignRunner;
  runnerPackageManager: GalaxyDesignRunner;
  packageManagerSource: GalaxyDesignProjectInfo['packageManagerSource'];
  componentsConfigExists: boolean;
  executable: string;
  args: readonly string[];
  commandPreview: string;
  components: readonly string[];
}>;

const GALAXY_DESIGN_VERSION = '0.2.71';
const UNPKG_BASE = `https://unpkg.com/galaxy-design@${GALAXY_DESIGN_VERSION}/dist`;
const TOOL_PACKAGE_SPEC = `galaxy-design@${GALAXY_DESIGN_VERSION}`;
const LOCAL_REGISTRY_DIR = path.resolve(__dirname, '../../../galaxy-design-cli/dist');

const REGISTRY_FILE_BY_FRAMEWORK: Readonly<Record<GalaxyDesignCanonicalFramework, string>> = Object.freeze({
  react: 'registry-react.json',
  vue: 'registry-vue.json',
  angular: 'registry-angular.json',
  'react-native': 'registry-react-native.json',
  flutter: 'registry-flutter.json',
});

function isWithinDirectory(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath?: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = path.resolve(rawPath?.trim() ? path.resolve(workspaceRoot, rawPath) : workspaceRoot);
  if (!isWithinDirectory(resolved, workspaceRoot)) {
    return {
      ok: false,
      error: `Galaxy Design tools must stay inside the current workspace: ${workspaceRoot}`,
    };
  }
  return { ok: true, value: resolved };
}

function canonicalFramework(framework: GalaxyDesignFramework): GalaxyDesignCanonicalFramework {
  if (framework === 'nextjs') {
    return 'react';
  }
  if (framework === 'nuxtjs') {
    return 'vue';
  }
  return framework;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectFramework(targetPath: string): GalaxyDesignFramework | 'unknown' {
  const componentsConfigPath = path.join(targetPath, 'components.json');
  const componentsConfig = readJsonFile(componentsConfigPath);
  const configuredFramework = componentsConfig?.framework;
  if (
    configuredFramework === 'react' ||
    configuredFramework === 'nextjs' ||
    configuredFramework === 'vue' ||
    configuredFramework === 'nuxtjs' ||
    configuredFramework === 'angular' ||
    configuredFramework === 'react-native' ||
    configuredFramework === 'flutter'
  ) {
    return configuredFramework;
  }

  if (fs.existsSync(path.join(targetPath, 'pubspec.yaml'))) {
    return 'flutter';
  }

  const packageJson = readJsonFile(path.join(targetPath, 'package.json'));
  if (!packageJson) {
    return 'unknown';
  }
  const dependencies = {
    ...((packageJson.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };

  if (typeof dependencies['react-native'] === 'string') {
    return 'react-native';
  }
  if (typeof dependencies.next === 'string') {
    return 'nextjs';
  }
  if (typeof dependencies.nuxt === 'string' || typeof dependencies.nuxt3 === 'string') {
    return 'nuxtjs';
  }
  if (typeof dependencies['@angular/core'] === 'string') {
    return 'angular';
  }
  if (typeof dependencies.react === 'string') {
    return 'react';
  }
  if (typeof dependencies.vue === 'string') {
    return 'vue';
  }

  return 'unknown';
}

function detectPackageManager(targetPath: string): Pick<
  GalaxyDesignProjectInfo,
  'packageManager' | 'packageManagerSource'
> {
  const packageJson = readJsonFile(path.join(targetPath, 'package.json'));
  const packageManagerField = packageJson?.packageManager;
  if (typeof packageManagerField === 'string') {
    const name = packageManagerField.split('@')[0]?.trim().toLowerCase();
    if (name === 'bun' || name === 'pnpm' || name === 'yarn' || name === 'npm') {
      return {
        packageManager: name,
        packageManagerSource: 'package-json',
      };
    }
  }

  if (fs.existsSync(path.join(targetPath, 'bun.lock')) || fs.existsSync(path.join(targetPath, 'bun.lockb'))) {
    return { packageManager: 'bun', packageManagerSource: 'bun-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'pnpm-lock.yaml'))) {
    return { packageManager: 'pnpm', packageManagerSource: 'pnpm-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'yarn.lock'))) {
    return { packageManager: 'yarn', packageManagerSource: 'yarn-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'package-lock.json'))) {
    return { packageManager: 'npm', packageManagerSource: 'npm-lock' };
  }

  return { packageManager: 'npm', packageManagerSource: 'fallback' };
}

function isCommandAvailable(executable: string, args: readonly string[]): boolean {
  try {
    const result = spawnSync(executable, [...args], {
      stdio: 'ignore',
      encoding: 'utf-8',
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function findRunner(preferred: GalaxyDesignRunner): GalaxyDesignRunner {
  const candidates: readonly GalaxyDesignRunner[] = Object.freeze([
    preferred,
    ...(['bun', 'pnpm', 'yarn', 'npm'] as const).filter((item) => item !== preferred),
  ]);

  for (const candidate of candidates) {
    if (candidate === 'bun' && isCommandAvailable('bunx', ['--version'])) {
      return candidate;
    }
    if (candidate === 'pnpm' && isCommandAvailable('pnpm', ['--version'])) {
      return candidate;
    }
    if (candidate === 'yarn' && isCommandAvailable('yarn', ['--version'])) {
      return candidate;
    }
    if (candidate === 'npm' && isCommandAvailable('npx', ['--version'])) {
      return candidate;
    }
  }

  return 'npm';
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRunnerCommand(
  runner: GalaxyDesignRunner,
  action: 'init' | 'add',
  targetPath: string,
  components: readonly string[],
): Readonly<{ executable: string; args: readonly string[]; commandPreview: string }> {
  const cliArgs =
    action === 'init'
      ? ['init', '--yes', '--cwd', targetPath]
      : ['add', ...components, '--cwd', targetPath];

  if (runner === 'bun') {
    const args = [TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({
      executable: 'bunx',
      args: Object.freeze(args),
      commandPreview: ['bunx', ...args].map(shellQuote).join(' '),
    });
  }

  if (runner === 'pnpm') {
    const args = ['dlx', TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({
      executable: 'pnpm',
      args: Object.freeze(args),
      commandPreview: ['pnpm', ...args].map(shellQuote).join(' '),
    });
  }

  if (runner === 'yarn') {
    const args = ['dlx', TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({
      executable: 'yarn',
      args: Object.freeze(args),
      commandPreview: ['yarn', ...args].map(shellQuote).join(' '),
    });
  }

  const args = ['-y', TOOL_PACKAGE_SPEC, ...cliArgs];
  return Object.freeze({
    executable: 'npx',
    args: Object.freeze(args),
    commandPreview: ['npx', ...args].map(shellQuote).join(' '),
  });
}

function normalizeComponents(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return Object.freeze(raw.map((item) => String(item ?? '').trim()).filter(Boolean));
  }
  if (typeof raw === 'string') {
    return Object.freeze(
      raw
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return Object.freeze([]);
}

export function getGalaxyDesignProjectInfo(
  workspaceRoot: string,
  pathInput?: string,
): GalaxyDesignProjectInfo | { error: string } {
  const resolved = resolveWorkspacePath(workspaceRoot, pathInput);
  if (!resolved.ok) {
    return { error: resolved.error };
  }
  const targetPath = resolved.value;
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    return { error: `Project path not found: ${targetPath}` };
  }

  const framework = detectFramework(targetPath);
  const { packageManager, packageManagerSource } = detectPackageManager(targetPath);
  const componentsConfigPath = path.join(targetPath, 'components.json');
  const galaxyDesignInitialized = fs.existsSync(componentsConfigPath);

  return Object.freeze({
    targetPath,
    framework,
    packageManager,
    packageManagerSource,
    galaxyDesignInitialized,
    ...(galaxyDesignInitialized ? { componentsConfigPath } : {}),
    ...(framework !== 'unknown' ? { registryFramework: canonicalFramework(framework) } : {}),
  });
}

function localRegistryPath(fileName: string): string {
  return path.join(LOCAL_REGISTRY_DIR, fileName);
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadRegistryByFile(fileName: string): Promise<GalaxyDesignRegistry> {
  const localPath = localRegistryPath(fileName);
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf-8')) as GalaxyDesignRegistry;
  }

  const url = `${UNPKG_BASE}/${fileName}`;
  const raw = await fetchText(url);
  return JSON.parse(raw) as GalaxyDesignRegistry;
}

async function loadFrameworkRegistry(
  framework: GalaxyDesignFramework,
): Promise<Readonly<{
  framework: GalaxyDesignFramework;
  registryFramework: GalaxyDesignCanonicalFramework;
  registry: GalaxyDesignRegistry;
  registryUrl: string;
}>> {
  const registryFramework = canonicalFramework(framework);
  const fileName = REGISTRY_FILE_BY_FRAMEWORK[registryFramework];
  const registry = await loadRegistryByFile(fileName);
  return Object.freeze({
    framework,
    registryFramework,
    registry,
    registryUrl: `${UNPKG_BASE}/${fileName}`,
  });
}

function summarizeComponent(
  componentName: string,
  component: RegistryComponent,
  groups: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`Component: ${componentName}`);
  if (component.name) {
    lines.push(`Display name: ${component.name}`);
  }
  if (component.type) {
    lines.push(`Type: ${component.type}`);
  }
  if (component.category) {
    lines.push(`Category: ${component.category}`);
  }
  if (component.description) {
    lines.push(`Description: ${component.description}`);
  }
  if (groups.length > 0) {
    lines.push(`Groups: ${groups.join(', ')}`);
  }
  if (component.files && component.files.length > 0) {
    lines.push(`Files: ${component.files.join(', ')}`);
  }
  if (component.dependencies && component.dependencies.length > 0) {
    lines.push(`Dependencies: ${component.dependencies.join(', ')}`);
  }
  if (component.peerDependencies && component.peerDependencies.length > 0) {
    lines.push(`Peer dependencies: ${component.peerDependencies.join(', ')}`);
  }
  if (component.registryDependencies && component.registryDependencies.length > 0) {
    lines.push(`Registry dependencies: ${component.registryDependencies.join(', ')}`);
  }
  if (component.props && component.props.length > 0) {
    const propNames = component.props
      .map((prop) => (typeof prop.name === 'string' ? prop.name : ''))
      .filter(Boolean)
      .slice(0, 16);
    if (propNames.length > 0) {
      lines.push(`Props: ${propNames.join(', ')}${component.props.length > propNames.length ? ' ...' : ''}`);
    }
  }
  return lines.join('\n');
}

function searchRegistry(
  registry: GalaxyDesignRegistry,
  query: string,
): readonly Readonly<{ name: string; score: number; description: string; type: string }>[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.entries(registry.components)
      .map(([name, component]) => {
        const haystacks = [
          name.toLowerCase(),
          String(component.name ?? '').toLowerCase(),
          String(component.description ?? '').toLowerCase(),
          String(component.type ?? '').toLowerCase(),
          String(component.category ?? '').toLowerCase(),
        ];
        let score = 0;
        if (name.toLowerCase() === normalized) {
          score += 50;
        }
        if (name.toLowerCase().includes(normalized)) {
          score += 25;
        }
        if (haystacks[1]?.includes(normalized)) {
          score += 16;
        }
        if (haystacks[2]?.includes(normalized)) {
          score += 10;
        }
        if (haystacks[3]?.includes(normalized)) {
          score += 8;
        }
        if (haystacks[4]?.includes(normalized)) {
          score += 6;
        }

        return {
          name,
          score,
          description: String(component.description ?? ''),
          type: String(component.type ?? component.category ?? 'component'),
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 20),
  );
}

function getGroupMembers(registry: GalaxyDesignRegistry, groupName: string): readonly string[] {
  const direct = registry.groups[groupName]?.components;
  if (Array.isArray(direct)) {
    return Object.freeze([...direct]);
  }

  const lowered = groupName.toLowerCase();
  const match = Object.entries(registry.groups).find(([key, value]) => {
    return key.toLowerCase() === lowered || String(value.name ?? '').toLowerCase() === lowered;
  });
  return Object.freeze([...(match?.[1].components ?? [])]);
}

export async function galaxyDesignProjectInfoTool(
  workspaceRoot: string,
  pathInput?: string,
): Promise<ToolResult> {
  const info = getGalaxyDesignProjectInfo(workspaceRoot, pathInput);
  if ('error' in info) {
    return Object.freeze({ success: false, content: '', error: info.error });
  }

  const lines = [
    'Galaxy Design project info',
    `Path: ${info.targetPath}`,
    `Framework: ${info.framework}`,
    `Package manager: ${info.packageManager} (${info.packageManagerSource})`,
    `Galaxy Design initialized: ${info.galaxyDesignInitialized ? 'yes' : 'no'}`,
    info.componentsConfigPath ? `components.json: ${info.componentsConfigPath}` : 'components.json: not found',
  ];

  if (!info.galaxyDesignInitialized && info.framework !== 'unknown') {
    lines.push('Suggested next step: run galaxy_design_init.');
  } else if (info.galaxyDesignInitialized) {
    lines.push('Suggested next step: use galaxy_design_add or galaxy_design_registry.');
  }

  return Object.freeze({
    success: true,
    content: lines.join('\n'),
    meta: Object.freeze({
      targetPath: info.targetPath,
      framework: info.framework,
      packageManager: info.packageManager,
      packageManagerSource: info.packageManagerSource,
      initialized: info.galaxyDesignInitialized,
      ...(info.componentsConfigPath ? { componentsConfigPath: info.componentsConfigPath } : {}),
    }),
  });
}

export async function galaxyDesignRegistryTool(
  workspaceRoot: string,
  options?: {
    framework?: string;
    component?: string;
    group?: string;
    query?: string;
    path?: string;
  },
): Promise<ToolResult> {
  try {
    const projectInfo = options?.path ? getGalaxyDesignProjectInfo(workspaceRoot, options.path) : null;
    if (projectInfo && 'error' in projectInfo) {
      return Object.freeze({ success: false, content: '', error: projectInfo.error });
    }

    const inferredFramework =
      typeof options?.framework === 'string' && options.framework.trim()
        ? options.framework.trim().toLowerCase()
        : projectInfo && !('error' in projectInfo) && projectInfo.framework !== 'unknown'
          ? projectInfo.framework
          : '';

    const framework =
      inferredFramework === 'react' ||
      inferredFramework === 'nextjs' ||
      inferredFramework === 'vue' ||
      inferredFramework === 'nuxtjs' ||
      inferredFramework === 'angular' ||
      inferredFramework === 'react-native' ||
      inferredFramework === 'flutter'
        ? inferredFramework
        : null;

    const component = String(options?.component ?? '').trim();
    const group = String(options?.group ?? '').trim();
    const query = String(options?.query ?? '').trim();

    if (framework) {
      const loaded = await loadFrameworkRegistry(framework);
      const { registry } = loaded;

      if (component) {
        const exact = registry.components[component];
        if (!exact) {
          return Object.freeze({
            success: false,
            content: '',
            error: `Galaxy Design component "${component}" was not found for ${framework}.`,
          });
        }
        const groups = Object.entries(registry.groups)
          .filter(([, value]) => value.components?.includes(component))
          .map(([key]) => key);
        return Object.freeze({
          success: true,
          content: summarizeComponent(component, exact, groups),
          meta: Object.freeze({
            framework,
            registryFramework: loaded.registryFramework,
            registryUrl: loaded.registryUrl,
            component,
            groupCount: groups.length,
            resultCount: 1,
            sampleComponents: Object.freeze([component]),
          }),
        });
      }

      if (group) {
        const members = getGroupMembers(registry, group);
        if (members.length === 0) {
          return Object.freeze({
            success: false,
            content: '',
            error: `Galaxy Design group "${group}" was not found for ${framework}.`,
          });
        }
        return Object.freeze({
          success: true,
          content: [
            `Galaxy Design group: ${group}`,
            `Framework: ${framework}`,
            `Components (${members.length}): ${members.join(', ')}`,
          ].join('\n'),
          meta: Object.freeze({
            framework,
            registryFramework: loaded.registryFramework,
            registryUrl: loaded.registryUrl,
            group,
            resultCount: members.length,
            sampleComponents: Object.freeze(members.slice(0, 20)),
          }),
        });
      }

      if (query) {
        const matches = searchRegistry(registry, query);
        if (matches.length === 0) {
          return Object.freeze({
            success: false,
            content: '',
            error: `No Galaxy Design components matched "${query}" for ${framework}.`,
          });
        }
        return Object.freeze({
          success: true,
          content: [
            `Galaxy Design search: ${query}`,
            `Framework: ${framework}`,
            ...matches.map((item, index) => `${index + 1}. ${item.name} - ${item.type}${item.description ? ` - ${item.description}` : ''}`),
          ].join('\n'),
          meta: Object.freeze({
            framework,
            registryFramework: loaded.registryFramework,
            registryUrl: loaded.registryUrl,
            query,
            resultCount: matches.length,
            sampleComponents: Object.freeze(matches.map((item) => item.name).slice(0, 20)),
          }),
        });
      }

      const groupNames = Object.keys(registry.groups);
      const componentNames = Object.keys(registry.components);
      return Object.freeze({
        success: true,
        content: [
          `Galaxy Design registry for ${framework}`,
          `Registry URL: ${loaded.registryUrl}`,
          `Components: ${componentNames.length}`,
          `Groups: ${groupNames.join(', ')}`,
          `Sample components: ${componentNames.slice(0, 24).join(', ')}`,
        ].join('\n'),
        meta: Object.freeze({
          framework,
          registryFramework: loaded.registryFramework,
          registryUrl: loaded.registryUrl,
          resultCount: componentNames.length,
          sampleComponents: Object.freeze(componentNames.slice(0, 24)),
        }),
      });
    }

    const summaryRegistry = await loadRegistryByFile('registry.json');
    const summaryGroups = Object.keys(summaryRegistry.groups);
    const supportedFrameworks = ['react', 'nextjs', 'vue', 'nuxtjs', 'angular', 'react-native', 'flutter'];

    if (query) {
      const canonicalFrameworks: readonly GalaxyDesignCanonicalFramework[] = Object.freeze([
        'react',
        'vue',
        'angular',
        'react-native',
        'flutter',
      ]);
      const searchResults = (
        await Promise.all(
          canonicalFrameworks.map(async (candidateFramework) => {
            const loaded = await loadFrameworkRegistry(candidateFramework);
            const matches = searchRegistry(loaded.registry, query).slice(0, 5);
            return matches.map((match) => ({ framework: candidateFramework, ...match }));
          }),
        )
      )
        .flat()
        .sort((a, b) => b.score - a.score || a.framework.localeCompare(b.framework) || a.name.localeCompare(b.name))
        .slice(0, 20);

      if (searchResults.length === 0) {
        return Object.freeze({
          success: false,
          content: '',
          error: `No Galaxy Design components matched "${query}".`,
        });
      }

      return Object.freeze({
        success: true,
        content: [
          `Galaxy Design search: ${query}`,
          ...searchResults.map((item, index) => `${index + 1}. [${item.framework}] ${item.name} - ${item.type}${item.description ? ` - ${item.description}` : ''}`),
        ].join('\n'),
        meta: Object.freeze({
          query,
          resultCount: searchResults.length,
          sampleComponents: Object.freeze(searchResults.map((item) => `${item.framework}:${item.name}`)),
        }),
      });
    }

    return Object.freeze({
      success: true,
      content: [
        `Galaxy Design ${GALAXY_DESIGN_VERSION}`,
        `Supported frameworks: ${supportedFrameworks.join(', ')}`,
        `Summary registry: ${UNPKG_BASE}/registry.json`,
        `Groups: ${summaryGroups.join(', ')}`,
        `Sample components: ${Object.keys(summaryRegistry.components).slice(0, 24).join(', ')}`,
      ].join('\n'),
      meta: Object.freeze({
        version: GALAXY_DESIGN_VERSION,
        summaryRegistryUrl: `${UNPKG_BASE}/registry.json`,
        resultCount: Object.keys(summaryRegistry.components).length,
        sampleComponents: Object.freeze(Object.keys(summaryRegistry.components).slice(0, 24)),
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Failed to load Galaxy Design registry: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function prepareGalaxyDesignAction(
  workspaceRoot: string,
  action: 'init' | 'add',
  opts?: {
    path?: string;
    components?: readonly string[] | string;
  },
): GalaxyDesignActionPlan | { error: string } {
  const info = getGalaxyDesignProjectInfo(workspaceRoot, opts?.path);
  if ('error' in info) {
    return info;
  }

  if (info.framework === 'unknown') {
    return {
      error:
        `Could not detect the framework for ${info.targetPath}. ` +
        'Galaxy Design init/add requires a detectable React, Next.js, Vue, Nuxt.js, Angular, React Native, or Flutter project.',
    };
  }

  const components = normalizeComponents(opts?.components);
  if (action === 'add' && components.length === 0) {
    return { error: 'galaxy_design_add requires at least one component name.' };
  }

  if (action === 'init' && info.galaxyDesignInitialized) {
    return {
      error: `Galaxy Design is already initialized at ${info.targetPath} (components.json already exists).`,
    };
  }

  if (action === 'add' && !info.galaxyDesignInitialized) {
    return {
      error: `Galaxy Design is not initialized at ${info.targetPath}. Run galaxy_design_init first.`,
    };
  }

  const runnerPackageManager = findRunner(info.packageManager);
  const command = buildRunnerCommand(runnerPackageManager, action, info.targetPath, components);

  return Object.freeze({
    action,
    targetPath: info.targetPath,
    framework: info.framework,
    registryFramework: canonicalFramework(info.framework),
    packageManager: info.packageManager,
    runnerPackageManager,
    packageManagerSource: info.packageManagerSource,
    componentsConfigExists: info.galaxyDesignInitialized,
    executable: command.executable,
    args: command.args,
    commandPreview: command.commandPreview,
    components,
  });
}

function runGalaxyDesignAction(plan: GalaxyDesignActionPlan): ToolResult {
  try {
    const result = spawnSync(plan.executable, [...plan.args], {
      cwd: plan.targetPath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 8,
    });

    const stdout = String(result.stdout ?? '').trim();
    const stderr = String(result.stderr ?? '').trim();
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const exitCode = typeof result.status === 'number' ? result.status : result.error ? 1 : 0;

    if (result.error || exitCode !== 0) {
      return Object.freeze({
        success: false,
        content: combined,
        error:
          `Galaxy Design ${plan.action} failed` +
          (result.error ? `: ${result.error.message}` : ` with exit code ${exitCode}`),
        meta: Object.freeze({
          action: plan.action,
          framework: plan.framework,
          packageManager: plan.packageManager,
          runnerPackageManager: plan.runnerPackageManager,
          targetPath: plan.targetPath,
          commandPreview: plan.commandPreview,
          components: Object.freeze([...plan.components]),
          exitCode,
        }),
      });
    }

    return Object.freeze({
      success: true,
      content: combined || `Galaxy Design ${plan.action} completed successfully.`,
      meta: Object.freeze({
        action: plan.action,
        framework: plan.framework,
        packageManager: plan.packageManager,
        runnerPackageManager: plan.runnerPackageManager,
        targetPath: plan.targetPath,
        commandPreview: plan.commandPreview,
        components: Object.freeze([...plan.components]),
        exitCode,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Galaxy Design ${plan.action} failed: ${error instanceof Error ? error.message : String(error)}`,
      meta: Object.freeze({
        action: plan.action,
        framework: plan.framework,
        packageManager: plan.packageManager,
        runnerPackageManager: plan.runnerPackageManager,
        targetPath: plan.targetPath,
        commandPreview: plan.commandPreview,
        components: Object.freeze([...plan.components]),
        exitCode: 1,
      }),
    });
  }
}

export async function galaxyDesignInitTool(
  workspaceRoot: string,
  pathInput?: string,
): Promise<ToolResult> {
  const plan = prepareGalaxyDesignAction(workspaceRoot, 'init', {
    ...(pathInput !== undefined ? { path: pathInput } : {}),
  });
  if ('error' in plan) {
    return Object.freeze({ success: false, content: '', error: plan.error });
  }
  return runGalaxyDesignAction(plan);
}

export async function galaxyDesignAddTool(
  workspaceRoot: string,
  componentsInput: readonly string[] | string,
  pathInput?: string,
): Promise<ToolResult> {
  const plan = prepareGalaxyDesignAction(workspaceRoot, 'add', {
    components: componentsInput,
    ...(pathInput !== undefined ? { path: pathInput } : {}),
  });
  if ('error' in plan) {
    return Object.freeze({ success: false, content: '', error: plan.error });
  }
  return runGalaxyDesignAction(plan);
}
