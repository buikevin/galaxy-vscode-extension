/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Node and package-script validation helpers for the VS Code runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  NodePackageManager,
  PackageScriptCandidate,
  ValidationCommandCategory,
  ValidationPreferencesConfig,
  ValidationProfileId,
} from '../shared/validation';

/**
 * Checks whether a file exists directly under the workspace root.
 *
 * @param workspacePath Absolute workspace root path.
 * @param fileName File name to look up.
 * @returns `true` when the file exists.
 */
export function hasFile(workspacePath: string, fileName: string): boolean {
  return fs.existsSync(path.join(workspacePath, fileName));
}

/**
 * Checks whether a directory exists directly under the workspace root.
 *
 * @param workspacePath Absolute workspace root path.
 * @param directoryName Directory name to inspect.
 * @returns `true` when the directory exists and is a directory.
 */
export function hasDirectory(workspacePath: string, directoryName: string): boolean {
  try {
    return fs.statSync(path.join(workspacePath, directoryName)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads `package.json#scripts` for command selection heuristics.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Script name to command mapping or an empty object when unavailable.
 */
export function parsePackageScripts(workspacePath: string): Record<string, string> {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {return {};}
  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Collects dependency names from every `package.json` dependency bucket.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns A set of dependency names used for fallback tool inference.
 */
export function parsePackageDependencyNames(workspacePath: string): ReadonlySet<string> {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {return new Set<string>();}
  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return new Set<string>([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
    ]);
  } catch {
    return new Set<string>();
  }
}

/**
 * Reads the `packageManager` field from `package.json` when lockfiles are absent.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Explicit package manager declaration or `undefined` when unavailable.
 */
function parsePackageManagerField(workspacePath: string): NodePackageManager | undefined {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {return undefined;}
  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const value = String(parsed.packageManager ?? '').trim().toLowerCase();
    if (value.startsWith('bun@')) {return 'bun';}
    if (value.startsWith('pnpm@')) {return 'pnpm';}
    if (value.startsWith('yarn@')) {return 'yarn';}
    if (value.startsWith('npm@')) {return 'npm';}
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Detects the workspace package manager from lockfiles or package metadata.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Package manager used to build script and exec commands.
 */
export function detectNodePackageManager(workspacePath: string): NodePackageManager {
  if (hasFile(workspacePath, 'bun.lock') || hasFile(workspacePath, 'bun.lockb')) {return 'bun';}
  if (hasFile(workspacePath, 'pnpm-lock.yaml')) {return 'pnpm';}
  if (hasFile(workspacePath, 'yarn.lock')) {return 'yarn';}
  if (hasFile(workspacePath, 'package-lock.json') || hasFile(workspacePath, 'npm-shrinkwrap.json')) {return 'npm';}
  return parsePackageManagerField(workspacePath) ?? 'npm';
}

/**
 * Builds a script execution command for the selected package manager.
 *
 * @param packageManager Package manager used by the workspace.
 * @param scriptName Script key from `package.json#scripts`.
 * @returns Command line that executes the script.
 */
export function buildNodeScriptCommand(packageManager: NodePackageManager, scriptName: string): string {
  switch (packageManager) {
    case 'bun': return `bun run ${scriptName}`;
    case 'pnpm': return `pnpm run ${scriptName}`;
    case 'yarn': return `yarn run ${scriptName}`;
    case 'npm':
    default: return `npm run ${scriptName}`;
  }
}

/**
 * Builds a package-manager-specific executable command such as `pnpm exec eslint .`.
 *
 * @param packageManager Package manager used by the workspace.
 * @param binary Binary name to invoke.
 * @param args Arguments passed to the binary.
 * @returns Command line that invokes the binary through the package manager.
 */
export function buildNodeExecCommand(packageManager: NodePackageManager, binary: string, args: readonly string[]): string {
  const suffix = args.length > 0 ? ` ${args.join(' ')}` : '';
  switch (packageManager) {
    case 'bun': return `bunx ${binary}${suffix}`;
    case 'pnpm': return `pnpm exec ${binary}${suffix}`;
    case 'yarn': return `yarn ${binary}${suffix}`;
    case 'npm':
    default: return `npx ${binary}${suffix}`;
  }
}

/**
 * Scores one package script against known validation categories.
 *
 * @param scriptName Script key declared in `package.json`.
 * @param scriptCommand Script command text declared in `package.json`.
 * @param profiles Active validation profiles for the workspace.
 * @returns The strongest inferred candidate for the script or `null` when no category matches.
 */
function scoreNodeScriptCategory(scriptName: string, scriptCommand: string, profiles: ReadonlySet<ValidationProfileId>): PackageScriptCandidate | null {
  const normalizedName = scriptName.trim().toLowerCase();
  const normalizedCommand = scriptCommand.trim().toLowerCase();
  if (!normalizedName || !normalizedCommand) {return null;}
  const hasTs = profiles.has('typescript');
  const baseProfile: ValidationProfileId = hasTs ? 'typescript' : 'javascript';
  const evaluate = (
    category: Exclude<ValidationCommandCategory, 'file'>,
    namePatterns: readonly Readonly<{ pattern: RegExp; score: number }>[],
    commandPatterns: readonly Readonly<{ pattern: RegExp; score: number }>[],
    profile = baseProfile,
  ): PackageScriptCandidate | null => {
    let score = -1;
    namePatterns.forEach(({ pattern, score: value }) => { if (pattern.test(normalizedName)) {score = Math.max(score, value);} });
    commandPatterns.forEach(({ pattern, score: value }) => { if (pattern.test(normalizedCommand)) {score = Math.max(score, value);} });
    if (score < 0) {return null;}
    return Object.freeze({ scriptName, category, profile, score });
  };
  const candidates = [
    evaluate('lint', [{ pattern: /^lint$/, score: 120 }, { pattern: /^lint:/, score: 110 }, { pattern: /^eslint$/, score: 105 }, { pattern: /(^|:)eslint$/, score: 100 }, { pattern: /^verify:lint$/, score: 95 }], [{ pattern: /\beslint\b/, score: 100 }, { pattern: /\bbiome\b/, score: 96 }, { pattern: /\boxlint\b/, score: 94 }]),
    evaluate('static-check', [{ pattern: /^check-types$/, score: 125 }, { pattern: /^typecheck$/, score: 124 }, { pattern: /^type-check$/, score: 123 }, { pattern: /^check:types$/, score: 122 }, { pattern: /^types:check$/, score: 121 }, { pattern: /^tsc$/, score: 118 }, { pattern: /^check$/, score: 96 }, { pattern: /^validate$/, score: 92 }, { pattern: /^verify$/, score: 90 }, { pattern: /(^|:)typecheck$/, score: 116 }, { pattern: /(^|:)check-types$/, score: 116 }], [{ pattern: /\btsc\b.*--noemit\b/, score: 120 }, { pattern: /\btsc\b/, score: 112 }, { pattern: /\bvue-tsc\b/, score: 111 }, { pattern: /\bflow\b/, score: 95 }], 'typescript'),
    evaluate('test', [{ pattern: /^test$/, score: 120 }, { pattern: /^test:unit$/, score: 116 }, { pattern: /^test:ci$/, score: 114 }, { pattern: /^unit$/, score: 108 }, { pattern: /^unit:/, score: 106 }, { pattern: /^vitest$/, score: 105 }, { pattern: /^jest$/, score: 104 }, { pattern: /^test:/, score: 100 }], [{ pattern: /\bvitest\b/, score: 108 }, { pattern: /\bjest\b/, score: 107 }, { pattern: /\bmocha\b/, score: 100 }, { pattern: /\bava\b/, score: 98 }, { pattern: /\bplaywright test\b/, score: 94 }]),
    evaluate('build', [{ pattern: /^build$/, score: 115 }, { pattern: /^build:check$/, score: 113 }, { pattern: /^compile$/, score: 108 }, { pattern: /^compile:/, score: 106 }, { pattern: /^build:/, score: 102 }], [{ pattern: /\bnext build\b/, score: 108 }, { pattern: /\bvite build\b/, score: 106 }, { pattern: /\bwebpack\b/, score: 102 }, { pattern: /\brollup\b/, score: 100 }]),
  ].filter((candidate): candidate is PackageScriptCandidate => Boolean(candidate));
  if (candidates.length === 0) {return null;}
  return candidates.sort((a, b) => b.score - a.score || a.scriptName.localeCompare(b.scriptName))[0] ?? null;
}

/**
 * Selects the best package scripts to use for lint, static analysis, test, and build stages.
 *
 * @param packageScripts Scripts declared in `package.json`.
 * @param profiles Active validation profiles for the workspace.
 * @param validationPreferences Optional user-configured command preferences.
 * @returns Ranked script candidates ordered by validation stage.
 */
export function selectNodeValidationScripts(
  packageScripts: Readonly<Record<string, string>>,
  profiles: ReadonlySet<ValidationProfileId>,
  validationPreferences?: ValidationPreferencesConfig,
): readonly PackageScriptCandidate[] {
  const bestByCategory = new Map<Exclude<ValidationCommandCategory, 'file'>, PackageScriptCandidate>();
  Object.entries(packageScripts).forEach(([scriptName, scriptCommand]) => {
    const candidate = scoreNodeScriptCategory(scriptName, scriptCommand, profiles);
    if (!candidate) {return;}
    const existing = bestByCategory.get(candidate.category);
    if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidate.scriptName.localeCompare(existing.scriptName) < 0)) {
      bestByCategory.set(candidate.category, candidate);
    }
  });
  const findPreferred = (category: Exclude<ValidationCommandCategory, 'file'>): PackageScriptCandidate | null => {
    const preferenceKey = category === 'static-check' ? 'staticCheck' : category;
    const preferredItems = validationPreferences?.[preferenceKey] ?? [];
    for (const preferredItem of preferredItems) {
      const normalizedPreferred = preferredItem.trim().toLowerCase();
      if (!normalizedPreferred) {continue;}
      const exactScriptName = Object.keys(packageScripts).find((scriptName) => scriptName.trim().toLowerCase() === normalizedPreferred);
      if (exactScriptName) {return scoreNodeScriptCategory(exactScriptName, packageScripts[exactScriptName] ?? '', profiles);}
      const commandMatch = Object.entries(packageScripts).find(([, scriptCommand]) => scriptCommand.trim().toLowerCase().includes(normalizedPreferred));
      if (commandMatch) {return scoreNodeScriptCategory(commandMatch[0], commandMatch[1], profiles);}
    }
    return null;
  };
  return Object.freeze(['lint', 'static-check', 'test', 'build'].map((category) => {
    const typedCategory = category as Exclude<ValidationCommandCategory, 'file'>;
    return findPreferred(typedCategory) ?? bestByCategory.get(typedCategory);
  }).filter((candidate): candidate is PackageScriptCandidate => Boolean(candidate)));
}
