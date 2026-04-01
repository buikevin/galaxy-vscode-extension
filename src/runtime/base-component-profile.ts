/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Detects the base component system used by the current workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASE_COMPONENT_UI_DIRECTORY_CANDIDATES } from '../shared/constants';
import type { BaseComponentLibrary, BaseComponentProfile } from '../shared/base-component-profile';

/**
 * Reads and parses a JSON file when it exists.
 *
 * @param filePath Absolute file path to parse.
 * @returns Parsed JSON object or `null` when the file is missing or invalid.
 */
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

/**
 * Checks whether a directory exists under the workspace.
 *
 * @param workspacePath Absolute workspace root path.
 * @param relativePath Relative directory path to inspect.
 * @returns `true` when the target exists and is a directory.
 */
function hasDir(workspacePath: string, relativePath: string): boolean {
  try {
    return fs.statSync(path.join(workspacePath, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Merges dependency and devDependency declarations into one lookup object.
 *
 * @param packageJson Parsed package.json content.
 * @returns Combined dependency map used for library detection.
 */
function getDependencies(packageJson: Record<string, unknown> | null): Record<string, unknown> {
  if (!packageJson) {
    return {};
  }

  return {
    ...((packageJson.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
}

/**
 * Checks whether a dependency is declared with a string version.
 *
 * @param dependencies Combined dependency map from package.json.
 * @param name Package name to look up.
 * @returns `true` when the dependency exists.
 */
function hasDependency(dependencies: Record<string, unknown>, name: string): boolean {
  return typeof dependencies[name] === 'string';
}

/**
 * Builds an immutable base component profile result.
 *
 * @param library Detected component library family.
 * @param confidence Confidence assigned to the detection result.
 * @param evidence Evidence strings that justify the classification.
 * @param guidance Guidance lines injected into prompts.
 * @returns Immutable base component profile result.
 */
function buildProfile(
  library: BaseComponentLibrary,
  confidence: BaseComponentProfile['confidence'],
  evidence: string[],
  guidance: string[],
): BaseComponentProfile {
  return Object.freeze({
    library,
    confidence,
    evidence: Object.freeze(evidence),
    guidance: Object.freeze(guidance),
  });
}

/**
 * Detects the likely base component system used by the workspace.
 *
 * @param workspacePath Absolute or relative workspace root path.
 * @returns Structured component-profile result used by prompt context builders.
 */
export function detectBaseComponentProfile(workspacePath: string): BaseComponentProfile {
  const resolvedWorkspace = path.resolve(workspacePath);
  const packageJson = readJsonFile(path.join(resolvedWorkspace, 'package.json'));
  const componentsJson = readJsonFile(path.join(resolvedWorkspace, 'components.json'));
  const dependencies = getDependencies(packageJson);

  const hasComponentsUiDir = BASE_COMPONENT_UI_DIRECTORY_CANDIDATES.some((directoryPath) =>
    hasDir(resolvedWorkspace, directoryPath),
  );

  const componentsFramework = typeof componentsJson?.framework === 'string'
    ? componentsJson.framework.toLowerCase()
    : '';
  const componentsStyle = typeof componentsJson?.style === 'string'
    ? componentsJson.style.toLowerCase()
    : '';

  if (
    typeof componentsJson?.['$schema'] === 'string' ||
    typeof componentsJson?.registry === 'string' ||
    typeof componentsJson?.aliases === 'object'
  ) {
    const evidence = ['Found components.json'];
    if (componentsFramework) {
      evidence.push(`components.json framework=${componentsFramework}`);
    }
    if (componentsStyle) {
      evidence.push(`components.json style=${componentsStyle}`);
    }

    if (
      hasDependency(dependencies, 'galaxy-design') ||
      componentsStyle.includes('galaxy') ||
      String(componentsJson?.registry ?? '').toLowerCase().includes('galaxy')
    ) {
      return buildProfile(
        'galaxy-design',
        'high',
        evidence,
        [
          'Prefer Galaxy Design base components and existing registry-driven patterns.',
          'Do not fall back to raw HTML when a Galaxy Design component should exist.',
          'Match the current Galaxy Design composition style used in the project.',
        ],
      );
    }

    return buildProfile(
      'shadcn-ui',
      hasComponentsUiDir ? 'high' : 'medium',
      [
        ...evidence,
        ...(hasComponentsUiDir ? ['Found components/ui directory'] : []),
        ...(hasDependency(dependencies, 'class-variance-authority') ? ['Found class-variance-authority'] : []),
        ...(Object.keys(dependencies).some((name) => name.startsWith('@radix-ui/')) ? ['Found @radix-ui dependencies'] : []),
      ],
      [
        'Prefer project-local base components from components/ui or src/components/ui.',
        'Compose UI from existing shadcn-style primitives before using raw HTML.',
        'Match existing Tailwind and variant patterns already used by the project.',
      ],
    );
  }

  if (hasDependency(dependencies, 'antd')) {
    return buildProfile(
      'antd',
      'high',
      ['Found dependency antd'],
      [
        'Prefer Ant Design components and props over custom raw HTML.',
        'Match current Ant Design patterns, spacing, and form/dialog APIs in the repo.',
      ],
    );
  }

  if (hasDependency(dependencies, '@mui/material')) {
    return buildProfile(
      'mui',
      'high',
      ['Found dependency @mui/material'],
      [
        'Prefer MUI components and theme-aware props over raw HTML.',
        'Match existing MUI composition and styling patterns used in the project.',
      ],
    );
  }

  if (hasDependency(dependencies, '@chakra-ui/react')) {
    return buildProfile(
      'chakra-ui',
      'high',
      ['Found dependency @chakra-ui/react'],
      [
        'Prefer Chakra UI primitives and style props over raw HTML.',
        'Match the project theme and component usage already present in the repo.',
      ],
    );
  }

  if (Object.keys(dependencies).some((name) => name.startsWith('@radix-ui/'))) {
    return buildProfile(
      'radix-custom',
      hasComponentsUiDir ? 'high' : 'medium',
      [
        'Found @radix-ui dependencies',
        ...(hasComponentsUiDir ? ['Found project-local ui primitives'] : []),
      ],
      [
        'Prefer existing project-local wrappers around Radix primitives.',
        'Avoid introducing a second component system when current wrappers already exist.',
      ],
    );
  }

  return buildProfile(
    'unknown',
    'low',
    ['No known base component system detected with high confidence'],
    [
      'Inspect existing UI files before introducing new component patterns.',
      'Prefer reusing the project current component conventions over inventing a new system.',
    ],
  );
}

/**
 * Builds a prompt-ready note describing the detected base component system.
 *
 * @param workspacePath Absolute or relative workspace root path.
 * @returns Multiline note that can be injected into runtime context.
 */
export function buildBaseComponentContextNote(workspacePath: string): string {
  const profile = detectBaseComponentProfile(workspacePath);
  const lines = [
    'Base component profile:',
    `- library: ${profile.library}`,
    `- confidence: ${profile.confidence}`,
    ...profile.evidence.map((item) => `- evidence: ${item}`),
    ...profile.guidance.map((item) => `- guidance: ${item}`),
  ];
  return lines.join('\n');
}
