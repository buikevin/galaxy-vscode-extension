/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc HTML builder for the native Galaxy diff review panel.
 */

import * as vscode from "vscode";
import type { ChangedFileSummary } from "../shared/runtime";
import type {
  OpenProviderReviewPanelParams,
  ReviewPanelCallbacks,
  ReviewPanelHtmlParams,
  ReviewRow,
} from "../shared/review-panel";

/** Escape HTML special characters for inline markup construction. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert one changed file into split/unified review rows. */
function buildReviewRows(file: ChangedFileSummary): readonly ReviewRow[] {
  const originalLines = (file.originalContent ?? "").split("\n");
  const currentLines = (file.currentContent ?? "").split("\n");

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < currentLines.length &&
    originalLines[prefix] === currentLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] ===
      currentLines[currentLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: ReviewRow[] = [];
  if (prefix > 0) {
    rows.push(Object.freeze({ type: "collapsed", count: prefix }));
  }

  const originalChanged = originalLines.slice(
    prefix,
    originalLines.length - suffix,
  );
  const currentChanged = currentLines.slice(
    prefix,
    currentLines.length - suffix,
  );
  const maxChanged = Math.max(originalChanged.length, currentChanged.length);
  for (let index = 0; index < maxChanged; index += 1) {
    const leftText = originalChanged[index];
    const rightText = currentChanged[index];
    const leftNumber = typeof leftText === "string" ? prefix + index + 1 : null;
    const rightNumber =
      typeof rightText === "string" ? prefix + index + 1 : null;
    const kind =
      typeof leftText === "string" && typeof rightText === "string"
        ? "modified"
        : typeof leftText === "string"
          ? "deleted"
          : "added";
    rows.push(
      Object.freeze({
        type: "line",
        kind,
        leftNumber,
        rightNumber,
        leftText: leftText ?? "",
        rightText: rightText ?? "",
      }),
    );
  }

  if (suffix > 0) {
    rows.push(Object.freeze({ type: "collapsed", count: suffix }));
  }

  if (rows.length === 0) {
    rows.push(
      Object.freeze({
        type: "line",
        kind: "unchanged",
        leftNumber: 1,
        rightNumber: 1,
        leftText: originalLines[0] ?? "",
        rightText: currentLines[0] ?? "",
      }),
    );
  }

  return Object.freeze(rows);
}

/** Build the complete HTML for the native review panel webview. */
export function getReviewPanelHtml(params: ReviewPanelHtmlParams): string {
  const nonce = params.createMessageId();
  const payload = {
    fileCount: params.summary.fileCount,
    addedLines: params.summary.addedLines,
    deletedLines: params.summary.deletedLines,
    files: params.summary.files.map((file) => ({
      filePath: file.filePath,
      label: params.asWorkspaceRelative(file.filePath),
      wasNew: file.wasNew,
      addedLines: file.addedLines,
      deletedLines: file.deletedLines,
      rows: buildReviewRows(file),
    })),
  };
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${params.webview.cspSource} https: data:; style-src 'unsafe-inline' ${params.webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Diff</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #171717; color: #f5f5f5; }
      .app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
      .sidebar { border-right: 1px solid rgba(255,255,255,0.08); background: #141414; display: flex; flex-direction: column; min-height: 0; }
      .sidebar-header { padding: 18px 18px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .title { font-size: 14px; font-weight: 700; letter-spacing: 0.01em; }
      .meta { margin-top: 10px; color: #c4c4c4; font-size: 12px; }
      .toolbar { display: flex; gap: 8px; margin-top: 14px; }
      button { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #f5f5f5; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; }
      button:hover { background: rgba(255,255,255,0.08); }
      .file-list { overflow: auto; padding: 10px; display: grid; gap: 8px; }
      .file-item { width: 100%; border: 1px solid rgba(255,255,255,0.06); background: #1b1b1b; color: inherit; text-align: left; padding: 12px; border-radius: 12px; }
      .file-item.active { border-color: rgba(96,165,250,0.45); background: #1f2937; }
      .file-path { font-size: 13px; font-weight: 600; line-height: 1.4; word-break: break-word; }
      .file-stats { margin-top: 6px; font-size: 12px; color: #a3a3a3; }
      .plus { color: #4ade80; }
      .minus { color: #f87171; }
      .content { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .content-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); background: #181818; gap: 16px; }
      .content-title { font-size: 18px; font-weight: 700; }
      .content-subtitle { margin-top: 4px; font-size: 12px; color: #a3a3a3; }
      .content-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
      .mode-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.03); }
      .mode-toggle button { padding: 6px 10px; border-radius: 8px; border-color: transparent; background: transparent; }
      .mode-toggle button.active { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.08); }
      .diff-wrap { overflow: auto; padding: 16px; min-height: 0; }
      .diff-grid { border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; overflow: hidden; background: #111111; }
      .diff-head, .diff-row, .diff-collapsed { display: grid; grid-template-columns: 1fr 1fr; }
      .diff-head > div { padding: 12px 14px; font-size: 12px; color: #a3a3a3; background: #202020; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .diff-head > div:first-child, .diff-row > div:first-child { border-right: 1px solid rgba(255,255,255,0.08); }
      .diff-row > div { display: grid; grid-template-columns: 56px 1fr; min-height: 28px; }
      .diff-grid.unified .diff-head, .diff-grid.unified .diff-row, .diff-grid.unified .diff-collapsed { grid-template-columns: 1fr; }
      .diff-grid.unified .diff-head > div:first-child, .diff-grid.unified .diff-row > div:first-child { border-right: none; }
      .diff-grid.unified .line-single { display: grid; grid-template-columns: 56px 1fr; }
      .gutter { padding: 6px 10px; font-size: 12px; color: #737373; background: rgba(255,255,255,0.02); user-select: none; }
      .code { padding: 6px 12px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
      .kind-added { background: rgba(34,197,94,0.12); }
      .kind-deleted { background: rgba(239,68,68,0.12); }
      .kind-modified { background: rgba(250,204,21,0.08); }
      .kind-unchanged { background: transparent; }
      .diff-collapsed > div { padding: 10px 14px; font-size: 12px; color: #a3a3a3; background: #252525; border-top: 1px solid rgba(255,255,255,0.06); }
      .empty { padding: 24px; color: #a3a3a3; }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="title">Galaxy Diff</div>
          <div class="meta">${params.summary.fileCount} files changed <span class="plus">+${params.summary.addedLines}</span> <span class="minus">-${params.summary.deletedLines}</span></div>
          <div class="toolbar">
            <button data-action="revert-all">Revert all</button>
          </div>
        </div>
        <div id="file-list" class="file-list"></div>
      </aside>
      <main class="content">
        <div class="content-header">
          <div>
            <div id="content-title" class="content-title">No file selected</div>
            <div id="content-subtitle" class="content-subtitle"></div>
          </div>
          <div class="content-actions">
            <div class="mode-toggle">
              <button id="mode-unified" data-action="set-mode" data-mode="unified">Unified</button>
              <button id="mode-split" class="active" data-action="set-mode" data-mode="split">Split</button>
            </div>
            <button id="open-diff-button" data-action="open-diff">Open native diff</button>
            <button id="revert-file-button" data-action="revert-file">Revert file</button>
          </div>
        </div>
        <div id="diff-wrap" class="diff-wrap">
          <div class="empty">No tracked changes in this session.</div>
        </div>
      </main>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const data = ${payloadJson};
      let selectedPath = data.files[0]?.filePath || null;
      let viewMode = 'split';

      const fileList = document.getElementById('file-list');
      const contentTitle = document.getElementById('content-title');
      const contentSubtitle = document.getElementById('content-subtitle');
      const diffWrap = document.getElementById('diff-wrap');
      const unifiedButton = document.getElementById('mode-unified');
      const splitButton = document.getElementById('mode-split');

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderRows(file) {
        const rows = file.rows || [];
        if (rows.length === 0) {
          return '<div class="empty">No diff data available.</div>';
        }

        const body = rows.map((row) => {
          if (row.type === 'collapsed') {
            return '<div class="diff-collapsed"><div>' + row.count + ' unmodified lines</div><div>' + row.count + ' unmodified lines</div></div>';
          }

          const kindClass = row.kind ? 'kind-' + row.kind : '';
          if (viewMode === 'unified') {
            const deletedLine = row.leftText
              ? '<div class="line-single kind-deleted"><div class="gutter">' + (row.leftNumber ?? '') + '</div><div class="code">- ' + escapeHtml(row.leftText ?? '') + '</div></div>'
              : '';
            const addedLine = row.rightText
              ? '<div class="line-single kind-added"><div class="gutter">' + (row.rightNumber ?? '') + '</div><div class="code">+ ' + escapeHtml(row.rightText ?? '') + '</div></div>'
              : '';
            if (row.kind === 'unchanged') {
              return '<div class="diff-row"><div class="line-single"><div class="gutter">' + (row.rightNumber ?? row.leftNumber ?? '') + '</div><div class="code">  ' + escapeHtml(row.rightText ?? row.leftText ?? '') + '</div></div></div>';
            }
            if (row.kind === 'modified') {
              return '<div class="diff-row"><div>' + deletedLine + addedLine + '</div></div>';
            }
            return '<div class="diff-row"><div>' + (row.kind === 'deleted' ? deletedLine : addedLine) + '</div></div>';
          }
          return (
            '<div class="diff-row">'
              + '<div class="' + kindClass + '">'
              + '<div class="gutter">' + (row.leftNumber ?? '') + '</div>'
              + '<div class="code">' + escapeHtml(row.leftText ?? '') + '</div>'
              + '</div>'
              + '<div class="' + kindClass + '">'
              + '<div class="gutter">' + (row.rightNumber ?? '') + '</div>'
              + '<div class="code">' + escapeHtml(row.rightText ?? '') + '</div>'
              + '</div>'
              + '</div>'
          );
        }).join('');

        return (
          '<div class="diff-grid ' + (viewMode === 'unified' ? 'unified' : 'split') + '">'
            + '<div class="diff-head">'
            + (viewMode === 'unified'
              ? '<div>Unified Diff</div>'
              : '<div>Original</div><div>Current</div>')
            + '</div>'
            + body
            + '</div>'
        );
      }

      function renderFileList() {
        if (!fileList) return;
        fileList.innerHTML = data.files.map((file) => (
          '<button class="file-item' + (file.filePath === selectedPath ? ' active' : '') + '" data-action="select-file" data-path="' + escapeHtml(file.filePath) + '">'
            + '<div class="file-path">' + escapeHtml(file.label + (file.wasNew ? ' (new)' : '')) + '</div>'
            + '<div class="file-stats"><span class="plus">+' + file.addedLines + '</span> <span class="minus">-' + file.deletedLines + '</span></div>'
            + '</button>'
        )).join('');
      }

      function renderSelectedFile() {
        const file = data.files.find((item) => item.filePath === selectedPath) || data.files[0];
        if (!file) {
          if (diffWrap) diffWrap.innerHTML = '<div class="empty">No tracked changes in this session.</div>';
          if (contentTitle) contentTitle.textContent = 'No file selected';
          if (contentSubtitle) contentSubtitle.textContent = '';
          return;
        }

        selectedPath = file.filePath;
        if (contentTitle) contentTitle.textContent = file.label + (file.wasNew ? ' (new)' : '');
        if (contentSubtitle) contentSubtitle.textContent = '+' + file.addedLines + ' / -' + file.deletedLines;
        if (diffWrap) diffWrap.innerHTML = renderRows(file);
        if (unifiedButton && splitButton) {
          unifiedButton.classList.toggle('active', viewMode === 'unified');
          splitButton.classList.toggle('active', viewMode === 'split');
        }
      }

      renderFileList();
      renderSelectedFile();

      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const actionTarget = target.closest('[data-action]');
        if (!(actionTarget instanceof HTMLElement)) return;
        const action = actionTarget.dataset.action;
        if (!action) return;
        if (action === 'revert-all') {
          vscode.postMessage({ type: 'revert-all-changes' });
        }
        if (action === 'select-file' && actionTarget.dataset.path) {
          selectedPath = actionTarget.dataset.path;
          renderFileList();
          renderSelectedFile();
        }
        if (action === 'set-mode' && actionTarget.dataset.mode) {
          viewMode = actionTarget.dataset.mode === 'unified' ? 'unified' : 'split';
          renderSelectedFile();
        }
        if (action === 'open-diff') {
          if (selectedPath) {
            vscode.postMessage({ type: 'file-diff', payload: { filePath: selectedPath } });
          }
        }
        if (action === 'revert-file') {
          if (selectedPath) {
            vscode.postMessage({ type: 'revert-file-change', payload: { filePath: selectedPath } });
          }
        }
      });
    </script>
  </body>
</html>`;
}

/** Opens the native review panel and keeps its HTML synchronized after review actions. */
export async function openReviewPanel(
  callbacks: ReviewPanelCallbacks,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "galaxy-code.reviewChanges",
    "Galaxy Diff",
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  panel.webview.html = callbacks.renderHtml(panel.webview);
  panel.webview.onDidReceiveMessage((message) => {
    void callbacks.handleMessage(message).then(async () => {
      await callbacks.refreshWorkspaceFiles();
      panel.webview.html = callbacks.renderHtml(panel.webview);
    });
  });
}

/** Opens the native review panel using provider-owned state and callbacks. */
export async function openProviderReviewPanel(
  params: OpenProviderReviewPanelParams,
): Promise<void> {
  await openReviewPanel({
    renderHtml: (webview) =>
      getReviewPanelHtml({
        webview,
        summary: params.getSummary(),
        asWorkspaceRelative: params.asWorkspaceRelative,
        createMessageId: params.createMessageId,
      }),
    handleMessage: params.handleMessage,
    refreshWorkspaceFiles: params.refreshWorkspaceFiles,
  });
}
