/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation command detection helpers for the VS Code runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TrackedFile } from '../shared/runtime';
import type { ValidationCommand, ValidationPreferencesConfig } from '../shared/validation';
import {
  buildNodeExecCommand,
  buildNodeScriptCommand,
  detectNodePackageManager,
  hasDirectory,
  hasFile,
  parsePackageDependencyNames,
  parsePackageScripts,
  selectNodeValidationScripts,
} from './node';
import { detectValidationProfiles, hasTrackedExtension } from './profiles';

/**
 * Reads a text file for validation heuristics and returns an empty string when unavailable.
 *
 * @param filePath Absolute file path to inspect.
 * @returns UTF-8 text content or an empty string when the file cannot be read.
 */
function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Adds a candidate validation command while deduplicating by stage and exact command text.
 *
 * @param commands Mutable command accumulator.
 * @param seen Set used to suppress duplicate commands.
 * @param command Candidate validation command to append when unique.
 */
function addProjectCommand(commands: ValidationCommand[], seen: Set<string>, command: ValidationCommand): void {
  const dedupeKey = `${command.category}:${command.command}`;
  if (seen.has(dedupeKey)) {return;}
  seen.add(dedupeKey);
  commands.push(command);
}

/**
 * Detects project-level validation commands that match the current workspace and touched files.
 *
 * @param workspacePath Absolute workspace root used for config and manifest discovery.
 * @param sessionFiles Files involved in the current turn.
 * @param validationPreferences Optional command preferences from user config.
 * @returns Ordered validation commands used by the quality gate.
 */
export function detectProjectCommands(
  workspacePath: string,
  sessionFiles: readonly TrackedFile[],
  validationPreferences?: ValidationPreferencesConfig,
): readonly ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  const seenCommands = new Set<string>();
  const packageScripts = parsePackageScripts(workspacePath);
  const packageDependencyNames = parsePackageDependencyNames(workspacePath);
  const pyprojectText = hasFile(workspacePath, 'pyproject.toml') ? readTextFile(path.join(workspacePath, 'pyproject.toml')) : '';
  const makefileText = hasFile(workspacePath, 'Makefile') ? readTextFile(path.join(workspacePath, 'Makefile')) : '';
  const composerText = hasFile(workspacePath, 'composer.json') ? readTextFile(path.join(workspacePath, 'composer.json')) : '';
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

  if (profiles.has('typescript') && hasFile(workspacePath, 'tsconfig.json') && !selectedNodeScripts.some((candidate) => candidate.category === 'static-check')) {
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
    addProjectCommand(commands, seenCommands, { id: 'cargo-check', label: 'cargo check', command: 'cargo check', cwd: workspacePath, kind: 'project', profile: 'rust', category: 'static-check' });
    addProjectCommand(commands, seenCommands, { id: 'cargo-test', label: 'cargo test', command: 'cargo test', cwd: workspacePath, kind: 'project', profile: 'rust', category: 'test' });
    addProjectCommand(commands, seenCommands, { id: 'cargo-build', label: 'cargo build', command: 'cargo build', cwd: workspacePath, kind: 'project', profile: 'rust', category: 'build' });
  }

  if (profiles.has('go')) {
    addProjectCommand(commands, seenCommands, { id: 'go-test', label: 'go test ./...', command: 'go test ./...', cwd: workspacePath, kind: 'project', profile: 'go', category: 'test' });
    addProjectCommand(commands, seenCommands, { id: 'go-build', label: 'go build ./...', command: 'go build ./...', cwd: workspacePath, kind: 'project', profile: 'go', category: 'build' });
  }

  if (profiles.has('python') && hasPythonFiles && (hasFile(workspacePath, 'pyproject.toml') || hasFile(workspacePath, 'requirements.txt') || hasFile(workspacePath, 'setup.py'))) {
    if (pyprojectText.includes('[tool.ruff]') || hasFile(workspacePath, 'ruff.toml') || hasFile(workspacePath, '.ruff.toml')) {
      addProjectCommand(commands, seenCommands, { id: 'ruff-check', label: 'ruff check .', command: 'ruff check .', cwd: workspacePath, kind: 'project', profile: 'python', category: 'lint' });
    }
    if (pyprojectText.includes('[tool.mypy]') || hasFile(workspacePath, 'mypy.ini')) {
      addProjectCommand(commands, seenCommands, { id: 'mypy-check', label: 'mypy .', command: 'mypy .', cwd: workspacePath, kind: 'project', profile: 'python', category: 'static-check' });
    }
    if (pyprojectText.includes('pytest') || hasFile(workspacePath, 'pytest.ini') || hasFile(workspacePath, 'tox.ini') || hasDirectory(workspacePath, 'tests')) {
      addProjectCommand(commands, seenCommands, { id: 'pytest', label: 'pytest', command: 'pytest', cwd: workspacePath, kind: 'project', profile: 'python', category: 'test' });
    }
  }

  if (profiles.has('java') && hasFile(workspacePath, 'pom.xml')) {
    addProjectCommand(commands, seenCommands, { id: 'maven-compile', label: 'mvn -q -DskipTests compile', command: 'mvn -q -DskipTests compile', cwd: workspacePath, kind: 'project', profile: 'java', category: 'static-check' });
    addProjectCommand(commands, seenCommands, { id: 'maven-test', label: 'mvn -q test', command: 'mvn -q test', cwd: workspacePath, kind: 'project', profile: 'java', category: 'test' });
  }

  if (profiles.has('java') && (hasFile(workspacePath, 'build.gradle') || hasFile(workspacePath, 'build.gradle.kts'))) {
    const gradleExecutable = hasFile(workspacePath, 'gradlew') ? './gradlew' : 'gradle';
    addProjectCommand(commands, seenCommands, { id: 'gradle-classes', label: `${gradleExecutable} classes`, command: `${gradleExecutable} classes`, cwd: workspacePath, kind: 'project', profile: 'java', category: 'static-check' });
    addProjectCommand(commands, seenCommands, { id: 'gradle-test', label: `${gradleExecutable} test`, command: `${gradleExecutable} test`, cwd: workspacePath, kind: 'project', profile: 'java', category: 'test' });
  }

  const rootEntries = fs.existsSync(workspacePath) ? fs.readdirSync(workspacePath) : [];
  if (profiles.has('dotnet') && rootEntries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
    addProjectCommand(commands, seenCommands, { id: 'dotnet-build', label: 'dotnet build --nologo', command: 'dotnet build --nologo', cwd: workspacePath, kind: 'project', profile: 'dotnet', category: 'static-check' });
    addProjectCommand(commands, seenCommands, { id: 'dotnet-test', label: 'dotnet test --nologo', command: 'dotnet test --nologo', cwd: workspacePath, kind: 'project', profile: 'dotnet', category: 'test' });
  }

  if (makefileText) {
    for (const target of ['lint']) {
      if (!new RegExp(`^${target}:`, 'm').test(makefileText)) {continue;}
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
      if (!new RegExp(`^${target}:`, 'm').test(makefileText)) {continue;}
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
      addProjectCommand(commands, seenCommands, { id: 'phpstan-analyse', label: 'vendor/bin/phpstan analyse', command: 'vendor/bin/phpstan analyse', cwd: workspacePath, kind: 'project', profile: 'php', category: 'static-check' });
    }
    if (composerText.includes('phpunit') && fs.existsSync(path.join(workspacePath, 'vendor/bin/phpunit'))) {
      addProjectCommand(commands, seenCommands, { id: 'phpunit', label: 'vendor/bin/phpunit', command: 'vendor/bin/phpunit', cwd: workspacePath, kind: 'project', profile: 'php', category: 'test' });
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
    addProjectCommand(commands, seenCommands, { id: 'rake-test', label: 'rake test', command: 'rake test', cwd: workspacePath, kind: 'project', profile: 'ruby', category: 'test' });
  }

  return Object.freeze(commands);
}
