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
