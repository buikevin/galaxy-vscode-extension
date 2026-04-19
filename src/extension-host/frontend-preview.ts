/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-09
 * @modify date 2026-04-09
 * @desc Frontend preview runtime discovery, localhost session startup, and screenshot capture helpers.
 */

import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createDraftLocalAttachment } from "../attachments/attachment-store";
import type { FrontendPreviewReviewContext } from "../shared/attachments";
import type { LocalAttachmentPayload } from "../shared/protocol";
import {
  getLastLocalPreviewUrl,
  normalizeLocalPreviewInput,
  openLocalhostPreviewPanel,
} from "./vscode-tooling";

type PackageManager = "bun" | "yarn" | "pnpm" | "npm";
type ScriptName = "dev" | "preview" | "start";

type PackageManifest = Readonly<{
  name?: string;
  packageManager?: string;
  scripts?: Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
}>;

export type FrontendPreviewCandidate = Readonly<{
  label: string;
  relativePath: string;
  cwd: string;
  framework: string;
  packageManager: PackageManager;
  scriptName: ScriptName;
  commandText: string;
  previewUrl: string;
  packageJsonPath: string;
  score: number;
}>;

export type FrontendPreviewStartOptions = Readonly<{
  query?: string;
  interactive?: boolean;
}>;

type ActivePreviewSession = Readonly<{
  terminal: vscode.Terminal;
  candidate: FrontendPreviewCandidate;
  startedAt: number;
}>;

type ScreenshotViewportPreset = Readonly<{
  id: "desktop" | "tablet" | "mobile";
  label: string;
  width: number;
  height: number;
}>;

type PreviewScreenshotArtifact = Readonly<{
  fileName: string;
  screenshotBuffer: Buffer;
  frontendPreviewContext: FrontendPreviewReviewContext;
}>;

type WaitForPreviewOptions = Readonly<{
  timeoutMs?: number;
  intervalMs?: number;
  token?: vscode.CancellationToken;
  onProgress?: (elapsedMs: number) => void;
}>;

const FRONTEND_PREVIEW_TERMINAL_NAME = "Galaxy Frontend Preview";
const DEFAULT_PREVIEW_TIMEOUT_MS = 90_000;
const DEFAULT_PREVIEW_POLL_INTERVAL_MS = 1_250;
const DEFAULT_CAPTURE_TIMEOUT_MS = 45_000;
const FRONTEND_SCREENSHOT_VIEWPORTS: readonly ScreenshotViewportPreset[] =
  Object.freeze([
    Object.freeze({
      id: "desktop",
      label: "Desktop",
      width: 1440,
      height: 960,
    }),
    Object.freeze({
      id: "tablet",
      label: "Tablet",
      width: 1024,
      height: 1366,
    }),
    Object.freeze({
      id: "mobile",
      label: "Mobile",
      width: 390,
      height: 844,
    }),
  ]);
const FRONTEND_DISCOVERY_MAX_DEPTH = 4;
const FRONTEND_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".galaxy",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

let activePreviewSession: ActivePreviewSession | null = null;

function pushUniqueIssue(target: string[], value: string, limit = 6): void {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || target.includes(normalized) || target.length >= limit) {
    return;
  }
  target.push(normalized.slice(0, 320));
}

function normalizeRelativeLabel(workspacePath: string, targetPath: string): string {
  const relative = path.relative(workspacePath, targetPath) || ".";
  return relative.split(path.sep).join("/");
}

function readPackageManifest(packageJsonPath: string): PackageManifest | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as PackageManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function detectPackageManager(
  cwd: string,
  manifest: PackageManifest,
): PackageManager {
  const packageManagerField = String(manifest.packageManager ?? "").trim();
  if (packageManagerField.startsWith("bun@") || fs.existsSync(path.join(cwd, "bun.lock"))) {
    return "bun";
  }
  if (packageManagerField.startsWith("pnpm@") || fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (packageManagerField.startsWith("yarn@") || fs.existsSync(path.join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
    return "npm";
  }
  if (packageManagerField.startsWith("npm@")) {
    return "npm";
  }
  return "yarn";
}

function buildScriptCommand(
  packageManager: PackageManager,
  scriptName: ScriptName,
): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm ${scriptName}`;
    case "npm":
      return `npm run ${scriptName}`;
    case "yarn":
    default:
      return `yarn ${scriptName}`;
  }
}

function collectDependencyNames(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

function inferFramework(
  manifest: PackageManifest,
  scriptText: string,
): string {
  const deps = collectDependencyNames(manifest);
  const normalizedScript = scriptText.toLowerCase();

  if (deps.has("next") || /\bnext\b/.test(normalizedScript)) {
    return "Next.js";
  }
  if (deps.has("nuxt") || /\bnuxt\b/.test(normalizedScript)) {
    return "Nuxt";
  }
  if (deps.has("astro") || /\bastro\b/.test(normalizedScript)) {
    return "Astro";
  }
  if (
    deps.has("@angular/core") ||
    deps.has("@angular/cli") ||
    /\bng serve\b/.test(normalizedScript)
  ) {
    return "Angular";
  }
  if (
    deps.has("@docusaurus/core") ||
    deps.has("docusaurus") ||
    /\bdocusaurus\b/.test(normalizedScript)
  ) {
    return "Docusaurus";
  }
  if (
    deps.has("react-scripts") ||
    /\breact-scripts\b/.test(normalizedScript)
  ) {
    return "Create React App";
  }
  if (deps.has("vite") || /\bvite\b/.test(normalizedScript)) {
    if (deps.has("react")) {
      return "Vite React";
    }
    if (deps.has("vue")) {
      return "Vite Vue";
    }
    if (deps.has("svelte") || deps.has("@sveltejs/kit")) {
      return "Vite Svelte";
    }
    return "Vite";
  }
  if (deps.has("react")) {
    return "React";
  }
  if (deps.has("vue")) {
    return "Vue";
  }
  if (deps.has("svelte") || deps.has("@sveltejs/kit")) {
    return "Svelte";
  }
  return "Frontend";
}

function looksLikeFrontendDirectory(cwd: string): boolean {
  const candidates = [
    "index.html",
    path.join("app", "page.tsx"),
    path.join("app", "page.jsx"),
    path.join("src", "main.ts"),
    path.join("src", "main.tsx"),
    path.join("src", "main.js"),
    path.join("src", "main.jsx"),
    path.join("src", "App.tsx"),
    path.join("src", "App.jsx"),
    path.join("src", "App.vue"),
    path.join("src", "app.html"),
  ];
  return candidates.some((candidate) => fs.existsSync(path.join(cwd, candidate)));
}

function scriptLooksFrontend(scriptText: string): boolean {
  return /vite|next|nuxt|astro|react-scripts|webpack serve|ng serve|docusaurus|storybook|serve\s|-w\s+dev/i.test(
    scriptText,
  );
}

export function extractPreviewPort(scriptText: string): number | null {
  const patterns = [
    /(?:--port|--listen|-p)\s*[= ]\s*(\d{2,5})/i,
    /PORT\s*=\s*(\d{2,5})/i,
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = scriptText.match(pattern);
    const port = Number.parseInt(match?.[1] ?? "", 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  }
  return null;
}

function inferPreviewPort(
  scriptText: string,
  framework: string,
  scriptName: ScriptName,
): number {
  const explicitPort = extractPreviewPort(scriptText);
  if (explicitPort) {
    return explicitPort;
  }
  if (framework === "Next.js" || framework === "Nuxt") {
    return 3000;
  }
  if (framework === "Astro") {
    return 4321;
  }
  if (framework === "Angular") {
    return 4200;
  }
  if (framework === "Create React App" || framework === "Docusaurus") {
    return 3000;
  }
  if (framework.startsWith("Vite")) {
    return scriptName === "preview" ? 4173 : 5173;
  }
  return scriptName === "preview" ? 4173 : 3000;
}

function scorePreviewCandidate(
  manifest: PackageManifest,
  framework: string,
  scriptName: ScriptName,
  cwd: string,
  scriptText: string,
): number {
  const deps = collectDependencyNames(manifest);
  let score = 0;
  score += scriptName === "dev" ? 80 : scriptName === "preview" ? 72 : 60;
  score += looksLikeFrontendDirectory(cwd) ? 30 : 0;
  score += scriptLooksFrontend(scriptText) ? 30 : 0;
  score += framework !== "Frontend" ? 25 : 0;
  score += deps.has("vite") ? 12 : 0;
  score += deps.has("react") || deps.has("vue") || deps.has("next") ? 10 : 0;
  if (/extension/i.test(cwd) || /vscode/i.test(cwd)) {
    score -= 10;
  }
  return score;
}

function discoverPackageJsonFiles(
  rootPath: string,
  depth = 0,
): string[] {
  if (depth > FRONTEND_DISCOVERY_MAX_DEPTH || !fs.existsSync(rootPath)) {
    return [];
  }

  const packageJsonPath = path.join(rootPath, "package.json");
  const results = fs.existsSync(packageJsonPath) ? [packageJsonPath] : [];

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (FRONTEND_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    results.push(
      ...discoverPackageJsonFiles(path.join(rootPath, entry.name), depth + 1),
    );
  }

  return results;
}

export function discoverFrontendPreviewCandidates(
  workspacePath: string,
): FrontendPreviewCandidate[] {
  const packageJsonPaths = discoverPackageJsonFiles(workspacePath);
  const candidates: FrontendPreviewCandidate[] = [];

  for (const packageJsonPath of packageJsonPaths) {
    const manifest = readPackageManifest(packageJsonPath);
    if (!manifest) {
      continue;
    }

    const scripts = manifest.scripts ?? {};
    const scriptName = (["dev", "preview", "start"] as const).find(
      (candidate) => typeof scripts[candidate] === "string" && scripts[candidate].trim().length > 0,
    );
    if (!scriptName) {
      continue;
    }

    const cwd = path.dirname(packageJsonPath);
    const scriptText = scripts[scriptName]!.trim();
    const framework = inferFramework(manifest, scriptText);
    if (
      framework === "Frontend" &&
      !looksLikeFrontendDirectory(cwd) &&
      !scriptLooksFrontend(scriptText)
    ) {
      continue;
    }

    const packageManager = detectPackageManager(cwd, manifest);
    const previewPort = inferPreviewPort(scriptText, framework, scriptName);
    const previewUrl = `http://127.0.0.1:${previewPort}`;
    const relativePath = normalizeRelativeLabel(workspacePath, cwd);
    const baseLabel = String(manifest.name ?? "").trim() || path.basename(cwd);
    const score = scorePreviewCandidate(
      manifest,
      framework,
      scriptName,
      cwd,
      scriptText,
    );

    candidates.push(
      Object.freeze({
        label: baseLabel,
        relativePath,
        cwd,
        framework,
        packageManager,
        scriptName,
        commandText: buildScriptCommand(packageManager, scriptName),
        previewUrl,
        packageJsonPath,
        score,
      }),
    );
  }

  return candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function clearExitedPreviewSession(): void {
  if (activePreviewSession?.terminal.exitStatus !== undefined) {
    activePreviewSession = null;
  }
}

async function pickPreviewCandidate(
  candidates: readonly FrontendPreviewCandidate[],
  options: FrontendPreviewStartOptions = {},
): Promise<FrontendPreviewCandidate | null> {
  if (candidates.length === 0) {
    return null;
  }

  const query = String(options.query ?? "").trim().toLowerCase();
  if (query) {
    const ranked = candidates
      .map((candidate) => {
        const fields = [
          candidate.label,
          candidate.relativePath,
          candidate.framework,
          candidate.packageManager,
          candidate.commandText,
        ].map((value) => value.toLowerCase());
        let matchScore = 0;

        for (const field of fields) {
          if (field === query) {
            matchScore = Math.max(matchScore, 500);
            continue;
          }
          if (field.startsWith(query)) {
            matchScore = Math.max(matchScore, 360);
            continue;
          }
          if (field.includes(query)) {
            matchScore = Math.max(matchScore, 240);
          }
        }

        const terms = query.split(/\s+/).filter(Boolean);
        if (
          terms.length > 1 &&
          terms.every((term) => fields.some((field) => field.includes(term)))
        ) {
          matchScore = Math.max(matchScore, 180 + terms.length * 10);
        }

        return Object.freeze({
          candidate,
          matchScore,
        });
      })
      .filter((entry) => entry.matchScore > 0)
      .sort((left, right) => {
        if (right.matchScore !== left.matchScore) {
          return right.matchScore - left.matchScore;
        }
        if (right.candidate.score !== left.candidate.score) {
          return right.candidate.score - left.candidate.score;
        }
        return left.candidate.relativePath.localeCompare(
          right.candidate.relativePath,
        );
      });

    if (ranked.length === 0) {
      throw new Error(
        `No frontend preview candidate matched "${options.query}". Available apps: ${candidates
          .slice(0, 5)
          .map((candidate) => `${candidate.label} (${candidate.relativePath})`)
          .join(", ")}`,
      );
    }

    const best = ranked[0]!;
    const second = ranked[1];
    if (
      second &&
      best.matchScore === second.matchScore &&
      best.candidate.score === second.candidate.score
    ) {
      throw new Error(
        `Preview query "${options.query}" is ambiguous. Matches: ${ranked
          .slice(0, 3)
          .map((entry) => `${entry.candidate.label} (${entry.candidate.relativePath})`)
          .join(", ")}`,
      );
    }

    return best.candidate;
  }

  if (candidates.length === 1 || options.interactive === false) {
    return candidates[0]!;
  }

  const selected = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.label,
      detail:
        `${candidate.framework} • ${candidate.relativePath} • ${candidate.commandText}`,
      description: candidate.previewUrl,
      candidate,
    })),
    {
      title: "Galaxy Frontend Preview",
      placeHolder: "Select a frontend app to start and preview",
      ignoreFocusOut: true,
    },
  );

  return selected?.candidate ?? null;
}

async function probePreviewUrl(
  previewUrl: string,
  requestTimeoutMs = 2_500,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(previewUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPreviewReady(
  previewUrl: string,
  options: WaitForPreviewOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_PREVIEW_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    if (options.token?.isCancellationRequested) {
      throw new Error("Preview startup was cancelled.");
    }
    if (await probePreviewUrl(previewUrl)) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ${previewUrl} to respond. The dev server terminal is still open so you can inspect or rerun it manually.`,
      );
    }
    options.onProgress?.(elapsedMs);
    await delay(intervalMs);
  }
}

function resolvePathFromEnvCandidate(rawPath: string | undefined): string | null {
  if (!rawPath) {
    return null;
  }
  const expanded = rawPath.startsWith("~")
    ? path.join(process.env.HOME ?? "", rawPath.slice(1))
    : rawPath;
  return fs.existsSync(expanded) ? expanded : null;
}

function resolveBinaryOnPath(commandNames: readonly string[]): string | null {
  const pathEntries = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? String(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const entry of pathEntries) {
    for (const commandName of commandNames) {
      for (const extension of extensions) {
        const candidate = path.join(
          entry,
          process.platform === "win32" && !commandName.toLowerCase().endsWith(extension.toLowerCase())
            ? `${commandName}${extension}`
            : commandName,
        );
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

export function resolvePlaywrightBrowserExecutablePath(): string | null {
  const explicitPath = resolvePathFromEnvCandidate(
    process.env.GALAXY_PLAYWRIGHT_EXECUTABLE_PATH,
  );
  if (explicitPath) {
    return explicitPath;
  }

  if (process.platform === "darwin") {
    return (
      resolvePathFromEnvCandidate(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ) ??
      resolvePathFromEnvCandidate(
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ) ??
      resolvePathFromEnvCandidate(
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      )
    );
  }

  if (process.platform === "win32") {
    const windowsCandidates = [
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env.PROGRAMFILES ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env.PROGRAMFILES ?? "",
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "",
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
    ];
    for (const candidate of windowsCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return resolveBinaryOnPath(["chrome", "msedge", "chromium"]);
  }

  return resolveBinaryOnPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "microsoft-edge",
    "msedge",
  ]);
}

async function capturePreviewScreenshotArtifacts(
  previewUrl: string,
): Promise<readonly PreviewScreenshotArtifact[]> {
  const executablePath = resolvePlaywrightBrowserExecutablePath();
  if (!executablePath) {
    throw new Error(
      "No Chromium-based browser executable was found. Set GALAXY_PLAYWRIGHT_EXECUTABLE_PATH or install Chrome/Edge.",
    );
  }

  const playwright = await import("playwright-core");
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-first-run"],
  });

  try {
    const artifacts: PreviewScreenshotArtifact[] = [];

    for (const viewport of FRONTEND_SCREENSHOT_VIEWPORTS) {
      const page = await browser.newPage({
        viewport: {
          width: viewport.width,
          height: viewport.height,
        },
      });
      const consoleMessages: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: string[] = [];

      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          pushUniqueIssue(
            consoleMessages,
            `[${message.type()}] ${message.text()}`,
          );
        }
      });
      page.on("pageerror", (error) => {
        pushUniqueIssue(pageErrors, error.message || String(error));
      });
      page.on("requestfailed", (request) => {
        pushUniqueIssue(
          failedRequests,
          `${request.method()} ${request.url()} - ${request.failure()?.errorText ?? "request failed"}`,
        );
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          pushUniqueIssue(
            failedRequests,
            `${response.request().method()} ${response.url()} - HTTP ${response.status()}`,
          );
        }
      });

      try {
        try {
          await page.goto(previewUrl, {
            waitUntil: "networkidle",
            timeout: DEFAULT_CAPTURE_TIMEOUT_MS,
          });
        } catch {
          await page.goto(previewUrl, {
            waitUntil: "domcontentloaded",
            timeout: DEFAULT_CAPTURE_TIMEOUT_MS,
          });
          await page
            .waitForLoadState("networkidle", {
              timeout: 5_000,
            })
            .catch(() => undefined);
        }

        const screenshotBuffer = await page.screenshot({
          animations: "disabled",
          fullPage: true,
          type: "png",
        });
        const pageTitle = await page.title().catch(() => "");

        artifacts.push(
          Object.freeze({
            fileName: buildPreviewScreenshotFileName(previewUrl, viewport.id),
            screenshotBuffer,
            frontendPreviewContext: Object.freeze({
              previewUrl,
              finalUrl: page.url(),
              ...(pageTitle.trim() ? { pageTitle: pageTitle.trim() } : {}),
              viewportId: viewport.id,
              viewportLabel: viewport.label,
              width: viewport.width,
              height: viewport.height,
              ...(consoleMessages.length > 0
                ? { consoleMessages: Object.freeze([...consoleMessages]) }
                : {}),
              ...(pageErrors.length > 0
                ? { pageErrors: Object.freeze([...pageErrors]) }
                : {}),
              ...(failedRequests.length > 0
                ? { failedRequests: Object.freeze([...failedRequests]) }
                : {}),
            }),
          }),
        );
      } finally {
        await page.close();
      }
    }

    return Object.freeze(artifacts);
  } finally {
    await browser.close();
  }
}

export function buildPreviewScreenshotFileName(
  previewUrl: string,
  viewportId?: "desktop" | "tablet" | "mobile",
): string {
  const parsed = new URL(previewUrl);
  const host = parsed.host.replace(/[^a-zA-Z0-9.-]+/g, "-");
  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  return viewportId
    ? `frontend-preview-${host}-${viewportId}-${dateStamp}.png`
    : `frontend-preview-${host}-${dateStamp}.png`;
}

export async function startFrontendPreviewSession(
  workspacePath: string,
  options: FrontendPreviewStartOptions = {},
): Promise<FrontendPreviewCandidate | null> {
  clearExitedPreviewSession();
  const candidates = discoverFrontendPreviewCandidates(workspacePath);
  if (candidates.length === 0) {
    throw new Error(
      "No frontend preview candidates were found. Add a package.json with a dev, preview, or start script, or use Open Local Frontend Preview with a manual URL.",
    );
  }

  const candidate = await pickPreviewCandidate(candidates, options);
  if (!candidate) {
    return null;
  }

  if (await probePreviewUrl(candidate.previewUrl, 1_500)) {
    await openLocalhostPreviewPanel(candidate.previewUrl);
    return candidate;
  }

  const runningPreviewSession =
    activePreviewSession?.terminal.exitStatus === undefined
      ? activePreviewSession
      : null;
  if (runningPreviewSession) {
    if (options.interactive === false) {
      if (runningPreviewSession.candidate.cwd === candidate.cwd) {
        await openLocalhostPreviewPanel(runningPreviewSession.candidate.previewUrl);
        return runningPreviewSession.candidate;
      }
      runningPreviewSession.terminal.dispose();
      activePreviewSession = null;
    } else {
    const decision = await vscode.window.showWarningMessage(
      `A frontend preview session is already running for ${runningPreviewSession.candidate.label}.`,
      { modal: true },
      "Reuse Current",
      "Restart Preview",
    );
    if (!decision) {
      return null;
    }
    if (decision === "Reuse Current") {
      await openLocalhostPreviewPanel(runningPreviewSession.candidate.previewUrl);
      return runningPreviewSession.candidate;
    }
    runningPreviewSession.terminal.dispose();
    activePreviewSession = null;
    }
  }

  const terminal = vscode.window.createTerminal({
    name: `${FRONTEND_PREVIEW_TERMINAL_NAME}: ${candidate.label}`,
    cwd: candidate.cwd,
  });
  terminal.show(true);
  terminal.sendText(candidate.commandText, true);
  activePreviewSession = Object.freeze({
    terminal,
    candidate,
    startedAt: Date.now(),
  });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting ${candidate.label}`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({
        message: `${candidate.commandText} -> ${candidate.previewUrl}`,
      });
      await waitForPreviewReady(candidate.previewUrl, {
        token,
        onProgress: (elapsedMs) => {
          progress.report({
            message: `Waiting for ${candidate.previewUrl} (${Math.max(1, Math.round(elapsedMs / 1000))}s)`,
          });
        },
      });
    },
  );

  await openLocalhostPreviewPanel(candidate.previewUrl);
  return candidate;
}

export async function captureLocalPreviewScreenshot(
  workspacePath: string,
): Promise<readonly LocalAttachmentPayload[]> {
  const initialPreviewUrl = getLastLocalPreviewUrl();
  const rawPreviewUrl = initialPreviewUrl?.trim()
    ? initialPreviewUrl
    : await vscode.window.showInputBox({
        title: "Galaxy Frontend Screenshot",
        prompt: "Enter a localhost URL or port to capture",
        placeHolder: "http://127.0.0.1:3000 or 3000",
        value: "http://127.0.0.1:3000",
        ignoreFocusOut: true,
      });

  if (!rawPreviewUrl) {
    return Object.freeze([]);
  }

  const previewUrl = normalizeLocalPreviewInput(rawPreviewUrl);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Capturing frontend preview screenshot",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: `Waiting for ${previewUrl}` });
      await waitForPreviewReady(previewUrl, {
        timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
        token,
        onProgress: (elapsedMs) => {
          progress.report({
            message: `Preview is starting (${Math.max(1, Math.round(elapsedMs / 1000))}s)`,
          });
        },
      });
    },
  );

  const screenshotArtifacts = await capturePreviewScreenshotArtifacts(previewUrl);
  return Object.freeze(
    await Promise.all(
      screenshotArtifacts.map((artifact) =>
        createDraftLocalAttachment({
          workspacePath,
          name: artifact.fileName,
          mimeType: "image/png",
          dataUrl: `data:image/png;base64,${artifact.screenshotBuffer.toString("base64")}`,
          frontendPreviewContext: artifact.frontendPreviewContext,
        }),
      ),
    ),
  );
}