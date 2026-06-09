import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type EnvironmentRequirementKind =
  | "runtime"
  | "package_manager"
  | "database"
  | "system_tool";

export type EnvironmentRequirement = Readonly<{
  id: string;
  label: string;
  command: string;
  args: readonly string[];
  kind: EnvironmentRequirementKind;
  required: boolean;
  source: string;
  versionHint?: string;
}>;

export type EnvironmentToolStatus = "available" | "missing" | "error";

export type EnvironmentToolCheck = Readonly<{
  requirement: EnvironmentRequirement;
  status: EnvironmentToolStatus;
  versionText?: string;
  error?: string;
}>;

export type EnvironmentReadinessStatus =
  | "ready"
  | "missing_required"
  | "missing_optional"
  | "unverified";

export type EnvironmentDependencyCheck = Readonly<{
  projectPath: string;
  relativePath: string;
  manifest: string;
  dependencyPath: string;
  dependencyRelativePath: string;
  packageManager?: string;
  required: boolean;
  installed: boolean;
  source: string;
}>;

export type LocalMachineProfile = Readonly<{
  platform: NodeJS.Platform;
  osType: string;
  release: string;
  arch: string;
  shell?: string;
  homeDir?: string;
  pathSeparator: string;
}>;

export type EnvironmentReadinessReport = Readonly<{
  workspacePath: string;
  fingerprint: string;
  status: EnvironmentReadinessStatus;
  machine: LocalMachineProfile;
  inspectedFiles: readonly string[];
  requirements: readonly EnvironmentRequirement[];
  checks: readonly EnvironmentToolCheck[];
  dependencyChecks: readonly EnvironmentDependencyCheck[];
  generatedAt: number;
}>;

export type EnvironmentSetupDecision =
  | "continue"
  | "ai_install"
  | "manual_install"
  | "code_without_verified_environment"
  | "change_architecture"
  | "cancel";

export type EnvironmentSetupDecisionOption = Readonly<{
  id: string;
  label: string;
  description: string;
  decision: EnvironmentSetupDecision;
}>;

export type EnvironmentSetupDecisionRequest = Readonly<{
  id: string;
  title: string;
  question: string;
  reason: string;
  report: EnvironmentReadinessReport;
  options: readonly EnvironmentSetupDecisionOption[];
}>;

export type EnvironmentProfile = Readonly<{
  workspacePath: string;
  fingerprint: string;
  report: EnvironmentReadinessReport;
  decision?: EnvironmentSetupDecision;
  savedAt: number;
  expiresAt: number;
}>;

export type EnvironmentSetupCommand = Readonly<{
  id: string;
  label: string;
  command: string;
  cwd?: string;
  reason: string;
}>;

export type EnvironmentSetupPlan = Readonly<{
  report: EnvironmentReadinessReport;
  commands: readonly EnvironmentSetupCommand[];
  unsupported: readonly string[];
}>;

export type EnvironmentSetupCommandResult = Readonly<{
  command: EnvironmentSetupCommand;
  success: boolean;
  content: string;
  error?: string;
}>;

export type EnvironmentSetupRunSummary = Readonly<{
  plan: EnvironmentSetupPlan;
  results: readonly EnvironmentSetupCommandResult[];
  reportAfter: EnvironmentReadinessReport;
}>;

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INSPECTION_FILES = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  ".nvmrc",
  ".node-version",
  "composer.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".tool-versions",
  ".mise.toml",
  ".devcontainer/devcontainer.json",
];
const NESTED_INSPECTION_FILENAMES = new Set([
  "package.json",
  "composer.json",
  "Gemfile",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "*.csproj",
  "*.sln",
  "CMakeLists.txt",
]);
const INSPECTION_IGNORED_DIRS = new Set([
  ".git",
  ".galaxy",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "bin",
  "obj",
]);

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function inspectLocalMachineProfile(): LocalMachineProfile {
  return Object.freeze({
    platform: process.platform,
    osType: os.type(),
    release: os.release(),
    arch: os.arch(),
    ...(process.env.SHELL ? { shell: process.env.SHELL } : {}),
    ...(process.env.HOME ? { homeDir: process.env.HOME } : {}),
    pathSeparator: path.sep,
  });
}

function fileExists(workspacePath: string, relativePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, relativePath));
}

function relativeToWorkspace(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath) || ".";
}

function matchesNestedInspectionFile(fileName: string): boolean {
  if (NESTED_INSPECTION_FILENAMES.has(fileName)) return true;
  return /\.csproj$/i.test(fileName) || /\.sln$/i.test(fileName);
}

function scanInspectionFiles(workspacePath: string, maxDepth = 5): readonly string[] {
  const found = new Set<string>();
  const visit = (dirPath: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isFile() && matchesNestedInspectionFile(entry.name)) {
        found.add(relativeToWorkspace(workspacePath, absolutePath));
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || INSPECTION_IGNORED_DIRS.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name), depth + 1);
    }
  };
  visit(workspacePath, 0);
  for (const relativePath of INSPECTION_FILES) {
    if (fileExists(workspacePath, relativePath)) found.add(relativePath);
  }
  return Object.freeze([...found].sort((a, b) => {
    if (a === "package.json") return -1;
    if (b === "package.json") return 1;
    return a.localeCompare(b);
  }));
}

function addRequirement(
  requirements: EnvironmentRequirement[],
  requirement: EnvironmentRequirement,
): void {
  if (requirements.some((item) => item.id === requirement.id)) return;
  requirements.push(Object.freeze(requirement));
}

function readPackageJson(packagePath: string): Record<string, unknown> | null {
  const raw = readText(path.join(packagePath, "package.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolvePackageManager(workspacePath: string, pkg: Record<string, unknown> | null): EnvironmentRequirement {
  const packageManager = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  if (fileExists(workspacePath, "pnpm-lock.yaml") || packageManager.startsWith("pnpm@")) {
    return Object.freeze({
      id: "package-manager:pnpm",
      label: "pnpm",
      command: "pnpm",
      args: ["--version"],
      kind: "package_manager",
      required: true,
      source: "pnpm lockfile or packageManager",
    });
  }
  if (fileExists(workspacePath, "yarn.lock") || packageManager.startsWith("yarn@")) {
    return Object.freeze({
      id: "package-manager:yarn",
      label: "Yarn",
      command: "yarn",
      args: ["--version"],
      kind: "package_manager",
      required: true,
      source: "yarn lockfile or packageManager",
    });
  }
  if (fileExists(workspacePath, "bun.lock") || fileExists(workspacePath, "bun.lockb") || packageManager.startsWith("bun@")) {
    return Object.freeze({
      id: "package-manager:bun",
      label: "Bun",
      command: "bun",
      args: ["--version"],
      kind: "package_manager",
      required: true,
      source: "bun lockfile or packageManager",
    });
  }
  return Object.freeze({
    id: "package-manager:npm",
    label: "npm",
    command: "npm",
    args: ["--version"],
    kind: "package_manager",
    required: true,
    source: "package.json",
  });
}

export function inspectProjectStack(workspacePath: string): Readonly<{
  inspectedFiles: readonly string[];
  requirements: readonly EnvironmentRequirement[];
  dependencyChecks: readonly EnvironmentDependencyCheck[];
}> {
  const resolved = path.resolve(workspacePath);
  const inspectedFiles = scanInspectionFiles(resolved);
  const requirements: EnvironmentRequirement[] = [];
  const dependencyChecks: EnvironmentDependencyCheck[] = [];
  const packageJsonFiles = inspectedFiles.filter((relativePath) => path.basename(relativePath) === "package.json");
  const rootPackagePath = path.join(resolved, "package.json");
  const pkg = readPackageJson(resolved);

  if (pkg) {
    const engines = typeof pkg.engines === "object" && pkg.engines ? pkg.engines as Record<string, unknown> : {};
    addRequirement(requirements, {
      id: "runtime:node",
      label: "Node.js",
      command: "node",
      args: ["--version"],
      kind: "runtime",
      required: true,
      source: "package.json",
      ...(typeof engines.node === "string" ? { versionHint: engines.node } : {}),
    });
    addRequirement(requirements, resolvePackageManager(resolved, pkg));
  }

  for (const relativeManifest of packageJsonFiles) {
    const packagePath = path.dirname(path.join(resolved, relativeManifest));
    const packageRelativePath = relativeToWorkspace(resolved, packagePath);
    const packageJson = readPackageJson(packagePath);
    const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    const hasDeclaredDependencies = dependencySections.some((section) => {
      const value = packageJson?.[section];
      return Boolean(value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0);
    });
    const scripts = packageJson?.scripts;
    const hasScripts = Boolean(scripts && typeof scripts === "object" && Object.keys(scripts as Record<string, unknown>).length > 0);
    if (packageJson && packagePath !== path.dirname(rootPackagePath)) {
      addRequirement(requirements, {
        id: "runtime:node",
        label: "Node.js",
        command: "node",
        args: ["--version"],
        kind: "runtime",
        required: true,
        source: relativeManifest,
      });
      addRequirement(requirements, resolvePackageManager(packagePath, packageJson));
    }
    if (packageJson && (hasDeclaredDependencies || hasScripts)) {
      const dependencyPath = path.join(packagePath, "node_modules");
      dependencyChecks.push(Object.freeze({
        projectPath: packagePath,
        relativePath: packageRelativePath,
        manifest: relativeManifest,
        dependencyPath,
        dependencyRelativePath: relativeToWorkspace(resolved, dependencyPath),
        packageManager: resolvePackageManager(packagePath, packageJson).label.toLowerCase(),
        required: hasDeclaredDependencies,
        installed: fs.existsSync(dependencyPath),
        source: hasDeclaredDependencies ? "package dependencies" : "package scripts",
      }));
    }
  }

  const nvmVersion = readText(path.join(resolved, ".nvmrc"))?.trim()
    ?? readText(path.join(resolved, ".node-version"))?.trim();
  if (nvmVersion) {
    addRequirement(requirements, {
      id: "runtime:node",
      label: "Node.js",
      command: "node",
      args: ["--version"],
      kind: "runtime",
      required: true,
      source: ".nvmrc/.node-version",
      versionHint: nvmVersion,
    });
  }

  if (fileExists(resolved, "composer.json")) {
    addRequirement(requirements, {
      id: "runtime:php",
      label: "PHP",
      command: "php",
      args: ["--version"],
      kind: "runtime",
      required: true,
      source: "composer.json",
    });
    addRequirement(requirements, {
      id: "package-manager:composer",
      label: "Composer",
      command: "composer",
      args: ["--version"],
      kind: "package_manager",
      required: true,
      source: "composer.json",
    });
  }

  if (fileExists(resolved, "go.mod")) {
    addRequirement(requirements, {
      id: "runtime:go",
      label: "Go",
      command: "go",
      args: ["version"],
      kind: "runtime",
      required: true,
      source: "go.mod",
    });
  }

  if (fileExists(resolved, "pyproject.toml") || fileExists(resolved, "requirements.txt") || fileExists(resolved, "Pipfile")) {
    addRequirement(requirements, {
      id: "runtime:python",
      label: "Python",
      command: "python3",
      args: ["--version"],
      kind: "runtime",
      required: true,
      source: "Python project files",
    });
  }

  if (fileExists(resolved, "pom.xml")) {
    addRequirement(requirements, {
      id: "runtime:java",
      label: "Java",
      command: "java",
      args: ["-version"],
      kind: "runtime",
      required: true,
      source: "pom.xml",
    });
    addRequirement(requirements, {
      id: "package-manager:maven",
      label: "Maven",
      command: "mvn",
      args: ["--version"],
      kind: "package_manager",
      required: true,
      source: "pom.xml",
    });
  }

  if (fileExists(resolved, "build.gradle") || fileExists(resolved, "build.gradle.kts")) {
    addRequirement(requirements, {
      id: "runtime:java",
      label: "Java",
      command: "java",
      args: ["-version"],
      kind: "runtime",
      required: true,
      source: "Gradle build file",
    });
    if (!fileExists(resolved, "gradlew")) {
      addRequirement(requirements, {
        id: "package-manager:gradle",
        label: "Gradle",
        command: "gradle",
        args: ["--version"],
        kind: "package_manager",
        required: true,
        source: "Gradle build file without wrapper",
      });
    }
  }

  if (fileExists(resolved, "Dockerfile") || fileExists(resolved, "docker-compose.yml") || fileExists(resolved, "docker-compose.yaml")) {
    addRequirement(requirements, {
      id: "system-tool:docker",
      label: "Docker",
      command: "docker",
      args: ["--version"],
      kind: "system_tool",
      required: false,
      source: "Docker project files",
    });
  }

  return Object.freeze({
    inspectedFiles: Object.freeze(inspectedFiles),
    requirements: Object.freeze(requirements),
    dependencyChecks: Object.freeze(dependencyChecks),
  });
}

export function buildEnvironmentFingerprint(
  workspacePath: string,
  inspectedFiles: readonly string[] = INSPECTION_FILES,
  markerPaths: readonly string[] = [],
): string {
  const hash = createHash("sha256");
  hash.update(path.resolve(workspacePath));
  for (const relativePath of [...inspectedFiles, ...markerPaths]) {
    const absolutePath = path.join(workspacePath, relativePath);
    hash.update(relativePath);
    if (!fs.existsSync(absolutePath)) {
      hash.update("missing");
      continue;
    }
    const stat = fs.statSync(absolutePath);
    hash.update(stat.isDirectory() ? "dir" : "file");
    hash.update(String(stat.size));
    hash.update(String(Math.floor(stat.mtimeMs)));
    const content = readText(absolutePath);
    if (content) hash.update(content.slice(0, 200_000));
  }
  return hash.digest("hex");
}

export function inspectDevEnvironment(requirements: readonly EnvironmentRequirement[]): readonly EnvironmentToolCheck[] {
  return Object.freeze(requirements.map((requirement) => {
    const result = spawnSync(requirement.command, [...requirement.args], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return Object.freeze({
        requirement,
        status: code === "ENOENT" ? "missing" : "error",
        error: result.error.message,
      });
    }
    if (typeof result.status === "number" && result.status !== 0 && !output) {
      return Object.freeze({
        requirement,
        status: "error",
        error: `Command exited with code ${result.status}.`,
      });
    }
    return Object.freeze({
      requirement,
      status: "available",
      ...(output ? { versionText: output.split(/\r?\n/).slice(0, 2).join(" ") } : {}),
    });
  }));
}

export function buildEnvironmentReadinessReport(workspacePath: string): EnvironmentReadinessReport {
  const stack = inspectProjectStack(workspacePath);
  const dependencyMarkers = stack.dependencyChecks.map((check) => check.dependencyRelativePath);
  const fingerprint = buildEnvironmentFingerprint(workspacePath, stack.inspectedFiles, dependencyMarkers);
  const checks = inspectDevEnvironment(stack.requirements);
  const missingRequired = checks.some((check) => check.requirement.required && check.status !== "available");
  const missingOptional = checks.some((check) => !check.requirement.required && check.status !== "available");
  const missingRequiredDependencies = stack.dependencyChecks.some((check) => check.required && !check.installed);
  const missingOptionalDependencies = stack.dependencyChecks.some((check) => !check.required && !check.installed);
  const status: EnvironmentReadinessStatus = stack.requirements.length === 0
    ? "unverified"
    : missingRequired || missingRequiredDependencies
      ? "missing_required"
      : missingOptional || missingOptionalDependencies
        ? "missing_optional"
        : "ready";
  return Object.freeze({
    workspacePath: path.resolve(workspacePath),
    fingerprint,
    status,
    machine: inspectLocalMachineProfile(),
    inspectedFiles: stack.inspectedFiles,
    requirements: stack.requirements,
    checks,
    dependencyChecks: stack.dependencyChecks,
    generatedAt: Date.now(),
  });
}

export function formatEnvironmentReadinessReport(report: EnvironmentReadinessReport): string {
  const lines = [
    "[ENVIRONMENT READINESS]",
    `Status: ${report.status}`,
    `Workspace: ${report.workspacePath}`,
    `Machine: ${report.machine.osType} ${report.machine.release} (${report.machine.platform}/${report.machine.arch})`,
    `Shell: ${report.machine.shell ?? "unknown"}`,
    `Path separator: ${report.machine.pathSeparator}`,
    `Inspected files: ${report.inspectedFiles.length ? report.inspectedFiles.join(", ") : "none"}`,
  ];
  if (report.checks.length === 0) {
    lines.push("No project-specific runtime requirements were detected from workspace files.");
  } else {
    lines.push("Tool checks:");
    for (const check of report.checks) {
      const required = check.requirement.required ? "required" : "optional";
      const version = check.versionText ? ` - ${check.versionText}` : check.error ? ` - ${check.error}` : "";
      const hint = check.requirement.versionHint ? ` (expected ${check.requirement.versionHint})` : "";
      lines.push(`- ${check.requirement.label}${hint}: ${check.status} [${required}, source: ${check.requirement.source}]${version}`);
    }
  }
  if (report.dependencyChecks.length > 0) {
    lines.push("Dependency readiness:");
    for (const check of report.dependencyChecks) {
      const required = check.required ? "required" : "optional";
      const packageManager = check.packageManager ? ` via ${check.packageManager}` : "";
      lines.push(`- ${check.relativePath}: ${check.installed ? "installed" : "missing"} [${required}${packageManager}, source: ${check.source}, marker: ${check.dependencyRelativePath}]`);
    }
  }
  if (report.status === "missing_required") {
    lines.push("Coding may continue only if the user chooses to install manually, lets Galaxy install, changes architecture, or explicitly continues without a verified environment.");
  }
  if (report.status !== "ready") {
    lines.push("Testing/review must not claim successful local validation unless the missing environment is resolved and commands actually run.");
  }
  return lines.join("\n");
}

function availableRequirementIds(report: EnvironmentReadinessReport): Set<string> {
  return new Set(
    report.checks
      .filter((check) => check.status === "available")
      .map((check) => check.requirement.id),
  );
}

function missingRequiredLabels(report: EnvironmentReadinessReport): readonly string[] {
  return Object.freeze(
    report.checks
      .filter((check) => check.requirement.required && check.status !== "available")
      .map((check) => check.requirement.label),
  );
}

export function buildEnvironmentSetupPlan(report: EnvironmentReadinessReport): EnvironmentSetupPlan {
  const available = availableRequirementIds(report);
  const commands: EnvironmentSetupCommand[] = [];
  const unsupported: string[] = missingRequiredLabels(report).map(
    (label) => `${label} is not installed or not available on PATH. Galaxy cannot safely install system runtimes/package managers without an explicit OS-specific setup workflow.`,
  );

  const inspected = new Set(report.inspectedFiles);
  const addCommand = (command: EnvironmentSetupCommand): void => {
    if (commands.some((item) => item.id === command.id)) return;
    commands.push(Object.freeze(command));
  };

  for (const dependencyCheck of report.dependencyChecks.filter((check) => check.required && !check.installed)) {
    const packageManager = dependencyCheck.packageManager ?? "npm";
    const command = packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "yarn"
        ? "yarn install"
        : packageManager === "bun"
          ? "bun install"
          : "npm install";
    const requirementId = `package-manager:${packageManager}`;
    if (!available.has(requirementId)) continue;
    addCommand({
      id: `${packageManager}-install-${dependencyCheck.relativePath.replace(/[^a-z0-9_-]+/gi, "-") || "root"}`,
      label: `Install dependencies in ${dependencyCheck.relativePath} with ${packageManager}`,
      command,
      cwd: dependencyCheck.projectPath,
      reason: `Dependencies are declared in ${dependencyCheck.manifest}, but ${dependencyCheck.dependencyRelativePath} is missing.`,
    });
  }

  if (available.has("package-manager:composer")) {
    addCommand({
      id: "composer-install",
      label: "Install PHP dependencies with Composer",
      command: "composer install",
      reason: "Composer dependencies can be installed from composer.json/composer.lock.",
    });
  }

  if (available.has("runtime:go")) {
    addCommand({
      id: "go-mod-download",
      label: "Download Go modules",
      command: "go mod download",
      reason: "Go module dependencies can be downloaded from go.mod/go.sum.",
    });
  }

  if (available.has("runtime:python") && inspected.has("requirements.txt")) {
    addCommand({
      id: "python-requirements-install",
      label: "Install Python requirements",
      command: "python3 -m pip install -r requirements.txt",
      reason: "Python dependencies can be installed from requirements.txt.",
    });
  }

  if (available.has("package-manager:maven")) {
    addCommand({
      id: "maven-dependency-resolve",
      label: "Resolve Maven dependencies",
      command: "mvn -q -DskipTests dependency:resolve",
      reason: "Maven dependencies can be resolved from pom.xml without running tests.",
    });
  }

  return Object.freeze({
    report,
    commands: Object.freeze(commands),
    unsupported: Object.freeze(unsupported),
  });
}

export function formatEnvironmentSetupPlan(plan: EnvironmentSetupPlan): string {
  const lines = [
    "[ENVIRONMENT SETUP PLAN]",
    `Workspace: ${plan.report.workspacePath}`,
  ];
  if (plan.commands.length > 0) {
    lines.push("Approval-gated commands:");
    for (const command of plan.commands) {
      lines.push(`- ${command.label}: ${command.command}${command.cwd ? ` (cwd: ${command.cwd})` : ""}`);
      lines.push(`  Reason: ${command.reason}`);
    }
  } else {
    lines.push("No safe workspace setup commands were inferred.");
  }
  if (plan.unsupported.length > 0) {
    lines.push("Unsupported automatic setup:");
    for (const item of plan.unsupported) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export function formatEnvironmentSetupRunSummary(summary: EnvironmentSetupRunSummary): string {
  const lines = [
    "[ENVIRONMENT SETUP RESULT]",
    ...summary.results.map((result) => {
      const status = result.success ? "passed" : "failed";
      return `- ${result.command.label}: ${status}${result.error ? ` - ${result.error}` : ""}`;
    }),
    "",
    formatEnvironmentReadinessReport(summary.reportAfter),
  ];
  return lines.join("\n");
}

export function buildEnvironmentSetupDecisionRequest(report: EnvironmentReadinessReport): EnvironmentSetupDecisionRequest {
  const options: readonly EnvironmentSetupDecisionOption[] = Object.freeze([
    {
      id: "ai_install",
      label: "Let Galaxy install/setup",
      description: "Galaxy may prepare the missing environment after normal tool approval.",
      decision: "ai_install",
    },
    {
      id: "manual_install",
      label: "I will install manually",
      description: "Stop before coding so you can install the missing tools.",
      decision: "manual_install",
    },
    {
      id: "code_without_verified_environment",
      label: "Continue without verified environment",
      description: "Allow coding, but validation cannot be reported as locally verified.",
      decision: "code_without_verified_environment",
    },
    {
      id: "change_architecture",
      label: "Change architecture/framework",
      description: "Stop coding and revise the technical direction.",
      decision: "change_architecture",
    },
    {
      id: "cancel",
      label: "Cancel",
      description: "Stop this request before file edits.",
      decision: "cancel",
    },
  ]);
  return Object.freeze({
    id: `environment-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Resolve development environment before coding",
    question: "Galaxy detected missing required development tools. How should it continue?",
    reason: "The workspace stack requires tools that are not available on this machine, so coding and validation behavior need an explicit user decision.",
    report,
    options,
  });
}

export function formatEnvironmentSetupDecisionRequest(request: EnvironmentSetupDecisionRequest): string {
  return [
    `[${request.title}]`,
    request.question,
    request.reason,
    "",
    formatEnvironmentReadinessReport(request.report),
    "",
    "Options:",
    ...request.options.map((option, index) => `${index + 1}. ${option.label} - ${option.description}`),
  ].join("\n");
}

export function resolveEnvironmentSetupDecisionFromText(
  request: EnvironmentSetupDecisionRequest,
  answerText: string,
): EnvironmentSetupDecision | null {
  const trimmed = answerText.trim();
  const selectedIndex = Number.parseInt(trimmed, 10);
  const selectedByNumber = Number.isFinite(selectedIndex)
    ? request.options[selectedIndex - 1]
    : undefined;
  const selectedByText = request.options.find((option) =>
    option.id.toLowerCase() === trimmed.toLowerCase() ||
    option.label.toLowerCase() === trimmed.toLowerCase() ||
    option.decision.toLowerCase() === trimmed.toLowerCase()
  );
  return (selectedByNumber ?? selectedByText)?.decision ?? null;
}

export function loadEnvironmentProfile(profilePath: string): EnvironmentProfile | null {
  const raw = readText(profilePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EnvironmentProfile;
  } catch {
    return null;
  }
}

export function isEnvironmentProfileFresh(
  profile: EnvironmentProfile | null,
  fingerprint: string,
  now = Date.now(),
): profile is EnvironmentProfile {
  return Boolean(profile && profile.fingerprint === fingerprint && profile.expiresAt > now);
}

export function saveEnvironmentProfile(
  profilePath: string,
  report: EnvironmentReadinessReport,
  decision?: EnvironmentSetupDecision,
): EnvironmentProfile {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const savedAt = Date.now();
  const profile: EnvironmentProfile = Object.freeze({
    workspacePath: report.workspacePath,
    fingerprint: report.fingerprint,
    report,
    ...(decision ? { decision } : {}),
    savedAt,
    expiresAt: savedAt + PROFILE_TTL_MS,
  });
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
  return profile;
}

export function shouldRunEnvironmentPreflightForPlan(plan: Readonly<{
  subtasks: readonly Readonly<{ role: string }>[];
}>): boolean {
  return plan.subtasks.some((subtask) =>
    subtask.role === "coding" || subtask.role === "testing" || subtask.role === "review"
  );
}
