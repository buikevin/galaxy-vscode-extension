/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation profile detection helpers for the VS Code runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TrackedFile } from '../shared/runtime';
import type { ValidationProfileId } from '../shared/validation';
import { hasFile } from './node';

/**
 * Checks whether any tracked file matches one of the provided extensions.
 *
 * @param sessionFiles Files edited or read in the current session.
 * @param extensions File extensions that should activate a profile.
 * @returns `true` when at least one tracked file uses one of the supplied extensions.
 */
export function hasTrackedExtension(sessionFiles: readonly TrackedFile[], extensions: readonly string[]): boolean {
  const extSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  return sessionFiles.some((file) => extSet.has(path.extname(file.filePath).toLowerCase()));
}

/**
 * Infers the validation profiles that should participate in quality gates for the workspace.
 *
 * @param workspacePath Absolute workspace root used for manifest and config discovery.
 * @param sessionFiles Files touched in the current turn, used to bias toward relevant languages.
 * @returns Ordered profile identifiers that should be used for command detection.
 */
export function detectValidationProfiles(
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

  if (hasFile(workspacePath, 'package.json') || hasJs) {push('javascript');}
  if (hasFile(workspacePath, 'tsconfig.json') || hasTs) {push('typescript');}
  if (hasPython || hasFile(workspacePath, 'pyproject.toml') || hasFile(workspacePath, 'requirements.txt') || hasFile(workspacePath, 'setup.py')) {push('python');}
  if (hasJava || hasFile(workspacePath, 'pom.xml') || hasFile(workspacePath, 'build.gradle') || hasFile(workspacePath, 'build.gradle.kts')) {push('java');}
  if (hasGo || hasFile(workspacePath, 'go.mod')) {push('go');}
  if (hasRust || hasFile(workspacePath, 'Cargo.toml')) {push('rust');}
  if (fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {push('dotnet');}
  if (hasPhp && hasFile(workspacePath, 'composer.json')) {push('php');}
  if (hasShell && hasFile(workspacePath, '.shellcheckrc')) {push('shell');}
  if (hasRuby && hasFile(workspacePath, 'Rakefile')) {push('ruby');}

  return Object.freeze(profiles);
}
