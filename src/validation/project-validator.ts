import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendTelemetryEvent } from '../context/telemetry';
import type { GalaxyConfig } from '../config/types';
import type { TrackedFile } from '../runtime/session-tracker';
import { buildShellEnvironment, checkCommandAvailability, resolveShellProfile } from '../runtime/shell-resolver';
import { validateCodeTool } from '../tools/file-tools';
import type {
  FinalValidationResult,
  ValidationCommand,
  ValidationCommandStreamCallbacks,
  ValidationIssue,
  ValidationProfileId,
  ValidationRunResult,
} from './types';

const MAX_VALIDATION_CAPTURE_CHARS = 20_000;

function hasFile(workspacePath: string, fileName: string): boolean {
  return fs.existsSync(path.join(workspacePath, fileName));
}

function hasDirectory(workspacePath: string, directoryName: string): boolean {
  try {
    return fs.statSync(path.join(workspacePath, directoryName)).isDirectory();
  } catch {
    return false;
  }
}

function parsePackageScripts(workspacePath: string): Record<string, string> {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function parsePackageDependencyNames(workspacePath: string): ReadonlySet<string> {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return new Set<string>();
  }

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

type NodePackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

function parsePackageManagerField(workspacePath: string): NodePackageManager | undefined {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(packagePath, 'utf-8');
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const value = String(parsed.packageManager ?? '').trim().toLowerCase();
    if (value.startsWith('bun@')) {
      return 'bun';
    }
    if (value.startsWith('pnpm@')) {
      return 'pnpm';
    }
    if (value.startsWith('yarn@')) {
      return 'yarn';
    }
    if (value.startsWith('npm@')) {
      return 'npm';
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function detectNodePackageManager(workspacePath: string): NodePackageManager {
  if (hasFile(workspacePath, 'bun.lock') || hasFile(workspacePath, 'bun.lockb')) {
    return 'bun';
  }
  if (hasFile(workspacePath, 'pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (hasFile(workspacePath, 'yarn.lock')) {
    return 'yarn';
  }
  if (hasFile(workspacePath, 'package-lock.json') || hasFile(workspacePath, 'npm-shrinkwrap.json')) {
    return 'npm';
  }

  return parsePackageManagerField(workspacePath) ?? 'npm';
}

function buildNodeScriptCommand(packageManager: NodePackageManager, scriptName: string): string {
  switch (packageManager) {
    case 'bun':
      return `bun run ${scriptName}`;
    case 'pnpm':
      return `pnpm run ${scriptName}`;
    case 'yarn':
      return `yarn run ${scriptName}`;
    case 'npm':
    default:
      return `npm run ${scriptName}`;
  }
}

function buildNodeExecCommand(packageManager: NodePackageManager, binary: string, args: readonly string[]): string {
  const suffix = args.length > 0 ? ` ${args.join(' ')}` : '';
  switch (packageManager) {
    case 'bun':
      return `bunx ${binary}${suffix}`;
    case 'pnpm':
      return `pnpm exec ${binary}${suffix}`;
    case 'yarn':
      return `yarn ${binary}${suffix}`;
    case 'npm':
    default:
      return `npx ${binary}${suffix}`;
  }
}

type ValidationCommandCategory = ValidationCommand['category'];
type ValidationPreferencesConfig = GalaxyConfig['validation'];

type PackageScriptCandidate = Readonly<{
  scriptName: string;
  category: Exclude<ValidationCommandCategory, 'file'>;
  profile: ValidationProfileId;
  score: number;
}>;

function scoreNodeScriptCategory(
  scriptName: string,
  scriptCommand: string,
  profiles: ReadonlySet<ValidationProfileId>,
): PackageScriptCandidate | null {
  const normalizedName = scriptName.trim().toLowerCase();
  const normalizedCommand = scriptCommand.trim().toLowerCase();
  if (!normalizedName || !normalizedCommand) {
    return null;
  }

  const hasTs = profiles.has('typescript');
  const baseProfile: ValidationProfileId = hasTs ? 'typescript' : 'javascript';

  const evaluate = (
    category: Exclude<ValidationCommandCategory, 'file'>,
    namePatterns: readonly Readonly<{ pattern: RegExp; score: number }>[],
    commandPatterns: readonly Readonly<{ pattern: RegExp; score: number }>[],
    profile = baseProfile,
  ): PackageScriptCandidate | null => {
    let score = -1;
    namePatterns.forEach(({ pattern, score: value }) => {
      if (pattern.test(normalizedName)) {
        score = Math.max(score, value);
      }
    });
    commandPatterns.forEach(({ pattern, score: value }) => {
      if (pattern.test(normalizedCommand)) {
        score = Math.max(score, value);
      }
    });
    if (score < 0) {
      return null;
    }
    return Object.freeze({
      scriptName,
      category,
      profile,
      score,
    });
  };

  const candidates = [
    evaluate(
      'lint',
      [
        { pattern: /^lint$/, score: 120 },
        { pattern: /^lint:/, score: 110 },
        { pattern: /^eslint$/, score: 105 },
        { pattern: /(^|:)eslint$/, score: 100 },
        { pattern: /^verify:lint$/, score: 95 },
      ],
      [
        { pattern: /\beslint\b/, score: 100 },
        { pattern: /\bbiome\b/, score: 96 },
        { pattern: /\boxlint\b/, score: 94 },
      ],
    ),
    evaluate(
      'static-check',
      [
        { pattern: /^check-types$/, score: 125 },
        { pattern: /^typecheck$/, score: 124 },
        { pattern: /^type-check$/, score: 123 },
        { pattern: /^check:types$/, score: 122 },
        { pattern: /^types:check$/, score: 121 },
        { pattern: /^tsc$/, score: 118 },
        { pattern: /^check$/, score: 96 },
        { pattern: /^validate$/, score: 92 },
        { pattern: /^verify$/, score: 90 },
        { pattern: /(^|:)typecheck$/, score: 116 },
        { pattern: /(^|:)check-types$/, score: 116 },
      ],
      [
        { pattern: /\btsc\b.*--noemit\b/, score: 120 },
        { pattern: /\btsc\b/, score: 112 },
        { pattern: /\bvue-tsc\b/, score: 111 },
        { pattern: /\bflow\b/, score: 95 },
      ],
      'typescript',
    ),
    evaluate(
      'test',
      [
        { pattern: /^test$/, score: 120 },
        { pattern: /^test:unit$/, score: 116 },
        { pattern: /^test:ci$/, score: 114 },
        { pattern: /^unit$/, score: 108 },
        { pattern: /^unit:/, score: 106 },
        { pattern: /^vitest$/, score: 105 },
        { pattern: /^jest$/, score: 104 },
        { pattern: /^test:/, score: 100 },
      ],
      [
        { pattern: /\bvitest\b/, score: 108 },
        { pattern: /\bjest\b/, score: 107 },
        { pattern: /\bmocha\b/, score: 100 },
        { pattern: /\bava\b/, score: 98 },
        { pattern: /\bplaywright test\b/, score: 94 },
      ],
    ),
    evaluate(
      'build',
      [
        { pattern: /^build$/, score: 115 },
        { pattern: /^build:check$/, score: 113 },
        { pattern: /^compile$/, score: 108 },
        { pattern: /^compile:/, score: 106 },
        { pattern: /^build:/, score: 102 },
      ],
      [
        { pattern: /\bnext build\b/, score: 108 },
        { pattern: /\bvite build\b/, score: 106 },
        { pattern: /\bwebpack\b/, score: 102 },
        { pattern: /\brollup\b/, score: 100 },
      ],
    ),
  ].filter((candidate): candidate is PackageScriptCandidate => Boolean(candidate));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => b.score - a.score || a.scriptName.localeCompare(b.scriptName))[0] ?? null;
}

export function selectNodeValidationScripts(
  packageScripts: Readonly<Record<string, string>>,
  profiles: ReadonlySet<ValidationProfileId>,
  validationPreferences?: ValidationPreferencesConfig,
): readonly PackageScriptCandidate[] {
  const bestByCategory = new Map<Exclude<ValidationCommandCategory, 'file'>, PackageScriptCandidate>();

  Object.entries(packageScripts).forEach(([scriptName, scriptCommand]) => {
    const candidate = scoreNodeScriptCategory(scriptName, scriptCommand, profiles);
    if (!candidate) {
      return;
    }
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
      if (!normalizedPreferred) {
        continue;
      }
      const exactScriptName = Object.keys(packageScripts).find((scriptName) => scriptName.trim().toLowerCase() === normalizedPreferred);
      if (exactScriptName) {
        return scoreNodeScriptCategory(exactScriptName, packageScripts[exactScriptName] ?? '', profiles);
      }
      const commandMatch = Object.entries(packageScripts).find(([, scriptCommand]) => scriptCommand.trim().toLowerCase().includes(normalizedPreferred));
      if (commandMatch) {
        return scoreNodeScriptCategory(commandMatch[0], commandMatch[1], profiles);
      }
    }
    return null;
  };

  return Object.freeze(
    ['lint', 'static-check', 'test', 'build']
      .map((category) => {
        const typedCategory = category as Exclude<ValidationCommandCategory, 'file'>;
        return findPreferred(typedCategory) ?? bestByCategory.get(typedCategory);
      })
      .filter((candidate): candidate is PackageScriptCandidate => Boolean(candidate)),
  );
}

function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function hasTrackedExtension(sessionFiles: readonly TrackedFile[], extensions: readonly string[]): boolean {
  const extSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  return sessionFiles.some((file) => extSet.has(path.extname(file.filePath).toLowerCase()));
}

function detectValidationProfiles(
  workspacePath: string,
  sessionFiles: readonly TrackedFile[],
): readonly ValidationProfileId[] {
  const profiles: ValidationProfileId[] = [];
  const push = (profile: ValidationProfileId) => {
    if (!profiles.includes(profile)) {
      profiles.push(profile);
    }
  };

  const hasJs = hasTrackedExtension(sessionFiles, ['.js', '.jsx', '.mjs', '.cjs']);
  const hasTs = hasTrackedExtension(sessionFiles, ['.ts', '.tsx']);
  const hasPython = hasTrackedExtension(sessionFiles, ['.py']);
  const hasJava = hasTrackedExtension(sessionFiles, ['.java', '.kt']);
  const hasGo = hasTrackedExtension(sessionFiles, ['.go']);
  const hasRust = hasTrackedExtension(sessionFiles, ['.rs']);
  const hasPhp = hasTrackedExtension(sessionFiles, ['.php']);
  const hasShell = hasTrackedExtension(sessionFiles, ['.sh', '.bash', '.zsh']);
  const hasRuby = hasTrackedExtension(sessionFiles, ['.rb']);

  if (hasFile(workspacePath, 'package.json') || hasJs) {
    push('javascript');
  }
  if (hasFile(workspacePath, 'tsconfig.json') || hasTs) {
    push('typescript');
  }
  if (hasPython || hasFile(workspacePath, 'pyproject.toml') || hasFile(workspacePath, 'requirements.txt') || hasFile(workspacePath, 'setup.py')) {
    push('python');
  }
  if (hasJava || hasFile(workspacePath, 'pom.xml') || hasFile(workspacePath, 'build.gradle') || hasFile(workspacePath, 'build.gradle.kts')) {
    push('java');
  }
  if (hasGo || hasFile(workspacePath, 'go.mod')) {
    push('go');
  }
  if (hasRust || hasFile(workspacePath, 'Cargo.toml')) {
    push('rust');
  }
  if (fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
    push('dotnet');
  }
  if (hasPhp && hasFile(workspacePath, 'composer.json')) {
    push('php');
  }
  if (hasShell && hasFile(workspacePath, '.shellcheckrc')) {
    push('shell');
  }
  if (hasRuby && hasFile(workspacePath, 'Rakefile')) {
    push('ruby');
  }

  return Object.freeze(profiles);
}

function addProjectCommand(
  commands: ValidationCommand[],
  seen: Set<string>,
  command: ValidationCommand,
): void {
  const dedupeKey = `${command.category}:${command.command}`;
  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  commands.push(command);
}

function detectProjectCommands(
  workspacePath: string,
  sessionFiles: readonly TrackedFile[],
  validationPreferences?: ValidationPreferencesConfig,
): readonly ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  const seenCommands = new Set<string>();
  const packageScripts = parsePackageScripts(workspacePath);
  const packageDependencyNames = parsePackageDependencyNames(workspacePath);
  const pyprojectText = hasFile(workspacePath, 'pyproject.toml')
    ? readTextFile(path.join(workspacePath, 'pyproject.toml'))
    : '';
  const makefileText = hasFile(workspacePath, 'Makefile')
    ? readTextFile(path.join(workspacePath, 'Makefile'))
    : '';
  const composerText = hasFile(workspacePath, 'composer.json')
    ? readTextFile(path.join(workspacePath, 'composer.json'))
    : '';
  const nodePackageManager = detectNodePackageManager(workspacePath);
  const hasPythonFiles = hasTrackedExtension(sessionFiles, ['.py']);
  const hasPhpFiles = hasTrackedExtension(sessionFiles, ['.php']);
  const hasShellFiles = hasTrackedExtension(sessionFiles, ['.sh', '.bash', '.zsh']);
  const hasRubyFiles = hasTrackedExtension(sessionFiles, ['.rb']);
  const profiles = new Set(detectValidationProfiles(workspacePath, sessionFiles));
  const selectedNodeScripts =
    profiles.has('javascript') || profiles.has('typescript')
      ? selectNodeValidationScripts(packageScripts, profiles, validationPreferences)
      : Object.freeze([]);

  selectedNodeScripts.forEach((candidate) => {
    addProjectCommand(commands, seenCommands, {
      id: `${nodePackageManager}-${candidate.category}-${candidate.scriptName.replace(/[^a-z0-9_-]+/gi, '-')}`,
      label: buildNodeScriptCommand(nodePackageManager, candidate.scriptName),
      command: buildNodeScriptCommand(nodePackageManager, candidate.scriptName),
      cwd: workspacePath,
      kind: 'project',
      profile: candidate.profile,
      category: candidate.category,
    });
  });

  if ((profiles.has('javascript') || profiles.has('typescript')) && !packageScripts.lint && packageDependencyNames.has('eslint')) {
    addProjectCommand(commands, seenCommands, {
      id: `${nodePackageManager}-eslint-fallback`,
      label: buildNodeExecCommand(nodePackageManager, 'eslint', ['.']),
      command: buildNodeExecCommand(nodePackageManager, 'eslint', ['.']),
      cwd: workspacePath,
      kind: 'project',
      profile: profiles.has('typescript') ? 'typescript' : 'javascript',
      category: 'lint',
    });
  }

  if (
    profiles.has('typescript') &&
    hasFile(workspacePath, 'tsconfig.json') &&
    !selectedNodeScripts.some((candidate) => candidate.category === 'static-check')
  ) {
    addProjectCommand(commands, seenCommands, {
      id: `${nodePackageManager}-tsc-noemit`,
      label: buildNodeExecCommand(nodePackageManager, 'tsc', ['--noEmit']),
      command: buildNodeExecCommand(nodePackageManager, 'tsc', ['--noEmit']),
      cwd: workspacePath,
      kind: 'project',
      profile: 'typescript',
      category: 'static-check',
    });
  }

  if (profiles.has('rust')) {
    addProjectCommand(commands, seenCommands, {
      id: 'cargo-check',
      label: 'cargo check',
      command: 'cargo check',
      cwd: workspacePath,
      kind: 'project',
      profile: 'rust',
      category: 'static-check',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'cargo-test',
      label: 'cargo test',
      command: 'cargo test',
      cwd: workspacePath,
      kind: 'project',
      profile: 'rust',
      category: 'test',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'cargo-build',
      label: 'cargo build',
      command: 'cargo build',
      cwd: workspacePath,
      kind: 'project',
      profile: 'rust',
      category: 'build',
    });
  }

  if (profiles.has('go')) {
    addProjectCommand(commands, seenCommands, {
      id: 'go-test',
      label: 'go test ./...',
      command: 'go test ./...',
      cwd: workspacePath,
      kind: 'project',
      profile: 'go',
      category: 'test',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'go-build',
      label: 'go build ./...',
      command: 'go build ./...',
      cwd: workspacePath,
      kind: 'project',
      profile: 'go',
      category: 'build',
    });
  }

  if (
    profiles.has('python') &&
    hasPythonFiles &&
    (hasFile(workspacePath, 'pyproject.toml') ||
      hasFile(workspacePath, 'requirements.txt') ||
      hasFile(workspacePath, 'setup.py'))
  ) {
    if (
      pyprojectText.includes('[tool.ruff]') ||
      hasFile(workspacePath, 'ruff.toml') ||
      hasFile(workspacePath, '.ruff.toml')
    ) {
      addProjectCommand(commands, seenCommands, {
        id: 'ruff-check',
        label: 'ruff check .',
        command: 'ruff check .',
        cwd: workspacePath,
        kind: 'project',
        profile: 'python',
        category: 'lint',
      });
    }

    if (pyprojectText.includes('[tool.mypy]') || hasFile(workspacePath, 'mypy.ini')) {
      addProjectCommand(commands, seenCommands, {
        id: 'mypy-check',
        label: 'mypy .',
        command: 'mypy .',
        cwd: workspacePath,
        kind: 'project',
        profile: 'python',
        category: 'static-check',
      });
    }

    if (
      pyprojectText.includes('pytest') ||
      hasFile(workspacePath, 'pytest.ini') ||
      hasFile(workspacePath, 'tox.ini') ||
      hasDirectory(workspacePath, 'tests')
    ) {
      addProjectCommand(commands, seenCommands, {
        id: 'pytest',
        label: 'pytest',
        command: 'pytest',
        cwd: workspacePath,
        kind: 'project',
        profile: 'python',
        category: 'test',
      });
    }
  }

  if (profiles.has('java') && hasFile(workspacePath, 'pom.xml')) {
    addProjectCommand(commands, seenCommands, {
      id: 'maven-compile',
      label: 'mvn -q -DskipTests compile',
      command: 'mvn -q -DskipTests compile',
      cwd: workspacePath,
      kind: 'project',
      profile: 'java',
      category: 'static-check',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'maven-test',
      label: 'mvn -q test',
      command: 'mvn -q test',
      cwd: workspacePath,
      kind: 'project',
      profile: 'java',
      category: 'test',
    });
  }

  if (profiles.has('java') && (hasFile(workspacePath, 'build.gradle') || hasFile(workspacePath, 'build.gradle.kts'))) {
    const gradleExecutable = hasFile(workspacePath, 'gradlew') ? './gradlew' : 'gradle';
    addProjectCommand(commands, seenCommands, {
      id: 'gradle-classes',
      label: `${gradleExecutable} classes`,
      command: `${gradleExecutable} classes`,
      cwd: workspacePath,
      kind: 'project',
      profile: 'java',
      category: 'static-check',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'gradle-test',
      label: `${gradleExecutable} test`,
      command: `${gradleExecutable} test`,
      cwd: workspacePath,
      kind: 'project',
      profile: 'java',
      category: 'test',
    });
  }

  const rootEntries = fs.existsSync(workspacePath) ? fs.readdirSync(workspacePath) : [];
  if (profiles.has('dotnet') && rootEntries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
    addProjectCommand(commands, seenCommands, {
      id: 'dotnet-build',
      label: 'dotnet build --nologo',
      command: 'dotnet build --nologo',
      cwd: workspacePath,
      kind: 'project',
      profile: 'dotnet',
      category: 'static-check',
    });
    addProjectCommand(commands, seenCommands, {
      id: 'dotnet-test',
      label: 'dotnet test --nologo',
      command: 'dotnet test --nologo',
      cwd: workspacePath,
      kind: 'project',
      profile: 'dotnet',
      category: 'test',
    });
  }

  if (makefileText) {
    for (const target of ['lint']) {
      if (!new RegExp(`^${target}:`, 'm').test(makefileText)) {
        continue;
      }
      addProjectCommand(commands, seenCommands, {
        id: `make-${target}`,
        label: `make ${target}`,
        command: `make ${target}`,
        cwd: workspacePath,
        kind: 'project',
        profile: profiles.has('typescript') ? 'typescript' : profiles.has('javascript') ? 'javascript' : profiles.has('python') ? 'python' : 'javascript',
        category: 'lint',
      });
    }

    for (const target of ['check', 'typecheck', 'validate']) {
      if (!new RegExp(`^${target}:`, 'm').test(makefileText)) {
        continue;
      }
      addProjectCommand(commands, seenCommands, {
        id: `make-${target}`,
        label: `make ${target}`,
        command: `make ${target}`,
        cwd: workspacePath,
        kind: 'project',
        profile: profiles.has('typescript') ? 'typescript' : profiles.has('javascript') ? 'javascript' : profiles.has('python') ? 'python' : 'javascript',
        category: 'static-check',
      });
    }

    if (/^test:/m.test(makefileText)) {
      addProjectCommand(commands, seenCommands, {
        id: 'make-test',
        label: 'make test',
        command: 'make test',
        cwd: workspacePath,
        kind: 'project',
        profile: profiles.has('typescript') ? 'typescript' : profiles.has('javascript') ? 'javascript' : profiles.has('python') ? 'python' : 'javascript',
        category: 'test',
      });
    }
  }

  if (profiles.has('php') && hasPhpFiles && composerText) {
    if (composerText.includes('phpstan')) {
      addProjectCommand(commands, seenCommands, {
        id: 'phpstan-analyse',
        label: 'vendor/bin/phpstan analyse',
        command: 'vendor/bin/phpstan analyse',
        cwd: workspacePath,
        kind: 'project',
        profile: 'php',
        category: 'static-check',
      });
    }
    if (composerText.includes('phpunit') && fs.existsSync(path.join(workspacePath, 'vendor/bin/phpunit'))) {
      addProjectCommand(commands, seenCommands, {
        id: 'phpunit',
        label: 'vendor/bin/phpunit',
        command: 'vendor/bin/phpunit',
        cwd: workspacePath,
        kind: 'project',
        profile: 'php',
        category: 'test',
      });
    }
  }

  if (profiles.has('shell') && hasShellFiles && hasFile(workspacePath, '.shellcheckrc')) {
    addProjectCommand(commands, seenCommands, {
      id: 'shellcheck-recursive',
      label: 'shellcheck recursive',
      command: "find . -type f \\( -name '*.sh' -o -name '*.bash' -o -name '*.zsh' \\) -print0 | xargs -0 shellcheck",
      cwd: workspacePath,
      kind: 'project',
      profile: 'shell',
      category: 'lint',
    });
  }

  if (profiles.has('ruby') && hasRubyFiles && hasFile(workspacePath, 'Rakefile')) {
    addProjectCommand(commands, seenCommands, {
      id: 'rake-test',
      label: 'rake test',
      command: 'rake test',
      cwd: workspacePath,
      kind: 'project',
      profile: 'ruby',
      category: 'test',
    });
  }

  return Object.freeze(commands);
}

function buildValidationSelectionSummary(
  workspacePath: string,
  profiles: readonly ValidationProfileId[],
  commands: readonly ValidationCommand[],
  usedFileSafetyNet: boolean,
): string {
  const profileList = [...profiles].sort();
  appendTelemetryEvent(workspacePath, {
    kind: 'validation_selection',
    mode: commands.length > 0 ? 'project' : usedFileSafetyNet ? 'file' : 'none',
    profiles: Object.freeze(profileList),
    commandCount: commands.length,
    usedFileSafetyNet,
  });
  const byCategory = new Map<ValidationCommand['category'], ValidationCommand>();
  commands.forEach((command) => {
    if (!byCategory.has(command.category)) {
      byCategory.set(command.category, command);
    }
  });
  const lines = [`Selected validation profiles: ${profileList.length > 0 ? profileList.join(', ') : 'none'}`];
  lines.push('Validation command selection:');
  (['lint', 'static-check', 'test', 'build'] as const).forEach((category) => {
    const selected = byCategory.get(category);
    lines.push(`- ${category}: ${selected ? selected.command : 'none'}`);
  });
  if (usedFileSafetyNet) {
    lines.push('- file-safety-net: enabled because no project-level static-check command was selected');
  } else {
    lines.push('- file-safety-net: disabled');
  }
  return lines.join('\n');
}

function maybeResolvePath(cwd: string, filePath: string): string {
  if (!filePath) {
    return filePath;
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(cwd, filePath);
}

function pushIssue(
  issues: ValidationIssue[],
  source: string,
  message: string,
  cwd: string,
  opts?: {
    filePath?: string;
    line?: number;
    column?: number;
    severity?: 'error' | 'warning';
  },
): void {
  issues.push(
    Object.freeze({
      source,
      severity: opts?.severity ?? 'error',
      message,
      ...(opts?.filePath ? { filePath: maybeResolvePath(cwd, opts.filePath) } : {}),
      ...(typeof opts?.line === 'number' ? { line: opts.line } : {}),
      ...(typeof opts?.column === 'number' ? { column: opts.column } : {}),
    }),
  );
}

function parseIssuesWithCwd(output: string, source: string, cwd: string): readonly ValidationIssue[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100);
  const issues: ValidationIssue[] = [];

  for (const line of lines) {
    let match =
      line.match(/^(.*)\((\d+),(\d+)\):\s+error(?:\s+[A-Z0-9]+)?:\s+(.*)$/i) ||
      line.match(/^(.*)\((\d+),(\d+)\):\s+warning(?:\s+[A-Z0-9]+)?:\s+(.*)$/i);
    if (match) {
      pushIssue(issues, source, match[4] ?? line, cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        severity: /warning/i.test(line) ? 'warning' : 'error',
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }

    match =
      line.match(/^(.*?):(\d+):(\d+)\s*-\s*(error|warning).*?:\s*(.*)$/i) ||
      line.match(/^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/i);
    if (match) {
      pushIssue(issues, source, match[5] ?? line, cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        severity: String(match[4]).toLowerCase() === 'warning' ? 'warning' : 'error',
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }

    match = line.match(/^(.*?):(\d+):\s*(.*)$/);
    if (match && !line.startsWith('Error:')) {
      pushIssue(issues, source, match[3] ?? line, cwd, {
        line: Number(match[2]),
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }

    match = line.match(/^-->\s+(.*?):(\d+):(\d+)$/);
    if (match) {
      pushIssue(issues, source, 'Validation location', cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }

    match = line.match(/^(.+?):(\d+)\s+(.*)$/);
    if (match && (match[1]?.includes('.') || match[1]?.includes('/'))) {
      pushIssue(issues, source, match[3] ?? line, cwd, {
        filePath: match[1],
        line: Number(match[2]),
      });
      continue;
    }

    pushIssue(issues, source, line, cwd);
  }

  return Object.freeze(issues);
}

function commandExists(binary: string, cwd: string): boolean {
  return checkCommandAvailability(binary, cwd);
}

function isCommandAvailable(command: ValidationCommand): boolean {
  if (command.command.startsWith('bun run ')) {
    return commandExists('bun', command.cwd);
  }
  if (command.command.startsWith('bunx ')) {
    return commandExists('bunx', command.cwd);
  }
  if (command.command.startsWith('pnpm run ') || command.command.startsWith('pnpm exec ')) {
    return commandExists('pnpm', command.cwd);
  }
  if (command.command.startsWith('yarn run ') || command.command.startsWith('yarn ')) {
    return commandExists('yarn', command.cwd);
  }
  if (command.command.startsWith('npm run ')) {
    return commandExists('npm', command.cwd);
  }
  if (command.command.startsWith('npx ')) {
    return commandExists('npx', command.cwd);
  }
  if (command.command.startsWith('cargo ')) {
    return commandExists('cargo', command.cwd);
  }
  if (command.command.startsWith('go ')) {
    return commandExists('go', command.cwd);
  }
  if (command.command.startsWith('mvn ')) {
    return commandExists('mvn', command.cwd);
  }
  if (command.command.startsWith('./gradlew ')) {
    return fs.existsSync(path.join(command.cwd, 'gradlew'));
  }
  if (command.command.startsWith('gradle ')) {
    return commandExists('gradle', command.cwd);
  }
  if (command.command.startsWith('dotnet ')) {
    return commandExists('dotnet', command.cwd);
  }
  if (command.command.startsWith('make ')) {
    return commandExists('make', command.cwd);
  }
  if (command.command.startsWith('ruff ')) {
    return commandExists('ruff', command.cwd);
  }
  if (command.command.startsWith('mypy ')) {
    return commandExists('mypy', command.cwd);
  }
  if (command.command === 'pytest') {
    return commandExists('pytest', command.cwd);
  }
  if (command.command.startsWith('python -m ')) {
    return commandExists('python', command.cwd);
  }
  if (command.command === 'vendor/bin/phpstan analyse') {
    return fs.existsSync(path.join(command.cwd, 'vendor/bin/phpstan'));
  }
  if (command.command === 'vendor/bin/phpunit') {
    return fs.existsSync(path.join(command.cwd, 'vendor/bin/phpunit'));
  }
  if (command.command.includes('shellcheck')) {
    return (
      commandExists('shellcheck', command.cwd) &&
      commandExists('find', command.cwd) &&
      commandExists('xargs', command.cwd)
    );
  }
  if (command.command === 'rake test') {
    return commandExists('rake', command.cwd);
  }
  return true;
}

async function runProjectCommand(
  command: ValidationCommand,
  callbacks?: ValidationCommandStreamCallbacks,
): Promise<ValidationRunResult> {
  const startedAt = Date.now();
  const shell = resolveShellProfile();
  const toolCallId = `validation:${command.id}:${startedAt}`;

  return new Promise((resolve) => {
    const child = spawn(shell.executable, [...shell.commandArgs(command.command)], {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildShellEnvironment(),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 120_000);

    void callbacks?.onStart?.({
      toolCallId,
      commandText: command.command,
      cwd: command.cwd,
      startedAt,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout = `${stdout}${text}`.slice(-MAX_VALIDATION_CAPTURE_CHARS);
      void callbacks?.onChunk?.({
        toolCallId,
        chunk: text,
      });
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-MAX_VALIDATION_CAPTURE_CHARS);
      void callbacks?.onChunk?.({
        toolCallId,
        chunk: text,
      });
    });

    const finalize = (
      success: boolean,
      rawOutput: string,
      suffix: 'passed' | 'failed',
      exitCode: number,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      void callbacks?.onEnd?.({
        toolCallId,
        exitCode,
        success,
        durationMs,
      });
      resolve(
        Object.freeze({
          success,
          commandId: command.id,
          command: command.command,
          profile: command.profile,
          category: command.category,
          durationMs,
          summary: `${command.label} ${suffix}`,
          issues: success ? Object.freeze([]) : parseIssuesWithCwd(rawOutput, command.id, command.cwd),
          rawOutputPreview: rawOutput.slice(0, 4000),
        }),
      );
    };

    child.on('error', (error) => {
      finalize(false, String(error), 'failed', 1);
    });
    child.on('close', (code, signal) => {
      const rawOutput = `${stdout}${stderr}`.trim();
      if (code === 0) {
        finalize(true, rawOutput, 'passed', 0);
        return;
      }
      const errorText = rawOutput || `Command exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`;
      finalize(false, errorText, 'failed', code ?? 1);
    });
  });
}

function runFileSafetyNetValidation(sessionFiles: readonly TrackedFile[]): readonly ValidationRunResult[] {
  const supportedExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.json',
    '.py',
    '.sh',
    '.bash',
    '.php',
    '.rb',
  ]);
  const runs: ValidationRunResult[] = [];

  for (const tracked of sessionFiles) {
    const ext = path.extname(tracked.filePath).toLowerCase();
    if (!supportedExtensions.has(ext)) {
      continue;
    }

    const startedAt = Date.now();
    const result = validateCodeTool(tracked.filePath);
    runs.push(
      Object.freeze({
        success: result.success,
        commandId: `file:${tracked.filePath}`,
        command: `validate_code ${tracked.filePath}`,
        profile: 'file',
        category: 'file',
        durationMs: Date.now() - startedAt,
        summary: result.success
          ? `Validation passed for ${tracked.filePath}`
          : `Validation failed for ${tracked.filePath}`,
        issues: result.success
          ? Object.freeze([])
          : parseIssuesWithCwd(result.content || result.error || '', 'validate_code', process.cwd()),
        rawOutputPreview: (result.content || result.error || '').slice(0, 4000),
      }),
    );
  }

  return Object.freeze(runs);
}

async function runCommandPipeline(
  commands: readonly ValidationCommand[],
  callbacks?: ValidationCommandStreamCallbacks,
): Promise<readonly ValidationRunResult[]> {
  const runs: ValidationRunResult[] = [];
  for (const command of commands) {
    const run = await runProjectCommand(command, callbacks);
    runs.push(run);
    if (!run.success) {
      break;
    }
  }
  return Object.freeze(runs);
}

function findFirstFailedRun(runs: readonly ValidationRunResult[]): ValidationRunResult | undefined {
  return runs.find((run) => !run.success);
}

function buildSuccessSummary(runs: readonly ValidationRunResult[]): string {
  if (runs.length === 0) {
    return 'No validation checks executed.';
  }
  return runs.map((run) => run.summary).join('; ');
}

export async function runFinalValidation(opts: {
  workspacePath: string;
  sessionFiles: readonly TrackedFile[];
  config?: Pick<GalaxyConfig, 'validation'>;
  streamCallbacks?: ValidationCommandStreamCallbacks;
}): Promise<FinalValidationResult> {
  const profiles = detectValidationProfiles(opts.workspacePath, opts.sessionFiles);
  const commands = detectProjectCommands(opts.workspacePath, opts.sessionFiles, opts.config?.validation).filter(isCommandAvailable);
  const lintCommands = commands.filter((command) => command.category === 'lint');
  const staticCommands = commands.filter((command) => command.category === 'static-check');
  const testCommands = commands.filter((command) => command.category === 'test');
  const runs: ValidationRunResult[] = [];
  const shouldRunFileSafetyNet = staticCommands.length === 0;
  const selectionSummary = buildValidationSelectionSummary(
    opts.workspacePath,
    profiles,
    commands,
    shouldRunFileSafetyNet,
  );

  if (lintCommands.length > 0 || staticCommands.length > 0) {
    const [lintRuns, staticRuns] = await Promise.all([
      runCommandPipeline(lintCommands, opts.streamCallbacks),
      runCommandPipeline(staticCommands, opts.streamCallbacks),
    ]);

    runs.push(...lintRuns, ...staticRuns);

    const failedStaticGate = findFirstFailedRun([...lintRuns, ...staticRuns]);
    if (failedStaticGate) {
      return Object.freeze({
        success: false,
        mode: 'project',
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedStaticGate.summary,
      });
    }
  }

  if (testCommands.length > 0) {
    const testRuns = await runCommandPipeline(testCommands, opts.streamCallbacks);
    runs.push(...testRuns);

    const failedTest = findFirstFailedRun(testRuns);
    if (failedTest) {
      return Object.freeze({
        success: false,
        mode: 'project',
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedTest.summary,
      });
    }
  }

  if (shouldRunFileSafetyNet) {
    const fileRuns = runFileSafetyNetValidation(opts.sessionFiles);
    runs.push(...fileRuns);

    const failedFileRun = findFirstFailedRun(fileRuns);
    if (failedFileRun) {
      return Object.freeze({
        success: false,
        mode: runs.length === fileRuns.length ? 'file' : 'project',
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedFileRun.summary,
      });
    }

    if (runs.length === 0 && fileRuns.length === 0) {
      return Object.freeze({
        success: true,
        mode: 'none',
        selectionSummary,
        runs: Object.freeze([]),
        summary: 'No validation profile detected for changed files.',
      });
    }

    return Object.freeze({
      success: true,
      mode: runs.length === fileRuns.length ? 'file' : 'project',
      selectionSummary,
      runs: Object.freeze(runs),
      summary: buildSuccessSummary(runs),
    });
  }

  if (runs.length === 0) {
    return Object.freeze({
      success: true,
      mode: 'none',
      selectionSummary,
      runs: Object.freeze([]),
      summary: 'No validation profile detected for changed files.',
    });
  }

  return Object.freeze({
    success: true,
    mode: 'project',
    selectionSummary,
    runs: Object.freeze(runs),
    summary: buildSuccessSummary(runs),
  });
}

export function formatValidationSummary(result: FinalValidationResult): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`Validation (${result.mode})`);
  lines.push('');
  lines.push(result.summary);

  result.runs.forEach((run) => {
    lines.push(`- ${run.success ? 'PASS' : 'FAIL'} [${run.profile}/${run.category}] \`${run.command}\``);
    if (!run.success && run.rawOutputPreview.trim()) {
      lines.push('');
      lines.push('```text');
      lines.push(run.rawOutputPreview.slice(0, 2000));
      lines.push('```');
    }
  });

  return lines.join('\n').trim();
}
