/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Detects project-specific validation and execution commands from workspace files.
 */

import fs from "node:fs";
import path from "node:path";
import { checkCommandAvailability } from "../runtime/shell-resolver";
import type {
  ProjectCommandCategory,
  ProjectCommandDefinition,
  ProjectCommandProfile,
  ProjectCommandRisk,
} from "./entities/project-command";

/**
 * Returns true when a workspace file exists.
 */
function hasFile(workspacePath: string, fileName: string): boolean {
  return fs.existsSync(path.join(workspacePath, fileName));
}

/**
 * Reads a text file and returns an empty string on failure.
 */
function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Returns true when a binary is available in the current workspace runtime.
 */
function hasCommand(binary: string, workspacePath: string): boolean {
  return checkCommandAvailability(binary, workspacePath);
}

/**
 * Extracts npm scripts from package.json when present.
 */
function parsePackageScripts(workspacePath: string): Record<string, string> {
  const packagePath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(packagePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Appends one detected command while preventing duplicate ids or command strings.
 */
function addCommand(
  commands: ProjectCommandDefinition[],
  seen: Set<string>,
  command: ProjectCommandDefinition,
): void {
  if (seen.has(command.id) || seen.has(command.command)) {
    return;
  }
  seen.add(command.id);
  seen.add(command.command);
  commands.push(command);
}

/**
 * Detects common project commands by inspecting manifests and build files.
 */
export function detectProjectCommands(workspacePath: string): Readonly<{
  commands: readonly ProjectCommandDefinition[];
  detectedStack: readonly string[];
}> {
  const resolvedWorkspace = path.resolve(workspacePath);
  const commands: ProjectCommandDefinition[] = [];
  const seen = new Set<string>();
  const detectedStack = new Set<string>();
  const packageScripts = parsePackageScripts(resolvedWorkspace);
  const pyprojectText = hasFile(resolvedWorkspace, "pyproject.toml")
    ? readTextFile(path.join(resolvedWorkspace, "pyproject.toml"))
    : "";
  const makefileText = hasFile(resolvedWorkspace, "Makefile")
    ? readTextFile(path.join(resolvedWorkspace, "Makefile"))
    : "";

  const packageScriptMappings: ReadonlyArray<
    Readonly<{
      script: string;
      category: ProjectCommandCategory;
      risk: ProjectCommandRisk;
    }>
  > = Object.freeze([
    { script: "build", category: "build", risk: "safe" },
    { script: "lint", category: "lint", risk: "safe" },
    { script: "typecheck", category: "typecheck", risk: "safe" },
    { script: "check", category: "typecheck", risk: "safe" },
    { script: "test", category: "test", risk: "confirm" },
  ]);

  if (hasFile(resolvedWorkspace, "package.json")) {
    detectedStack.add("node");
  }

  for (const mapping of packageScriptMappings) {
    if (!packageScripts[mapping.script]) {
      continue;
    }
    addCommand(commands, seen, {
      id: `npm-${mapping.script}`,
      label: `npm run ${mapping.script}`,
      command: `npm run ${mapping.script}`,
      cwd: resolvedWorkspace,
      category: mapping.category,
      source: "detected",
      risk: mapping.risk,
      enabled: true,
      timeoutMs: mapping.category === "test" ? 120_000 : 60_000,
    });
  }

  if (hasFile(resolvedWorkspace, "tsconfig.json")) {
    detectedStack.add("typescript");
    addCommand(commands, seen, {
      id: "tsc-noemit",
      label: "npx tsc --noEmit",
      command: "npx tsc --noEmit",
      cwd: resolvedWorkspace,
      category: "typecheck",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 60_000,
      filePatterns: Object.freeze(["*.ts", "*.tsx"]),
    });
  }

  if (hasFile(resolvedWorkspace, "Cargo.toml")) {
    detectedStack.add("rust");
    addCommand(commands, seen, {
      id: "cargo-check",
      label: "cargo check",
      command: "cargo check",
      cwd: resolvedWorkspace,
      category: "typecheck",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 120_000,
    });
    addCommand(commands, seen, {
      id: "cargo-test",
      label: "cargo test",
      command: "cargo test",
      cwd: resolvedWorkspace,
      category: "test",
      source: "detected",
      risk: "confirm",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (hasFile(resolvedWorkspace, "go.mod")) {
    detectedStack.add("go");
    addCommand(commands, seen, {
      id: "go-build",
      label: "go build ./...",
      command: "go build ./...",
      cwd: resolvedWorkspace,
      category: "build",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 120_000,
    });
    addCommand(commands, seen, {
      id: "go-test",
      label: "go test ./...",
      command: "go test ./...",
      cwd: resolvedWorkspace,
      category: "test",
      source: "detected",
      risk: "confirm",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (
    hasFile(resolvedWorkspace, "pyproject.toml") ||
    hasFile(resolvedWorkspace, "requirements.txt") ||
    hasFile(resolvedWorkspace, "setup.py")
  ) {
    detectedStack.add("python");
    if (
      pyprojectText.includes("[tool.ruff]") ||
      hasFile(resolvedWorkspace, "ruff.toml") ||
      hasFile(resolvedWorkspace, ".ruff.toml")
    ) {
      addCommand(commands, seen, {
        id: "ruff-check",
        label: "ruff check .",
        command: "ruff check .",
        cwd: resolvedWorkspace,
        category: "lint",
        source: "detected",
        risk: "safe",
        enabled: true,
        timeoutMs: 60_000,
      });
    }
    if (
      pyprojectText.includes("[tool.mypy]") ||
      hasFile(resolvedWorkspace, "mypy.ini")
    ) {
      addCommand(commands, seen, {
        id: "mypy-check",
        label: "mypy .",
        command: "mypy .",
        cwd: resolvedWorkspace,
        category: "typecheck",
        source: "detected",
        risk: "safe",
        enabled: true,
        timeoutMs: 120_000,
      });
    }
    addCommand(commands, seen, {
      id: "python-compileall",
      label: "python -m compileall -q .",
      command: "python -m compileall -q .",
      cwd: resolvedWorkspace,
      category: "build",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 60_000,
    });
    addCommand(commands, seen, {
      id: "pytest",
      label: "pytest",
      command: "pytest",
      cwd: resolvedWorkspace,
      category: "test",
      source: "detected",
      risk: "confirm",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (hasFile(resolvedWorkspace, "pom.xml")) {
    detectedStack.add("java");
    addCommand(commands, seen, {
      id: "maven-compile",
      label: "mvn -q -DskipTests compile",
      command: "mvn -q -DskipTests compile",
      cwd: resolvedWorkspace,
      category: "build",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (
    hasFile(resolvedWorkspace, "build.gradle") ||
    hasFile(resolvedWorkspace, "build.gradle.kts")
  ) {
    detectedStack.add("gradle");
    const gradleCommand =
      process.platform === "win32" && hasFile(resolvedWorkspace, "gradlew.bat")
        ? "gradlew.bat classes"
        : hasFile(resolvedWorkspace, "gradlew")
          ? "./gradlew classes"
          : "gradle classes";
    addCommand(commands, seen, {
      id: "gradle-classes",
      label: gradleCommand,
      command: gradleCommand,
      cwd: resolvedWorkspace,
      category: "build",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (
    fs
      .readdirSync(resolvedWorkspace)
      .some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"))
  ) {
    detectedStack.add(".net");
    addCommand(commands, seen, {
      id: "dotnet-build",
      label: "dotnet build --nologo",
      command: "dotnet build --nologo",
      cwd: resolvedWorkspace,
      category: "build",
      source: "detected",
      risk: "safe",
      enabled: true,
      timeoutMs: 180_000,
    });
  }

  if (makefileText && hasCommand("make", resolvedWorkspace)) {
    for (const [target, category, risk] of [
      ["lint", "lint", "safe"],
      ["check", "typecheck", "safe"],
      ["typecheck", "typecheck", "safe"],
      ["build", "build", "safe"],
      ["test", "test", "confirm"],
    ] as const) {
      if (!new RegExp(`^${target}:`, "m").test(makefileText)) {
        continue;
      }
      addCommand(commands, seen, {
        id: `make-${target}`,
        label: `make ${target}`,
        command: `make ${target}`,
        cwd: resolvedWorkspace,
        category,
        source: "detected",
        risk,
        enabled: true,
        timeoutMs: risk === "confirm" ? 180_000 : 120_000,
      });
    }
  }

  if (hasFile(resolvedWorkspace, "composer.json")) {
    detectedStack.add("php");
    const composerText = readTextFile(
      path.join(resolvedWorkspace, "composer.json"),
    );
    if (composerText.includes("phpstan")) {
      const phpstanCommand =
        process.platform === "win32" &&
        hasFile(resolvedWorkspace, "vendor/bin/phpstan.bat")
          ? "vendor/bin/phpstan.bat analyse"
          : "vendor/bin/phpstan analyse";
      addCommand(commands, seen, {
        id: "phpstan-analyse",
        label: phpstanCommand,
        command: phpstanCommand,
        cwd: resolvedWorkspace,
        category: "typecheck",
        source: "detected",
        risk: "safe",
        enabled: true,
        timeoutMs: 120_000,
      });
    }
  }

  return Object.freeze({
    commands: Object.freeze(commands),
    detectedStack: Object.freeze([...detectedStack]),
  });
}
