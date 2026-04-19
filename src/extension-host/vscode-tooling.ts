/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc VS Code native file, diff, diagnostics, search, and tool invocation helpers.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getOriginalContent } from "../runtime/session-tracker";
import type { ToolResult } from "../tools/entities/file-tools";

type RelativePathFormatter = (filePath: string) => string;
type LogWriter = (
  level: "info" | "error" | "status" | "approval" | "review" | "validation",
  message: string,
) => void;
type ErrorPoster = (message: string) => Promise<void>;

const LOCALHOST_PREVIEW_PANEL_TYPE = "galaxy-code.localhostPreview";
let localhostPreviewPanel: vscode.WebviewPanel | null = null;
let lastLocalPreviewUrl: string | null = null;

export function getLastLocalPreviewUrl(): string | null {
  return lastLocalPreviewUrl;
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Normalize user input into a localhost preview URL. */
export function normalizeLocalPreviewInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("A localhost URL or port is required.");
  }

  if (/^\d{2,5}$/.test(trimmed)) {
    return `http://127.0.0.1:${trimmed}`;
  }

  if (looksLikeHttpUrl(trimmed)) {
    const parsed = new URL(trimmed);
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
      throw new Error("Only localhost preview URLs are supported right now.");
    }
    if (parsed.hostname === "0.0.0.0") {
      parsed.hostname = "127.0.0.1";
    }
    return parsed.toString();
  }

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(\/.*)?$/i.test(trimmed)) {
    return normalizeLocalPreviewInput(`http://${trimmed}`);
  }

  throw new Error(
    "Enter a localhost URL such as http://127.0.0.1:3000 or just a port like 3000.",
  );
}

function buildLocalPreviewHtml(
  webview: vscode.Webview,
  previewUrl: vscode.Uri,
  displayUrl: string,
): string {
  const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const frameSrc = previewUrl.toString();
  const escapedDisplayUrl = displayUrl
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; frame-src ${frameSrc};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Preview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1220;
        --panel: rgba(15, 23, 42, 0.92);
        --border: rgba(148, 163, 184, 0.22);
        --text: #e5eefc;
        --muted: #94a3b8;
        --accent: #38bdf8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(56, 189, 248, 0.12), transparent 40%),
          linear-gradient(180deg, #020617 0%, #0f172a 100%);
        color: var(--text);
        height: 100vh;
        overflow: hidden;
      }
      .shell {
        display: grid;
        grid-template-rows: auto 1fr;
        height: 100vh;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        background: var(--panel);
        backdrop-filter: blur(10px);
      }
      .badge {
        flex: 1;
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(2, 6, 23, 0.45);
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      button, a {
        appearance: none;
        border: 1px solid var(--border);
        background: rgba(15, 23, 42, 0.9);
        color: var(--text);
        text-decoration: none;
        border-radius: 10px;
        padding: 9px 12px;
        font: inherit;
        cursor: pointer;
      }
      button:hover, a:hover {
        border-color: rgba(56, 189, 248, 0.6);
        color: white;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: white;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="toolbar">
        <div class="badge">${escapedDisplayUrl}</div>
        <div class="actions">
          <button id="reload" type="button">Reload</button>
          <a href="${frameSrc}" target="_blank" rel="noreferrer">Open External</a>
        </div>
      </div>
      <iframe id="preview-frame" src="${frameSrc}" title="Galaxy localhost preview"></iframe>
    </div>
    <script nonce="${nonce}">
      const frame = document.getElementById("preview-frame");
      const reload = document.getElementById("reload");
      reload?.addEventListener("click", () => {
        const current = frame.getAttribute("src");
        frame.setAttribute("src", current || ${JSON.stringify(frameSrc)});
      });
    </script>
  </body>
</html>`;
}

/** Open a localhost frontend preview in a browser-like VS Code webview panel. */
export async function openLocalhostPreviewPanel(
  initialInput?: string,
): Promise<string | null> {
  const rawValue = initialInput?.trim()
    ? initialInput
    : await vscode.window.showInputBox({
        title: "Galaxy Frontend Preview",
        prompt: "Enter a localhost URL or port",
        placeHolder: "http://127.0.0.1:3000 or 3000",
        value: "http://127.0.0.1:3000",
        ignoreFocusOut: true,
      });

  if (!rawValue) {
    return null;
  }

  const normalizedUrl = normalizeLocalPreviewInput(rawValue);
  const externalUri = await vscode.env.asExternalUri(
    vscode.Uri.parse(normalizedUrl),
  );
  lastLocalPreviewUrl = normalizedUrl;

  const targetColumn =
    vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
  const panel = localhostPreviewPanel;
  const resolvedPanel =
    panel ??
    vscode.window.createWebviewPanel(
      LOCALHOST_PREVIEW_PANEL_TYPE,
      `Frontend Preview: ${new URL(normalizedUrl).host}`,
      targetColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

  if (!panel) {
    localhostPreviewPanel = resolvedPanel;
    resolvedPanel.onDidDispose(() => {
      if (localhostPreviewPanel === resolvedPanel) {
        localhostPreviewPanel = null;
      }
    });
  } else {
    resolvedPanel.reveal(targetColumn, true);
  }

  resolvedPanel.title = `Frontend Preview: ${new URL(normalizedUrl).host}`;
  resolvedPanel.webview.html = buildLocalPreviewHtml(
    resolvedPanel.webview,
    externalUri,
    normalizedUrl,
  );
  return normalizedUrl;
}

/** Create a temporary text file used as the left side of a native diff. */
export async function createTempFile(
  name: string,
  content: string,
): Promise<vscode.Uri> {
  const diffDir = vscode.Uri.file(
    path.join(os.tmpdir(), "galaxy-code-vscode-diffs"),
  );
  await vscode.workspace.fs.createDirectory(diffDir);
  const target = vscode.Uri.file(
    path.join(
      diffDir.fsPath,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`,
    ),
  );
  await vscode.workspace.fs.writeFile(
    target,
    new TextEncoder().encode(content),
  );
  return target;
}

/** Resolve a possibly relative file path against the workspace root. */
export function resolveWorkspaceFilePath(
  workspacePath: string,
  filePath: string,
): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspacePath, filePath);
}

/** Open one workspace file in a standard editor tab. */
export async function openWorkspaceFile(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  const targetPath = resolveWorkspaceFilePath(workspacePath, filePath);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(targetPath),
  );
  await vscode.window.showTextDocument(document, { preview: false });
}

const DRAWIO_EDITOR_CANDIDATES = Object.freeze([
  Object.freeze({
    extensionId: "hediet.vscode-drawio",
    providerId: "hediet.vscode-drawio-text",
  }),
  Object.freeze({
    extensionId: "eighthundreds.vscode-drawio",
    providerId: "vscode-drawio.editor",
  }),
]);

function getInstalledDrawioEditorProviderId(): string | null {
  const installedIds = new Set(
    vscode.extensions.all.map((extension) => extension.id.toLowerCase()),
  );
  const matched = DRAWIO_EDITOR_CANDIDATES.find((candidate) =>
    installedIds.has(candidate.extensionId),
  );
  return matched?.providerId ?? null;
}

/** Open one Draw.io diagram in a supported custom editor when available, otherwise fall back to text. */
export async function openDrawioDiagramTool(
  params: Readonly<{
    workspacePath: string;
    filePath: string;
    asWorkspaceRelative: RelativePathFormatter;
    appendLog: LogWriter;
  }>,
): Promise<ToolResult> {
  const targetPath = resolveWorkspaceFilePath(
    params.workspacePath,
    params.filePath,
  );
  const targetUri = vscode.Uri.file(targetPath);
  const providerId = getInstalledDrawioEditorProviderId();

  try {
    if (providerId) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        targetUri,
        providerId,
      );
      params.appendLog(
        "info",
        `Opened Draw.io diagram ${params.asWorkspaceRelative(targetPath)} with ${providerId}.`,
      );
      return Object.freeze({
        success: true,
        content: `Opened Draw.io diagram ${params.asWorkspaceRelative(targetPath)} with the installed Draw.io editor.`,
        meta: Object.freeze({
          filePath: targetPath,
          operation: "open_drawio_diagram",
          providerId,
        }),
      });
    }
  } catch (error) {
    params.appendLog(
      "info",
      `Falling back to text editor for ${params.asWorkspaceRelative(targetPath)} because Draw.io custom editor failed: ${String(error)}`,
    );
  }

  const document = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(document, { preview: false });
  const note = providerId
    ? "Opened as XML text after the Draw.io custom editor failed."
    : "Opened as XML text because no supported Draw.io VS Code extension is installed.";
  params.appendLog(
    "info",
    `${note} (${params.asWorkspaceRelative(targetPath)})`,
  );
  return Object.freeze({
    success: true,
    content: `Opened Draw.io diagram ${params.asWorkspaceRelative(targetPath)}. ${note}`,
    meta: Object.freeze({
      filePath: targetPath,
      operation: "open_drawio_diagram",
      providerId: providerId ?? "",
      fallbackToText: true,
    }),
  });
}

/** Reveal a file, optionally centering and selecting a requested line range. */
export async function revealFile(
  filePath: string,
  range?: Readonly<{ startLine: number; endLine: number }>,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(filePath),
  );
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: true,
  });
  if (!range) {
    return;
  }

  const maxStartLine = Math.max(
    0,
    Math.min(range.startLine - 1, document.lineCount - 1),
  );
  const maxEndLine = Math.max(
    maxStartLine,
    Math.min(range.endLine - 1, document.lineCount - 1),
  );
  const selection = new vscode.Range(
    new vscode.Position(maxStartLine, 0),
    new vscode.Position(
      maxEndLine,
      document.lineAt(maxEndLine).range.end.character,
    ),
  );
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(selection.start, selection.end);
}

/** Open a native VS Code diff editor. */
export async function openDiff(
  originalUri: vscode.Uri,
  modifiedPath: string,
  title: string,
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    originalUri,
    vscode.Uri.file(modifiedPath),
    title,
  );
}

/** Open the tracked session diff for one file. */
export async function openTrackedDiff(
  params: Readonly<{
    filePath: string;
    asWorkspaceRelative: RelativePathFormatter;
    appendLog: LogWriter;
    postErrorMessage: ErrorPoster;
  }>,
): Promise<void> {
  const originalContent = getOriginalContent(params.filePath);
  if (typeof originalContent === "undefined") {
    const message = `No tracked diff snapshot exists yet for ${params.asWorkspaceRelative(params.filePath)}.`;
    params.appendLog("info", message);
    await params.postErrorMessage(message);
    return;
  }

  const originalUri = await createTempFile(
    `${path.basename(params.filePath)}.original`,
    originalContent ?? "",
  );
  params.appendLog(
    "info",
    `Opened tracked diff for ${params.asWorkspaceRelative(params.filePath)}.`,
  );
  await openDiff(
    originalUri,
    params.filePath,
    `Session Diff: ${params.asWorkspaceRelative(params.filePath)}`,
  );
}

/** Tool wrapper that opens the tracked diff and returns a structured result. */
export async function openTrackedDiffTool(
  params: Readonly<{
    workspacePath: string;
    filePath: string;
    asWorkspaceRelative: RelativePathFormatter;
    openTrackedDiff: (filePath: string) => Promise<void>;
  }>,
): Promise<ToolResult> {
  try {
    const targetPath = resolveWorkspaceFilePath(
      params.workspacePath,
      params.filePath,
    );
    if (typeof getOriginalContent(targetPath) === "undefined") {
      return Object.freeze({
        success: false,
        content: "",
        error: `No tracked diff snapshot exists yet for ${params.asWorkspaceRelative(targetPath)}.`,
      });
    }
    await params.openTrackedDiff(targetPath);
    return Object.freeze({
      success: true,
      content: `Opened native diff for ${params.asWorkspaceRelative(targetPath)}.`,
      meta: Object.freeze({
        filePath: targetPath,
        operation: "open_diff",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/** Show the Problems panel and summarize current diagnostics. */
export async function showProblemsTool(
  params: Readonly<{
    workspacePath: string;
    filePath?: string;
    asWorkspaceRelative: RelativePathFormatter;
  }>,
): Promise<ToolResult> {
  try {
    const targetPath = params.filePath
      ? resolveWorkspaceFilePath(params.workspacePath, params.filePath)
      : "";
    const targetUri = targetPath ? vscode.Uri.file(targetPath) : undefined;
    const diagnostics = targetUri
      ? vscode.languages.getDiagnostics(targetUri)
      : vscode.languages.getDiagnostics().flatMap((entry) => entry[1]);
    await vscode.commands.executeCommand("workbench.actions.view.problems");
    const summaryLines = diagnostics.slice(0, 20).map((diagnostic) => {
      const severity =
        diagnostic.severity === vscode.DiagnosticSeverity.Error
          ? "error"
          : diagnostic.severity === vscode.DiagnosticSeverity.Warning
            ? "warning"
            : diagnostic.severity === vscode.DiagnosticSeverity.Information
              ? "info"
              : "hint";
      return `- [${severity}] line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
    });
    return Object.freeze({
      success: true,
      content:
        summaryLines.length > 0
          ? summaryLines.join("\n")
          : targetPath
            ? `No diagnostics for ${params.asWorkspaceRelative(targetPath)}.`
            : "No diagnostics in Problems view.",
      meta: Object.freeze({
        ...(targetPath ? { filePath: targetPath } : {}),
        issuesCount: diagnostics.length,
        operation: "show_problems",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/** Search the workspace and summarize a bounded set of text matches. */
export async function workspaceSearchTool(
  params: Readonly<{
    workspacePath: string;
    query: string;
    asWorkspaceRelative: RelativePathFormatter;
    options?: Readonly<{
      includes?: string;
      maxResults?: number;
      isRegex?: boolean;
      isCaseSensitive?: boolean;
      matchWholeWord?: boolean;
    }>;
  }>,
): Promise<ToolResult> {
  try {
    const maxResults = Math.max(
      1,
      Math.min(params.options?.maxResults ?? 20, 100),
    );
    const matches: Array<{ filePath: string; line: number; preview: string }> =
      [];
    await vscode.commands.executeCommand("workbench.action.findInFiles", {
      query: params.query,
      triggerSearch: true,
      isRegex: Boolean(params.options?.isRegex),
      isCaseSensitive: Boolean(params.options?.isCaseSensitive),
      matchWholeWord: Boolean(params.options?.matchWholeWord),
      ...(params.options?.includes
        ? { filesToInclude: params.options.includes }
        : {}),
    });
    const uris = await vscode.workspace.findFiles(
      params.options?.includes
        ? new vscode.RelativePattern(
            params.workspacePath,
            params.options.includes,
          )
        : "**/*",
      "**/{node_modules,dist,build,.git,.next,.turbo,.cache}/**",
      Math.max(maxResults * 5, 50),
    );
    const regex = params.options?.isRegex
      ? new RegExp(
          params.query,
          `${params.options.isCaseSensitive ? "" : "i"}g`,
        )
      : null;
    const needle = params.options?.isCaseSensitive
      ? params.query
      : params.query.toLowerCase();
    for (const uri of uris) {
      if (matches.length >= maxResults) {
        break;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        for (let index = 0; index < document.lineCount; index += 1) {
          if (matches.length >= maxResults) {
            break;
          }
          const text = document.lineAt(index).text;
          const haystack = params.options?.isCaseSensitive
            ? text
            : text.toLowerCase();
          const matched = regex ? regex.test(text) : haystack.includes(needle);
          if (!matched) {
            if (regex) {
              regex.lastIndex = 0;
            }
            continue;
          }
          if (regex) {
            regex.lastIndex = 0;
          }
          matches.push({
            filePath: uri.fsPath,
            line: index,
            preview: text.trim().replace(/\s+/g, " "),
          });
        }
      } catch {
        continue;
      }
    }
    const lines =
      matches.length > 0
        ? matches.map(
            (match) =>
              `- ${params.asWorkspaceRelative(match.filePath)}:${match.line + 1} — ${match.preview}`,
          )
        : ["(no matches)"];
    return Object.freeze({
      success: true,
      content: lines.join("\n"),
      meta: Object.freeze({
        query: params.query,
        matches: matches.length,
        ...(params.options?.includes
          ? { includes: params.options.includes }
          : {}),
        operation: "workspace_search",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/** Find symbol references for a location or symbol name inside a file. */
export async function findReferencesTool(
  params: Readonly<{
    workspacePath: string;
    filePath: string;
    asWorkspaceRelative: RelativePathFormatter;
    options?: Readonly<{
      line?: number;
      character?: number;
      symbol?: string;
      maxResults?: number;
    }>;
  }>,
): Promise<ToolResult> {
  try {
    const targetPath = resolveWorkspaceFilePath(
      params.workspacePath,
      params.filePath,
    );
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(targetPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    });

    let position: vscode.Position | null = null;
    if (typeof params.options?.line === "number") {
      const line = Math.max(
        0,
        Math.min(params.options.line - 1, document.lineCount - 1),
      );
      const character = Math.max(
        0,
        Math.min(
          (params.options.character ?? 1) - 1,
          document.lineAt(line).text.length,
        ),
      );
      position = new vscode.Position(line, character);
    } else if (params.options?.symbol) {
      const text = document.getText();
      const index = text.indexOf(params.options.symbol);
      if (index >= 0) {
        position = document.positionAt(index);
      }
    }

    if (!position) {
      return Object.freeze({
        success: false,
        content: "",
        error:
          "Unable to determine a symbol position for vscode_find_references. Provide line/character or a symbol that exists in the file.",
      });
    }

    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter,
    );
    const references =
      (await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        document.uri,
        position,
      )) ?? [];
    const maxResults = Math.max(
      1,
      Math.min(params.options?.maxResults ?? 20, 100),
    );
    const lines = references.slice(0, maxResults).map((location) => {
      const relative = params.asWorkspaceRelative(location.uri.fsPath);
      return `- ${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
    });
    return Object.freeze({
      success: true,
      content: lines.length > 0 ? lines.join("\n") : "(no references)",
      meta: Object.freeze({
        filePath: targetPath,
        referencesCount: references.length,
        operation: "find_references",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/** Invoke a public extension command and summarize the result. */
export async function executeExtensionCommandTool(
  params: Readonly<{
    commandId: string;
    title: string;
    extensionId: string;
    appendLog: LogWriter;
  }>,
): Promise<ToolResult> {
  try {
    await vscode.commands.executeCommand(params.commandId);
    const label = params.title.trim() || params.commandId;
    params.appendLog(
      "info",
      `Executed public extension command ${params.commandId} from ${params.extensionId}.`,
    );
    return Object.freeze({
      success: true,
      content: `Executed extension command "${label}" from ${params.extensionId}.`,
      meta: Object.freeze({
        commandId: params.commandId,
        extensionId: params.extensionId,
        operation: "extension_command",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Extension command failed (${params.commandId}): ${String(error)}`,
    });
  }
}

/** Invoke a VS Code language model tool and normalize the returned content. */
export async function invokeLanguageModelToolTool(
  params: Readonly<{
    toolName: string;
    title: string;
    extensionId: string;
    input: Readonly<Record<string, unknown>>;
    appendLog: LogWriter;
  }>,
): Promise<ToolResult> {
  try {
    const result = await vscode.lm.invokeTool(params.toolName, {
      toolInvocationToken: undefined,
      input: { ...params.input },
    });
    const parts = result.content.map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        const decoded = Buffer.from(part.data).toString("utf8");
        return part.mimeType.includes("json") ? decoded : decoded;
      }
      if (part instanceof vscode.LanguageModelPromptTsxPart) {
        return JSON.stringify(part.value, null, 2);
      }
      try {
        return JSON.stringify(part, null, 2);
      } catch {
        return String(part);
      }
    });
    const label = params.title.trim() || params.toolName;
    const content = parts.filter(Boolean).join("\n").trim();
    params.appendLog(
      "info",
      `Invoked LM tool ${params.toolName} from ${params.extensionId}.`,
    );
    return Object.freeze({
      success: true,
      content:
        content ||
        `Invoked language model tool "${label}" from ${params.extensionId}.`,
      meta: Object.freeze({
        toolName: params.toolName,
        extensionId: params.extensionId,
        operation: "lm_tool",
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Language model tool failed (${params.toolName}): ${String(error)}`,
    });
  }
}
