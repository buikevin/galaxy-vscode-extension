/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Native workflow graph explorer panel for inspecting grouped workflow subgraphs inside VS Code.
 */

import path from "node:path";
import * as vscode from "vscode";
import { resolveEffectiveProjectPath } from "../context/active-project";
import { refreshWorkflowGraph } from "../context/workflow/extractor/runtime";
import type {
  WorkflowViewGraphEdge,
  WorkflowViewGraphModel,
  WorkflowViewGraphNode,
} from "../context/workflow/view/model";
import {
  describeWorkflowViewScope,
  resolveWorkflowViewGraphModel,
} from "../context/workflow/view/resolver";
import { asWorkspaceRelativePath } from "./session-sync";

type WorkflowGraphExplorerCommandInput = Readonly<{
  entryNodeId?: string;
  routePath?: string;
  filePath?: string;
  query?: string;
  maxHops?: number;
  maxNodes?: number;
  includeIncoming?: boolean;
  includeExternal?: boolean;
}>;

type WorkflowGraphExplorerNodeItem = Readonly<{
  id: string;
  label: string;
  subtitle: string;
  nodeType: string;
  filePath?: string;
  line?: number;
  locationLabel?: string;
  isEntry: boolean;
  isExternal: boolean;
}>;

type WorkflowGraphExplorerEdgeItem = Readonly<{
  id: string;
  label: string;
  edgeType: string;
  fromLabel: string;
  toLabel: string;
  supportingFilePath?: string;
  supportingLine?: number;
  supportingLocationLabel?: string;
}>;

type WorkflowGraphExplorerPayload = Readonly<{
  graphTitle: string;
  graphSummary: string;
  scopeLabel: string;
  dominantFlowKind: string;
  groupCount: number;
  nodeCount: number;
  edgeCount: number;
  focusPaths: readonly string[];
  groups: readonly Readonly<{
    groupKey: string;
    title: string;
    kind: string;
    nodeCount: number;
    nodes: readonly WorkflowGraphExplorerNodeItem[];
  }>[];
  edges: readonly WorkflowGraphExplorerEdgeItem[];
}>;

type WorkflowGraphExplorerPanelState = Readonly<{
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  projectPath: string;
  request: WorkflowGraphExplorerCommandInput;
  payload: WorkflowGraphExplorerPayload;
}>;

type WorkflowGraphExplorerMessage =
  | Readonly<{ type: "refresh" }>
  | Readonly<{
      type: "open-node";
      payload: Readonly<{ filePath: string; line?: number }>;
    }>
  | Readonly<{
      type: "open-edge";
      payload: Readonly<{ filePath: string; line?: number }>;
    }>;

let workflowGraphExplorerState: WorkflowGraphExplorerPanelState | null = null;

type WorkflowExplorerQuickPickItem = vscode.QuickPickItem &
  Readonly<{
    scopeKind: "file" | "route" | "query" | "entry_node";
  }>;

function createMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getActiveEditorFilePath(): string | null {
  const document = vscode.window.activeTextEditor?.document;
  return document?.uri.scheme === "file" ? document.uri.fsPath : null;
}

function normalizeFileScopeValue(
  workspaceRoot: string,
  projectPath: string,
  filePath: string,
): string {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(projectPath, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `File ${filePath} is outside the detected project scope ${projectPath}.`,
    );
  }
  return relativePath.split(path.sep).join("/");
}

function normalizeCommandInput(
  rawInput: unknown,
): WorkflowGraphExplorerCommandInput | null {
  if (!rawInput) {
    return null;
  }
  if (typeof rawInput === "string") {
    const query = rawInput.trim();
    return query ? Object.freeze({ query }) : null;
  }
  if (typeof rawInput !== "object") {
    return null;
  }

  const input = rawInput as Record<string, unknown>;
  const readString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  };
  const readNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };
  const readBoolean = (...keys: string[]): boolean | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
    return undefined;
  };

  return Object.freeze({
    ...(readString("entryNodeId", "entry_node_id")
      ? { entryNodeId: readString("entryNodeId", "entry_node_id") }
      : {}),
    ...(readString("routePath", "route_path")
      ? { routePath: readString("routePath", "route_path") }
      : {}),
    ...(readString("filePath", "file_path")
      ? { filePath: readString("filePath", "file_path") }
      : {}),
    ...(readString("query") ? { query: readString("query") } : {}),
    ...(typeof readNumber("maxHops", "max_hops") === "number"
      ? { maxHops: readNumber("maxHops", "max_hops") }
      : {}),
    ...(typeof readNumber("maxNodes", "max_nodes") === "number"
      ? { maxNodes: readNumber("maxNodes", "max_nodes") }
      : {}),
    ...(typeof readBoolean("includeIncoming", "include_incoming") === "boolean"
      ? {
          includeIncoming: readBoolean("includeIncoming", "include_incoming"),
        }
      : {}),
    ...(typeof readBoolean("includeExternal", "include_external") === "boolean"
      ? {
          includeExternal: readBoolean("includeExternal", "include_external"),
        }
      : {}),
  });
}

function buildNodeSubtitle(node: WorkflowViewGraphNode): string {
  if (node.routeMethod && node.routePath) {
    return `${node.routeMethod} ${node.routePath}`;
  }
  if (node.symbolName) {
    return node.symbolName;
  }
  return node.nodeType.replace(/_/g, " ");
}

function buildLocationLabel(
  filePath?: string,
  line?: number,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  return typeof line === "number" ? `${filePath}:${line}` : filePath;
}

export function buildWorkflowGraphExplorerPayload(
  model: WorkflowViewGraphModel,
  scopeLabel: string,
): WorkflowGraphExplorerPayload {
  const nodeLookup = new Map(model.nodes.map((node) => [node.id, node]));

  return Object.freeze({
    graphTitle: model.graphTitle,
    graphSummary: model.graphSummary,
    scopeLabel,
    dominantFlowKind: model.dominantFlowKind,
    groupCount: model.groups.length,
    nodeCount: model.nodes.length,
    edgeCount: model.edges.length,
    focusPaths: model.focusPaths,
    groups: Object.freeze(
      model.groups.map((group) => {
        const groupNodes = model.nodes
          .filter((node) => node.groupKey === group.groupKey)
          .map<WorkflowGraphExplorerNodeItem>((node) =>
            Object.freeze({
              id: node.id,
              label: node.label,
              subtitle: buildNodeSubtitle(node),
              nodeType: node.nodeType,
              ...(node.filePath ? { filePath: node.filePath } : {}),
              ...(typeof node.startLine === "number"
                ? { line: node.startLine }
                : {}),
              ...(buildLocationLabel(node.filePath, node.startLine)
                ? {
                    locationLabel: buildLocationLabel(
                      node.filePath,
                      node.startLine,
                    ),
                  }
                : {}),
              isEntry: node.isEntry,
              isExternal: node.isExternal,
            }),
          );

        return Object.freeze({
          groupKey: group.groupKey,
          title: group.title,
          kind: group.kind,
          nodeCount: groupNodes.length,
          nodes: Object.freeze(groupNodes),
        });
      }),
    ),
    edges: Object.freeze(
      model.edges.slice(0, 32).map<WorkflowGraphExplorerEdgeItem>((edge) => {
        const fromNode = nodeLookup.get(edge.fromNodeId);
        const toNode = nodeLookup.get(edge.toNodeId);
        return Object.freeze({
          id: edge.id,
          label: edge.label || edge.edgeType.replace(/_/g, " "),
          edgeType: edge.edgeType,
          fromLabel: fromNode?.label ?? edge.fromNodeId,
          toLabel: toNode?.label ?? edge.toNodeId,
          ...(edge.supportingFilePath
            ? { supportingFilePath: edge.supportingFilePath }
            : {}),
          ...(typeof edge.supportingLine === "number"
            ? { supportingLine: edge.supportingLine }
            : {}),
          ...(buildLocationLabel(edge.supportingFilePath, edge.supportingLine)
            ? {
                supportingLocationLabel: buildLocationLabel(
                  edge.supportingFilePath,
                  edge.supportingLine,
                ),
              }
            : {}),
        });
      }),
    ),
  });
}

export function getWorkflowGraphExplorerHtml(params: {
  webview: vscode.Webview;
  payload: WorkflowGraphExplorerPayload;
  createNonce: () => string;
}): string {
  const nonce = params.createNonce();
  const payloadJson = JSON.stringify(params.payload).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${params.webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workflow Graph Explorer</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #111827; color: #f8fafc; }
      .app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
      .sidebar { border-right: 1px solid rgba(255,255,255,0.08); background: #0f172a; overflow: auto; }
      .sidebar-inner { padding: 20px; display: grid; gap: 18px; }
      .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; }
      .title { font-size: 20px; font-weight: 700; line-height: 1.3; }
      .summary { font-size: 13px; line-height: 1.6; color: #cbd5e1; }
      .chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip { border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); border-radius: 999px; padding: 6px 10px; font-size: 12px; color: #dbeafe; }
      .focus-list, .edge-list { display: grid; gap: 10px; }
      .focus-item, .edge-item { border: 1px solid rgba(255,255,255,0.08); background: rgba(15,23,42,0.72); border-radius: 14px; padding: 12px; }
      .focus-item { font-size: 12px; line-height: 1.6; color: #e2e8f0; }
      .edge-label { font-size: 12px; font-weight: 700; color: #f8fafc; }
      .edge-path { margin-top: 4px; font-size: 12px; color: #93c5fd; }
      .edge-evidence { margin-top: 6px; border: none; background: transparent; color: #7dd3fc; padding: 0; cursor: pointer; font-size: 12px; text-align: left; }
      .main { display: flex; flex-direction: column; min-width: 0; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); background: #111827; }
      .toolbar-meta { font-size: 12px; color: #94a3b8; }
      .refresh-button { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: #f8fafc; border-radius: 12px; padding: 9px 13px; cursor: pointer; }
      .refresh-button:hover { background: rgba(255,255,255,0.1); }
      .groups { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 320px); gap: 16px; padding: 20px; overflow: auto; align-items: start; }
      .group { border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; background: rgba(15,23,42,0.72); min-height: 180px; }
      .group-header { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .group-title { font-size: 14px; font-weight: 700; }
      .group-count { font-size: 11px; color: #cbd5e1; }
      .group-nodes { padding: 12px; display: grid; gap: 10px; }
      .node-card { width: 100%; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: inherit; border-radius: 14px; padding: 12px; text-align: left; cursor: pointer; }
      .node-card:hover { background: rgba(255,255,255,0.08); }
      .node-card.entry { border-color: rgba(96,165,250,0.5); box-shadow: inset 0 0 0 1px rgba(96,165,250,0.24); }
      .node-card.static { cursor: default; }
      .node-label { font-size: 13px; font-weight: 700; line-height: 1.5; }
      .node-subtitle { margin-top: 4px; font-size: 12px; color: #cbd5e1; }
      .node-location { margin-top: 8px; font-size: 11px; color: #7dd3fc; word-break: break-word; }
      .node-badges { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
      .badge { border-radius: 999px; padding: 4px 8px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; background: rgba(255,255,255,0.09); color: #e2e8f0; }
      .group-frontend { border-top: 3px solid #60a5fa; }
      .group-backend { border-top: 3px solid #c084fc; }
      .group-data { border-top: 3px solid #34d399; }
      .group-async { border-top: 3px solid #f59e0b; }
      .group-external { border-top: 3px solid #fb7185; }
      .empty { padding: 24px; font-size: 13px; color: #94a3b8; }
      @media (max-width: 960px) { .app { grid-template-columns: 1fr; } .sidebar { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.08); max-height: 45vh; } }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <div class="sidebar-inner">
          <div>
            <div class="eyebrow">Workflow Graph Explorer</div>
            <div id="graph-title" class="title"></div>
            <div id="graph-summary" class="summary"></div>
          </div>
          <div id="graph-chips" class="chips"></div>
          <div>
            <div class="eyebrow">Focus Paths</div>
            <div id="focus-list" class="focus-list"></div>
          </div>
          <div>
            <div class="eyebrow">Important Edges</div>
            <div id="edge-list" class="edge-list"></div>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="toolbar">
          <div>
            <div id="scope-label" class="title" style="font-size: 15px;"></div>
            <div id="toolbar-meta" class="toolbar-meta"></div>
          </div>
          <button class="refresh-button" data-action="refresh">Refresh Graph</button>
        </div>
        <div id="groups" class="groups"></div>
      </main>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const payload = ${payloadJson};

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderChips() {
        return [
          payload.dominantFlowKind,
          payload.nodeCount + ' nodes',
          payload.edgeCount + ' edges',
          payload.groupCount + ' groups',
        ].map((item) => '<div class="chip">' + escapeHtml(item) + '</div>').join('');
      }

      function renderFocusList() {
        if (!payload.focusPaths.length) {
          return '<div class="empty">No focus paths were derived for this scope.</div>';
        }
        return payload.focusPaths.map((item) => '<div class="focus-item">' + escapeHtml(item) + '</div>').join('');
      }

      function renderEdgeList() {
        if (!payload.edges.length) {
          return '<div class="empty">No supporting edges were found for this selection.</div>';
        }
        return payload.edges.map((edge) => {
          const evidenceButton = edge.supportingFilePath
            ? '<button class="edge-evidence" data-action="open-edge" data-file-path="' + escapeHtml(edge.supportingFilePath) + '"' + (typeof edge.supportingLine === 'number' ? ' data-line="' + edge.supportingLine + '"' : '') + '>Open evidence: ' + escapeHtml(edge.supportingLocationLabel || edge.supportingFilePath) + '</button>'
            : '';
          return '<div class="edge-item">'
            + '<div class="edge-label">' + escapeHtml(edge.label) + '</div>'
            + '<div class="edge-path">' + escapeHtml(edge.fromLabel + ' -> ' + edge.toLabel) + '</div>'
            + evidenceButton
            + '</div>';
        }).join('');
      }

      function renderGroups() {
        if (!payload.groups.length) {
          return '<div class="empty">No grouped workflow nodes were found for this selection.</div>';
        }
        return payload.groups.map((group) => {
          const nodes = group.nodes.map((node) => {
            const badges = [node.nodeType];
            if (node.isEntry) badges.push('entry');
            if (node.isExternal) badges.push('external');
            const cardTag = node.filePath ? 'button' : 'div';
            const actionAttrs = node.filePath
              ? ' data-action="open-node" data-file-path="' + escapeHtml(node.filePath) + '"' + (typeof node.line === 'number' ? ' data-line="' + node.line + '"' : '')
              : '';
            return '<' + cardTag + ' class="node-card' + (node.isEntry ? ' entry' : '') + (node.filePath ? '' : ' static') + '"' + actionAttrs + '>'
              + '<div class="node-label">' + escapeHtml(node.label) + '</div>'
              + '<div class="node-subtitle">' + escapeHtml(node.subtitle) + '</div>'
              + (node.locationLabel ? '<div class="node-location">' + escapeHtml(node.locationLabel) + '</div>' : '')
              + '<div class="node-badges">' + badges.map((badge) => '<span class="badge">' + escapeHtml(badge) + '</span>').join('') + '</div>'
              + '</' + cardTag + '>';
          }).join('');

          return '<section class="group group-' + escapeHtml(group.kind) + '">'
            + '<div class="group-header">'
            + '<div class="group-title">' + escapeHtml(group.title) + '</div>'
            + '<div class="group-count">' + group.nodeCount + ' nodes</div>'
            + '</div>'
            + '<div class="group-nodes">' + nodes + '</div>'
            + '</section>';
        }).join('');
      }

      document.getElementById('graph-title').textContent = payload.graphTitle;
      document.getElementById('graph-summary').textContent = payload.graphSummary;
      document.getElementById('scope-label').textContent = 'Source: ' + payload.scopeLabel;
      document.getElementById('toolbar-meta').textContent = payload.dominantFlowKind + ' • ' + payload.nodeCount + ' nodes • ' + payload.edgeCount + ' edges';
      document.getElementById('graph-chips').innerHTML = renderChips();
      document.getElementById('focus-list').innerHTML = renderFocusList();
      document.getElementById('edge-list').innerHTML = renderEdgeList();
      document.getElementById('groups').innerHTML = renderGroups();

      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const actionTarget = target.closest('[data-action]');
        if (!(actionTarget instanceof HTMLElement)) return;
        const action = actionTarget.dataset.action;
        if (action === 'refresh') {
          vscode.postMessage({ type: 'refresh' });
          return;
        }
        if ((action === 'open-node' || action === 'open-edge') && actionTarget.dataset.filePath) {
          const line = actionTarget.dataset.line ? Number(actionTarget.dataset.line) : undefined;
          vscode.postMessage({
            type: action,
            payload: {
              filePath: actionTarget.dataset.filePath,
              ...(Number.isFinite(line) ? { line } : {}),
            },
          });
        }
      });
    </script>
  </body>
</html>`;
}

async function openFileAtLocation(
  projectPath: string,
  relativeFilePath: string,
  line?: number,
): Promise<void> {
  const absolutePath = path.resolve(projectPath, relativeFilePath);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(absolutePath),
  );
  const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
  });
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter,
  );
}

async function promptForWorkflowGraphExplorerInput(
  workspaceRoot: string,
): Promise<WorkflowGraphExplorerCommandInput | null> {
  const activeFilePath = getActiveEditorFilePath();
  const choices: WorkflowExplorerQuickPickItem[] = [];

  if (activeFilePath && activeFilePath.startsWith(workspaceRoot)) {
    choices.push(
      Object.freeze({
        label: "Active File",
        description: asWorkspaceRelativePath(activeFilePath),
        scopeKind: "file",
      }),
    );
  }
  choices.push(
    Object.freeze({
      label: "Route Path",
      description: "Explore a route such as /api/customers",
      scopeKind: "route",
    }),
    Object.freeze({
      label: "Workflow Query",
      description: "Search using a flow phrase such as customer submit flow",
      scopeKind: "query",
    }),
    Object.freeze({
      label: "Entry Node ID",
      description: "Open a specific workflow node by id",
      scopeKind: "entry_node",
    }),
  );

  const picked =
    await vscode.window.showQuickPick<WorkflowExplorerQuickPickItem>(choices, {
      title: "Open Workflow Graph Explorer",
      placeHolder: "Choose the workflow scope to inspect",
    });
  if (!picked) {
    return null;
  }

  if (picked.scopeKind === "file") {
    return activeFilePath ? Object.freeze({ filePath: activeFilePath }) : null;
  }

  const input = await vscode.window.showInputBox({
    title: "Open Workflow Graph Explorer",
    prompt:
      picked.scopeKind === "route"
        ? "Enter the route path to inspect"
        : picked.scopeKind === "query"
          ? "Describe the workflow you want to inspect"
          : "Enter the workflow entry node id",
    placeHolder:
      picked.scopeKind === "route"
        ? "/api/customers"
        : picked.scopeKind === "query"
          ? "customer submit flow"
          : "screen-customer-form",
    validateInput: (value) =>
      value.trim().length > 0 ? null : "A non-empty value is required.",
  });
  if (!input?.trim()) {
    return null;
  }

  if (picked.scopeKind === "route") {
    return Object.freeze({ routePath: input.trim() });
  }
  if (picked.scopeKind === "query") {
    return Object.freeze({ query: input.trim() });
  }
  return Object.freeze({ entryNodeId: input.trim() });
}

async function buildWorkflowGraphExplorerState(
  workspaceRoot: string,
  rawInput: WorkflowGraphExplorerCommandInput | null,
): Promise<Omit<WorkflowGraphExplorerPanelState, "panel"> | null> {
  const request =
    rawInput ?? (await promptForWorkflowGraphExplorerInput(workspaceRoot));
  if (!request) {
    return null;
  }

  const activeFilePath = getActiveEditorFilePath();
  const candidateFilePaths = request.filePath
    ? [request.filePath]
    : activeFilePath
      ? [activeFilePath]
      : [];
  const projectPath = resolveEffectiveProjectPath({
    workspacePath: workspaceRoot,
    candidateFilePaths,
  });
  const normalizedRequest = Object.freeze({
    ...request,
    ...(request.filePath
      ? {
          filePath: normalizeFileScopeValue(
            workspaceRoot,
            projectPath,
            request.filePath,
          ),
        }
      : {}),
  });

  await refreshWorkflowGraph(projectPath);
  const { scope, model } = resolveWorkflowViewGraphModel(
    projectPath,
    normalizedRequest,
  );
  return Object.freeze({
    workspaceRoot,
    projectPath,
    request: normalizedRequest,
    payload: buildWorkflowGraphExplorerPayload(
      model,
      describeWorkflowViewScope(scope),
    ),
  });
}

function ensureWorkflowGraphExplorerPanel(): vscode.WebviewPanel {
  if (workflowGraphExplorerState?.panel) {
    return workflowGraphExplorerState.panel;
  }

  const panel = vscode.window.createWebviewPanel(
    "galaxy-code.workflowGraphExplorer",
    "Workflow Graph Explorer",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.onDidDispose(() => {
    if (workflowGraphExplorerState?.panel === panel) {
      workflowGraphExplorerState = null;
    }
  });
  panel.webview.onDidReceiveMessage(
    async (message: WorkflowGraphExplorerMessage) => {
      const current = workflowGraphExplorerState;
      if (!current) {
        return;
      }

      try {
        if (message.type === "refresh") {
          await renderWorkflowGraphExplorer(
            current.workspaceRoot,
            current.request,
          );
          return;
        }
        if (message.type === "open-node") {
          await openFileAtLocation(
            current.projectPath,
            message.payload.filePath,
            message.payload.line,
          );
          return;
        }
        if (message.type === "open-edge") {
          await openFileAtLocation(
            current.projectPath,
            message.payload.filePath,
            message.payload.line,
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `Workflow Graph Explorer failed: ${detail}`,
        );
      }
    },
  );
  return panel;
}

async function renderWorkflowGraphExplorer(
  workspaceRoot: string,
  rawInput: WorkflowGraphExplorerCommandInput | null,
): Promise<void> {
  const nextState = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Galaxy Code: Building workflow graph explorer",
      cancellable: false,
    },
    async () => buildWorkflowGraphExplorerState(workspaceRoot, rawInput),
  );
  if (!nextState) {
    return;
  }

  const panel = ensureWorkflowGraphExplorerPanel();
  workflowGraphExplorerState = Object.freeze({
    panel,
    ...nextState,
  });
  panel.title = `Workflow Graph: ${nextState.payload.graphTitle}`;
  panel.webview.html = getWorkflowGraphExplorerHtml({
    webview: panel.webview,
    payload: nextState.payload,
    createNonce: createMessageId,
  });
  panel.reveal(vscode.ViewColumn.Beside, false);
}

export async function openWorkflowGraphExplorer(
  rawInput?: unknown,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error(
      "Open a workspace folder before using Workflow Graph Explorer.",
    );
  }
  await renderWorkflowGraphExplorer(
    workspaceRoot,
    normalizeCommandInput(rawInput),
  );
}
