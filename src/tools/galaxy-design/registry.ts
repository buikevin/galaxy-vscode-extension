/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Galaxy Design registry loading and search helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  GalaxyDesignCanonicalFramework,
  GalaxyDesignFramework,
  GalaxyDesignRegistry,
  RegistryComponent,
} from '../entities/galaxy-design';
import { getGalaxyDesignProjectInfo } from '../galaxy-design/core';
import {
  GALAXY_DESIGN_LOCAL_REGISTRY_DIR,
  GALAXY_DESIGN_REGISTRY_FILE_BY_FRAMEWORK,
  GALAXY_DESIGN_UNPKG_BASE,
  GALAXY_DESIGN_VERSION,
} from '../galaxy-design/constants';
import type { ToolResult } from '../entities/file-tools';

/**
 * Resolves one local registry file path.
 *
 * @param fileName Registry JSON file name.
 * @returns Absolute registry path in the local fallback directory.
 */
function localRegistryPath(fileName: string): string {
  return path.join(GALAXY_DESIGN_LOCAL_REGISTRY_DIR, fileName);
}

/**
 * Fetches raw text from a URL with a fixed timeout.
 *
 * @param url URL to fetch.
 * @returns Response body as text.
 */
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

/**
 * Loads one registry file from local disk or UNPKG.
 *
 * @param fileName Registry JSON file name.
 * @returns Parsed registry object.
 */
async function loadRegistryByFile(fileName: string): Promise<GalaxyDesignRegistry> {
  const localPath = localRegistryPath(fileName);
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf-8')) as GalaxyDesignRegistry;
  }
  const raw = await fetchText(`${GALAXY_DESIGN_UNPKG_BASE}/${fileName}`);
  return JSON.parse(raw) as GalaxyDesignRegistry;
}

/**
 * Loads the registry that corresponds to one framework.
 *
 * @param framework Detected or requested framework.
 * @returns Registry payload plus metadata about the selected file.
 */
async function loadFrameworkRegistry(
  framework: GalaxyDesignFramework,
): Promise<Readonly<{
  framework: GalaxyDesignFramework;
  registryFramework: GalaxyDesignCanonicalFramework;
  registry: GalaxyDesignRegistry;
  registryUrl: string;
}>> {
  const registryFramework = framework === 'nextjs' ? 'react' : framework === 'nuxtjs' ? 'vue' : framework;
  const fileName = GALAXY_DESIGN_REGISTRY_FILE_BY_FRAMEWORK[registryFramework];
  const registry = await loadRegistryByFile(fileName);
  return Object.freeze({
    framework,
    registryFramework,
    registry,
    registryUrl: `${GALAXY_DESIGN_UNPKG_BASE}/${fileName}`,
  });
}

/**
 * Builds a human-readable component summary.
 *
 * @param componentName Registry component key.
 * @param component Component payload.
 * @param groups Registry groups that contain the component.
 * @returns Multi-line summary text.
 */
function summarizeComponent(
  componentName: string,
  component: RegistryComponent,
  groups: readonly string[],
): string {
  const lines: string[] = [`Component: ${componentName}`];
  if (component.name) {lines.push(`Display name: ${component.name}`);}
  if (component.type) {lines.push(`Type: ${component.type}`);}
  if (component.category) {lines.push(`Category: ${component.category}`);}
  if (component.description) {lines.push(`Description: ${component.description}`);}
  if (groups.length > 0) {lines.push(`Groups: ${groups.join(', ')}`);}
  if (component.files && component.files.length > 0) {lines.push(`Files: ${component.files.join(', ')}`);}
  if (component.dependencies && component.dependencies.length > 0) {lines.push(`Dependencies: ${component.dependencies.join(', ')}`);}
  if (component.peerDependencies && component.peerDependencies.length > 0) {lines.push(`Peer dependencies: ${component.peerDependencies.join(', ')}`);}
  if (component.registryDependencies && component.registryDependencies.length > 0) {lines.push(`Registry dependencies: ${component.registryDependencies.join(', ')}`);}
  if (component.props && component.props.length > 0) {
    const propNames = component.props.map((prop) => (typeof prop.name === 'string' ? prop.name : '')).filter(Boolean).slice(0, 16);
    if (propNames.length > 0) {
      lines.push(`Props: ${propNames.join(', ')}${component.props.length > propNames.length ? ' ...' : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Scores registry components against a free-text query.
 *
 * @param registry Registry to search.
 * @param query Free-text query.
 * @returns Ranked component matches.
 */
function searchRegistry(
  registry: GalaxyDesignRegistry,
  query: string,
): readonly Readonly<{ name: string; score: number; description: string; type: string }>[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {return Object.freeze([]);}
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
        if (name.toLowerCase() === normalized) {score += 50;}
        if (name.toLowerCase().includes(normalized)) {score += 25;}
        if (haystacks[1]?.includes(normalized)) {score += 16;}
        if (haystacks[2]?.includes(normalized)) {score += 10;}
        if (haystacks[3]?.includes(normalized)) {score += 8;}
        if (haystacks[4]?.includes(normalized)) {score += 6;}
        return { name, score, description: String(component.description ?? ''), type: String(component.type ?? component.category ?? 'component') };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 20),
  );
}

/**
 * Resolves members of one registry group by exact or case-insensitive name.
 *
 * @param registry Registry to inspect.
 * @param groupName Requested group name.
 * @returns Group member component ids.
 */
function getGroupMembers(registry: GalaxyDesignRegistry, groupName: string): readonly string[] {
  const direct = registry.groups[groupName]?.components;
  if (Array.isArray(direct)) {return Object.freeze([...direct]);}
  const lowered = groupName.toLowerCase();
  const match = Object.entries(registry.groups).find(([key, value]) => key.toLowerCase() === lowered || String(value.name ?? '').toLowerCase() === lowered);
  return Object.freeze([...(match?.[1].components ?? [])]);
}

/**
 * Reads Galaxy Design registry information or performs component/group/query lookups.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param options Optional registry filters and project path.
 * @returns Tool result containing registry summaries or lookup results.
 */
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
        if (!exact) {return Object.freeze({ success: false, content: '', error: `Galaxy Design component "${component}" was not found for ${framework}.` });}
        const groups = Object.entries(registry.groups).filter(([, value]) => value.components?.includes(component)).map(([key]) => key);
        return Object.freeze({ success: true, content: summarizeComponent(component, exact, groups), meta: Object.freeze({ framework, registryFramework: loaded.registryFramework, registryUrl: loaded.registryUrl, component, groupCount: groups.length, resultCount: 1, sampleComponents: Object.freeze([component]) }) });
      }
      if (group) {
        const members = getGroupMembers(registry, group);
        if (members.length === 0) {return Object.freeze({ success: false, content: '', error: `Galaxy Design group "${group}" was not found for ${framework}.` });}
        return Object.freeze({ success: true, content: [`Galaxy Design group: ${group}`, `Framework: ${framework}`, `Components (${members.length}): ${members.join(', ')}`].join('\n'), meta: Object.freeze({ framework, registryFramework: loaded.registryFramework, registryUrl: loaded.registryUrl, group, resultCount: members.length, sampleComponents: Object.freeze(members.slice(0, 20)) }) });
      }
      if (query) {
        const matches = searchRegistry(registry, query);
        if (matches.length === 0) {return Object.freeze({ success: false, content: '', error: `No Galaxy Design components matched "${query}" for ${framework}.` });}
        return Object.freeze({ success: true, content: [`Galaxy Design search: ${query}`, `Framework: ${framework}`, ...matches.map((item, index) => `${index + 1}. ${item.name} - ${item.type}${item.description ? ` - ${item.description}` : ''}`)].join('\n'), meta: Object.freeze({ framework, registryFramework: loaded.registryFramework, registryUrl: loaded.registryUrl, query, resultCount: matches.length, sampleComponents: Object.freeze(matches.map((item) => item.name).slice(0, 20)) }) });
      }
      const groupNames = Object.keys(registry.groups);
      const componentNames = Object.keys(registry.components);
      return Object.freeze({ success: true, content: [`Galaxy Design registry for ${framework}`, `Registry URL: ${loaded.registryUrl}`, `Components: ${componentNames.length}`, `Groups: ${groupNames.join(', ')}`, `Sample components: ${componentNames.slice(0, 24).join(', ')}`].join('\n'), meta: Object.freeze({ framework, registryFramework: loaded.registryFramework, registryUrl: loaded.registryUrl, resultCount: componentNames.length, sampleComponents: Object.freeze(componentNames.slice(0, 24)) }) });
    }
    const summaryRegistry = await loadRegistryByFile('registry.json');
    const summaryGroups = Object.keys(summaryRegistry.groups);
    const supportedFrameworks = ['react', 'nextjs', 'vue', 'nuxtjs', 'angular', 'react-native', 'flutter'];
    if (query) {
      const canonicalFrameworks: readonly GalaxyDesignCanonicalFramework[] = Object.freeze(['react', 'vue', 'angular', 'react-native', 'flutter']);
      const searchResults = (await Promise.all(canonicalFrameworks.map(async (candidateFramework) => {
        const loaded = await loadFrameworkRegistry(candidateFramework);
        return searchRegistry(loaded.registry, query).slice(0, 5).map((match) => ({ framework: candidateFramework, ...match }));
      }))).flat().sort((a, b) => b.score - a.score || a.framework.localeCompare(b.framework) || a.name.localeCompare(b.name)).slice(0, 20);
      if (searchResults.length === 0) {return Object.freeze({ success: false, content: '', error: `No Galaxy Design components matched "${query}".` });}
      return Object.freeze({ success: true, content: [`Galaxy Design search: ${query}`, ...searchResults.map((item, index) => `${index + 1}. [${item.framework}] ${item.name} - ${item.type}${item.description ? ` - ${item.description}` : ''}`)].join('\n'), meta: Object.freeze({ query, resultCount: searchResults.length, sampleComponents: Object.freeze(searchResults.map((item) => `${item.framework}:${item.name}`)) }) });
    }
    return Object.freeze({ success: true, content: [`Galaxy Design ${GALAXY_DESIGN_VERSION}`, `Supported frameworks: ${supportedFrameworks.join(', ')}`, `Summary registry: ${GALAXY_DESIGN_UNPKG_BASE}/registry.json`, `Groups: ${summaryGroups.join(', ')}`, `Sample components: ${Object.keys(summaryRegistry.components).slice(0, 24).join(', ')}`].join('\n'), meta: Object.freeze({ version: GALAXY_DESIGN_VERSION, summaryRegistryUrl: `${GALAXY_DESIGN_UNPKG_BASE}/registry.json`, resultCount: Object.keys(summaryRegistry.components).length, sampleComponents: Object.freeze(Object.keys(summaryRegistry.components).slice(0, 24)) }) });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: `Failed to load Galaxy Design registry: ${error instanceof Error ? error.message : String(error)}` });
  }
}
