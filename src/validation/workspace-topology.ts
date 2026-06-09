/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-26
 * @modify date 2026-05-26
 * @desc Workspace package topology and framework validation contracts for VS Code validation.
 */

import fs from "node:fs";
import path from "node:path";
import type { ValidationCommandCategory, ValidationIssue } from "../shared/validation";
import type { TrackedFile } from "../shared/runtime";
import {
  detectNodePackageManager,
  parsePackageDependencyNames,
  parsePackageScripts,
} from "./node";

type FrameworkId = "next" | "vite" | "nestjs" | "node" | "unknown";

export type WorkspaceValidationPackage = Readonly<{
  name: string;
  path: string;
  relativePath: string;
  packageManager: string;
  scripts: Readonly<Record<string, string>>;
  dependencies: ReadonlySet<string>;
  framework: FrameworkId;
  contractIssues: readonly ValidationIssue[];
}>;

export type WorkspaceValidationTopology = Readonly<{
  workspacePath: string;
  packages: readonly WorkspaceValidationPackage[];
}>;

export type TestingCommandPolicy = Readonly<{
  allowed: boolean;
  category?: Exclude<ValidationCommandCategory, "file"> | "setup";
  packagePath?: string | undefined;
  reason?: string;
}>;

const IGNORED_DIRS = new Set([
  ".git",
  ".galaxy",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageName(packagePath: string): string {
  const parsed = readJsonFile(path.join(packagePath, "package.json"));
  const name = typeof parsed?.name === "string" && parsed.name.trim()
    ? parsed.name.trim()
    : path.basename(packagePath);
  return name;
}

function detectFramework(dependencies: ReadonlySet<string>, scripts: Readonly<Record<string, string>>): FrameworkId {
  const scriptText = Object.values(scripts).join("\n").toLowerCase();
  if (dependencies.has("next") || /\bnext\s+(dev|build|start|lint)\b/.test(scriptText)) return "next";
  if (dependencies.has("@nestjs/core") || dependencies.has("@nestjs/common") || /\bnest\s+/.test(scriptText)) return "nestjs";
  if (dependencies.has("vite") || /\bvite\b/.test(scriptText)) return "vite";
  if (dependencies.size > 0 || Object.keys(scripts).length > 0) return "node";
  return "unknown";
}

function scanPackageRoots(workspacePath: string, maxDepth = 4): readonly string[] {
  const roots: string[] = [];
  const visit = (dirPath: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      roots.push(dirPath);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name), depth + 1);
    }
  };
  visit(workspacePath, 0);
  return Object.freeze([...new Set(roots)].sort((a, b) => {
    if (a === workspacePath) return -1;
    if (b === workspacePath) return 1;
    return a.localeCompare(b);
  }));
}

function hasTypeScriptTests(packagePath: string): boolean {
  const testPath = path.join(packagePath, "test");
  const visit = (dirPath: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && visit(absolutePath)) return true;
      if (entry.isFile() && /\.(test|spec)\.tsx?$/.test(entry.name)) return true;
    }
    return false;
  };
  return visit(testPath);
}

function buildIssue(packagePath: string, message: string, source: string): ValidationIssue {
  return Object.freeze({
    severity: "error" as const,
    message,
    filePath: packagePath,
    source,
  });
}

function collectContractIssues(opts: {
  packagePath: string;
  framework: FrameworkId;
  scripts: Readonly<Record<string, string>>;
  dependencies: ReadonlySet<string>;
}): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const testScript = opts.scripts.test?.trim() ?? "";
  const tsTests = hasTypeScriptTests(opts.packagePath);

  if (opts.framework === "next") {
    const tsconfig = readJsonFile(path.join(opts.packagePath, "tsconfig.json"));
    if (tsconfig?.extends === "next/core-web-vitals") {
      issues.push(buildIssue(
        path.join(opts.packagePath, "tsconfig.json"),
        "Next.js TypeScript config must not extend next/core-web-vitals; that is an ESLint preset, not a tsconfig base.",
        "next-tsconfig-contract",
      ));
    }
  }

  if (testScript) {
    const lowered = testScript.toLowerCase();
    if (/\bts-node\b.*\s--test\b/.test(lowered)) {
      issues.push(buildIssue(
        path.join(opts.packagePath, "package.json"),
        "TypeScript tests must not use ts-node --test; use a declared app-local runner such as node --import tsx --test, vitest, or jest.",
        "typescript-test-runner-contract",
      ));
    }
    if (/\bnode\b.*--require\s+ts-node\/register\b.*\s--test\b/.test(lowered)) {
      issues.push(buildIssue(
        path.join(opts.packagePath, "package.json"),
        "TypeScript tests must not use node --require ts-node/register --test for framework app tests; use node --import tsx --test, vitest, or jest.",
        "typescript-test-runner-contract",
      ));
    }
    if (
      tsTests &&
      /\bnode\b.*\s--test\b/.test(lowered) &&
      !/\btsx\b|--import\s+tsx|--loader\s+ts-node\/esm|\bvitest\b|\bjest\b/.test(lowered)
    ) {
      issues.push(buildIssue(
        path.join(opts.packagePath, "package.json"),
        "TypeScript test files require a TypeScript-capable runner; bare node --test cannot execute app .ts/.tsx tests reliably.",
        "typescript-test-runner-contract",
      ));
    }
  }

  if (tsTests && !testScript) {
    issues.push(buildIssue(
      path.join(opts.packagePath, "package.json"),
      "Package has TypeScript tests but no scripts.test entry.",
      "typescript-test-runner-contract",
    ));
  }

  return Object.freeze(issues);
}

export function buildWorkspaceValidationTopology(workspacePath: string): WorkspaceValidationTopology {
  const packages = scanPackageRoots(workspacePath).map((packagePath) => {
    const scripts = parsePackageScripts(packagePath);
    const dependencies = parsePackageDependencyNames(packagePath);
    const framework = detectFramework(dependencies, scripts);
    return Object.freeze({
      name: packageName(packagePath),
      path: packagePath,
      relativePath: path.relative(workspacePath, packagePath) || ".",
      packageManager: detectNodePackageManager(packagePath),
      scripts,
      dependencies,
      framework,
      contractIssues: collectContractIssues({ packagePath, framework, scripts, dependencies }),
    });
  });
  return Object.freeze({ workspacePath, packages: Object.freeze(packages) });
}

export function selectValidationPackagesForFiles(
  topology: WorkspaceValidationTopology,
  sessionFiles: readonly TrackedFile[],
): readonly WorkspaceValidationPackage[] {
  if (sessionFiles.length === 0) return topology.packages;
  const selected = new Set<WorkspaceValidationPackage>();
  for (const file of sessionFiles) {
    const absoluteFile = path.resolve(file.filePath);
    const owner = [...topology.packages]
      .sort((a, b) => b.path.length - a.path.length)
      .find((candidate) => absoluteFile === candidate.path || absoluteFile.startsWith(`${candidate.path}${path.sep}`));
    if (owner) selected.add(owner);
  }
  return Object.freeze([...selected]);
}

export function collectValidationContractIssues(
  workspacePath: string,
  sessionFiles: readonly TrackedFile[],
): readonly ValidationIssue[] {
  const topology = buildWorkspaceValidationTopology(workspacePath);
  const packages = selectValidationPackagesForFiles(topology, sessionFiles);
  return Object.freeze(packages.flatMap((pkg) => pkg.contractIssues));
}

function commandCategory(command: string): Exclude<ValidationCommandCategory, "file"> | "setup" | null {
  const lowered = command.trim().toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(lowered)) return "setup";
  if (/\b(test|jest|vitest|playwright\s+test)\b/.test(lowered)) return "test";
  if (/\b(typecheck|type-check|check-types|tsc)\b/.test(lowered)) return "static-check";
  if (/\b(lint|eslint|biome|oxlint)\b/.test(lowered)) return "lint";
  if (/\b(build|compile|next\s+build|vite\s+build|nest\s+build)\b/.test(lowered)) return "build";
  return null;
}

function closestPackageForCwd(topology: WorkspaceValidationTopology, cwd: string): WorkspaceValidationPackage | null {
  const resolved = path.resolve(topology.workspacePath, cwd || ".");
  return [...topology.packages]
    .sort((a, b) => b.path.length - a.path.length)
    .find((candidate) => resolved === candidate.path || resolved.startsWith(`${candidate.path}${path.sep}`)) ?? null;
}

function unquoteShellPath(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeCommandForComparison(command: string): string {
  return command
    .replace(/\s+2>\s*&1\s*$/i, "")
    .replace(/\s+1>\s*&2\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeCommand(command: string): readonly string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return Object.freeze(tokens.map(unquoteShellPath));
}

function isTargetLikeToken(token: string): boolean {
  const normalized = token.trim();
  if (!normalized || normalized.startsWith("-")) return false;
  return (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[*?[\]{}]/.test(normalized) ||
    /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)
  );
}

function tokensStartWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => tokens[index] === token);
}

function trimTrailingTargetTokens(tokens: readonly string[]): readonly string[] {
  let end = tokens.length;
  while (end > 0 && isTargetLikeToken(tokens[end - 1] ?? "")) {
    end -= 1;
  }
  return Object.freeze(tokens.slice(0, end));
}

function isFocusedScriptCommand(command: string, scriptCommand: string): boolean {
  const commandTokens = tokenizeCommand(normalizeCommandForComparison(command));
  const scriptTokens = tokenizeCommand(normalizeCommandForComparison(scriptCommand));
  if (commandTokens.length === 0 || scriptTokens.length === 0) return false;
  if (tokensStartWith(commandTokens, scriptTokens)) {
    const extraTokens = commandTokens.slice(scriptTokens.length);
    return extraTokens.length > 0 && extraTokens.every(isTargetLikeToken);
  }
  const scriptPrefix = trimTrailingTargetTokens(scriptTokens);
  if (scriptPrefix.length === scriptTokens.length || !tokensStartWith(commandTokens, scriptPrefix)) {
    return false;
  }
  const replacementTargets = commandTokens.slice(scriptPrefix.length);
  return replacementTargets.length > 0 && replacementTargets.every(isTargetLikeToken);
}

function normalizeTestingCommandContext(command: string, cwd: string): Readonly<{ command: string; cwd: string }> {
  let normalized = normalizeCommandForComparison(command);
  let normalizedCwd = cwd || ".";
  const cdMatch = normalized.match(/^cd\s+("[^"]+"|'[^']+'|[^\s&;|`]+)\s*&&\s*(.+)$/);
  if (cdMatch) {
    normalizedCwd = unquoteShellPath(cdMatch[1] ?? normalizedCwd);
    normalized = normalizeCommandForComparison(cdMatch[2] ?? "");
  }
  return Object.freeze({ command: normalized, cwd: normalizedCwd });
}

function isScriptInvocation(command: string, scripts: Readonly<Record<string, string>>): boolean {
  const normalized = normalizeCommandForComparison(command);
  const scriptNames = Object.keys(scripts);
  const invokesPackageScript = scriptNames.some((scriptName) => {
    const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^(npm run ${escaped}|npm ${escaped}|pnpm run ${escaped}|pnpm ${escaped}|yarn run ${escaped}|yarn ${escaped}|bun run ${escaped})(?:\\s|$)`).test(normalized);
  });
  if (invokesPackageScript) return true;
  return Object.values(scripts).some((scriptCommand) => {
    const normalizedScript = normalizeCommandForComparison(scriptCommand);
    return normalizedScript === normalized || isFocusedScriptCommand(normalized, normalizedScript);
  });
}

export function evaluateTestingCommandPolicy(
  workspacePath: string,
  command: string,
  cwd: string,
): TestingCommandPolicy {
  const normalizedContext = normalizeTestingCommandContext(command, cwd);
  const category = commandCategory(normalizedContext.command);
  if (!category) return Object.freeze({ allowed: true });
  const topology = buildWorkspaceValidationTopology(workspacePath);
  const pkg = closestPackageForCwd(topology, normalizedContext.cwd);
  if (category === "setup") {
    return Object.freeze({
      allowed: false,
      category,
      packagePath: pkg?.path,
      reason: "Testing Agent cannot install or add dependencies directly. Report the missing setup requirement or use the environment setup flow.",
    });
  }
  if (!pkg) return Object.freeze({ allowed: true, category });
  if (isScriptInvocation(normalizedContext.command, pkg.scripts)) {
    return Object.freeze({ allowed: true, category, packagePath: pkg.path });
  }
  return Object.freeze({
    allowed: false,
    category,
    packagePath: pkg.path,
    reason: `Testing Agent validation commands must use package scripts from ${pkg.relativePath}/package.json, a focused path/glob variant of a declared script, or run_validation_suite. Blocked command: ${command}`,
  });
}
