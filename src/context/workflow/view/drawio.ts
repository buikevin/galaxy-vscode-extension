/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Draw.io export helpers for workflow graph view models.
 */

import type {
  WorkflowViewGraphEdge,
  WorkflowViewGraphGroup,
  WorkflowViewGraphModel,
  WorkflowViewGraphNode,
} from "./model";

const DIAGRAM_MARGIN_X = 40;
const DIAGRAM_MARGIN_Y = 20;
const DIAGRAM_GROUPS_PER_ROW = 4;
const DIAGRAM_GROUP_WIDTH = 280;
const DIAGRAM_GROUP_GAP_X = 32;
const DIAGRAM_GROUP_GAP_Y = 56;
const DIAGRAM_GROUP_HEADER_HEIGHT = 34;
const DIAGRAM_GROUP_PADDING_X = 24;
const DIAGRAM_GROUP_PADDING_Y = 18;
const DIAGRAM_NODE_HEIGHT = 60;
const DIAGRAM_NODE_GAP_Y = 14;
const DIAGRAM_SUMMARY_HEIGHT = 78;

type GroupLayout = Readonly<{
  group: WorkflowViewGraphGroup;
  nodes: readonly WorkflowViewGraphNode[];
  x: number;
  y: number;
  width: number;
  height: number;
}>;

function escapeXml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeCellId(prefix: string, value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix}_${normalized || "item"}_${index + 1}`;
}

function getGroupColors(group: WorkflowViewGraphGroup): Readonly<{
  fill: string;
  stroke: string;
}> {
  switch (group.kind) {
    case "frontend":
      return Object.freeze({ fill: "#eaf3ff", stroke: "#6c8ebf" });
    case "backend":
      return Object.freeze({ fill: "#f6edff", stroke: "#9673a6" });
    case "data":
      return Object.freeze({ fill: "#fff4df", stroke: "#d79b00" });
    case "async":
      return Object.freeze({ fill: "#fff0e1", stroke: "#d6b656" });
    case "external":
      return Object.freeze({ fill: "#ffe9ec", stroke: "#b85450" });
    default:
      return Object.freeze({ fill: "#f5f5f5", stroke: "#999999" });
  }
}

function buildSummaryValue(model: WorkflowViewGraphModel): string {
  const focusPath = model.focusPaths[0]?.trim();
  const focusLine = focusPath
    ? `<br/><font style="font-size:11px;color:#555555;">Primary path: ${escapeXml(focusPath)}</font>`
    : "";
  return `<b>${escapeXml(model.graphTitle)}</b><br/><font style="font-size:12px;color:#444444;">${escapeXml(model.graphSummary)}</font>${focusLine}`;
}

function formatNodeValue(node: WorkflowViewGraphNode): string {
  const detail =
    (node.routeMethod && node.routePath
      ? `${node.routeMethod} ${node.routePath}`
      : node.symbolName || node.nodeType) ?? node.nodeType;
  if (detail === node.label) {
    return `<b>${escapeXml(node.label)}</b>`;
  }
  return `<b>${escapeXml(node.label)}</b><br/><font style="font-size:11px;color:#555555;">${escapeXml(detail)}</font>`;
}

function getNodeStyle(node: WorkflowViewGraphNode): string {
  const common = [
    "whiteSpace=wrap",
    "html=1",
    "align=center",
    "verticalAlign=middle",
    "fontSize=12",
    "spacing=8",
  ];

  if (node.nodeType === "screen") {
    return `${common.join(";")};rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (node.nodeType === "component") {
    return `${common.join(";")};rounded=0;fillColor=#f5f5f5;strokeColor=#999999;strokeWidth=${node.isEntry ? 3 : 1};`;
  }
  if (node.nodeType === "api_endpoint") {
    return `${common.join(";")};rounded=1;fillColor=#d5e8d4;strokeColor=#82b366;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (node.nodeType === "service" || node.nodeType === "controller") {
    return `${common.join(";")};rounded=1;fillColor=#ffe6cc;strokeColor=#d79b00;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (
    node.nodeType === "repository" ||
    node.nodeType === "db_query" ||
    node.nodeType === "database_table" ||
    node.nodeType === "cache"
  ) {
    return `${common.join(";")};rounded=1;fillColor=#fff2cc;strokeColor=#d6b656;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (node.nodeType === "queue_topic") {
    return `${common.join(";")};ellipse=1;fillColor=#f8cecc;strokeColor=#b85450;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (node.nodeType === "job" || node.nodeType === "worker") {
    return `${common.join(";")};rounded=1;fillColor=#e1d5e7;strokeColor=#9673a6;strokeWidth=${node.isEntry ? 3 : 2};`;
  }
  if (node.isExternal) {
    return `${common.join(";")};rounded=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;strokeWidth=${node.isEntry ? 3 : 1};`;
  }
  return `${common.join(";")};rounded=1;fillColor=#f5f5f5;strokeColor=#666666;strokeWidth=${node.isEntry ? 3 : 1};`;
}

function getEdgeStyle(edge: WorkflowViewGraphEdge): string {
  const base = [
    "edgeStyle=orthogonalEdgeStyle",
    "rounded=0",
    "orthogonalLoop=1",
    "jettySize=auto",
    "html=1",
    "endArrow=block",
    "endFill=1",
    "fontSize=11",
  ];
  if (edge.edgeType === "invokes_http") {
    return `${base.join(";")};strokeColor=#1f78b4;`;
  }
  if (edge.edgeType === "queries") {
    return `${base.join(";")};strokeColor=#2e7d32;`;
  }
  if (
    edge.edgeType.includes("queue") ||
    edge.edgeType.includes("publish") ||
    edge.edgeType.includes("consume")
  ) {
    return `${base.join(";")};strokeColor=#ef6c00;dashed=1;`;
  }
  return `${base.join(";")};strokeColor=#666666;`;
}

function buildGroupLayouts(
  model: WorkflowViewGraphModel,
): readonly GroupLayout[] {
  const layouts: GroupLayout[] = [];
  let currentX = DIAGRAM_MARGIN_X;
  let currentY =
    DIAGRAM_MARGIN_Y + DIAGRAM_SUMMARY_HEIGHT + DIAGRAM_GROUP_GAP_Y;
  let rowColumn = 0;
  let rowMaxHeight = 0;

  for (const group of model.groups) {
    const groupNodes = model.nodes.filter(
      (node) => node.groupKey === group.groupKey,
    );
    const nodeCount = Math.max(groupNodes.length, 1);
    const height =
      DIAGRAM_GROUP_HEADER_HEIGHT +
      DIAGRAM_GROUP_PADDING_Y * 2 +
      nodeCount * DIAGRAM_NODE_HEIGHT +
      Math.max(groupNodes.length - 1, 0) * DIAGRAM_NODE_GAP_Y;

    if (rowColumn === DIAGRAM_GROUPS_PER_ROW) {
      currentX = DIAGRAM_MARGIN_X;
      currentY += rowMaxHeight + DIAGRAM_GROUP_GAP_Y;
      rowColumn = 0;
      rowMaxHeight = 0;
    }

    layouts.push(
      Object.freeze({
        group,
        nodes: Object.freeze(groupNodes),
        x: currentX,
        y: currentY,
        width: DIAGRAM_GROUP_WIDTH,
        height,
      }),
    );

    currentX += DIAGRAM_GROUP_WIDTH + DIAGRAM_GROUP_GAP_X;
    rowMaxHeight = Math.max(rowMaxHeight, height);
    rowColumn += 1;
  }

  return Object.freeze(layouts);
}

/**
 * Exports a workflow graph view model to editable Draw.io XML.
 */
export function exportViewGraphToDrawioXml(
  model: WorkflowViewGraphModel,
): string {
  const nowIso = new Date().toISOString();
  const layouts = buildGroupLayouts(model);
  const nodeCellIds = new Map<string, string>();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mxfile host="app.diagrams.net" modified="${escapeXml(nowIso)}" agent="Galaxy Code" version="26.0.11">`,
    `  <diagram id="workflow-view-1" name="${escapeXml(model.graphTitle.slice(0, 80) || "Workflow View")}">`,
    '    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">',
    "      <root>",
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
  ];

  const summaryWidth = Math.max(
    DIAGRAM_GROUP_WIDTH,
    layouts.reduce(
      (maxWidth, layout) => Math.max(maxWidth, layout.x + layout.width),
      DIAGRAM_MARGIN_X + DIAGRAM_GROUP_WIDTH,
    ) - DIAGRAM_MARGIN_X,
  );
  lines.push(
    `        <mxCell id="summary_1" value="${buildSummaryValue(model)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f8f9fa;strokeColor=#c0c0c0;fontSize=12;align=left;verticalAlign=middle;spacing=12;" vertex="1" parent="1">`,
  );
  lines.push(
    `          <mxGeometry x="${DIAGRAM_MARGIN_X}" y="${DIAGRAM_MARGIN_Y}" width="${summaryWidth}" height="${DIAGRAM_SUMMARY_HEIGHT}" as="geometry" />`,
  );
  lines.push("        </mxCell>");

  layouts.forEach((layout, layoutIndex) => {
    const groupCellId = sanitizeCellId(
      "group",
      layout.group.groupKey,
      layoutIndex,
    );
    const colors = getGroupColors(layout.group);
    lines.push(
      `        <mxCell id="${groupCellId}" value="${escapeXml(layout.group.title)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${colors.fill};strokeColor=${colors.stroke};fontStyle=1;align=left;verticalAlign=top;spacingLeft=14;spacingTop=10;dashed=${layout.group.kind === "external" ? 1 : 0};" vertex="1" parent="1">`,
    );
    lines.push(
      `          <mxGeometry x="${layout.x}" y="${layout.y}" width="${layout.width}" height="${layout.height}" as="geometry" />`,
    );
    lines.push("        </mxCell>");

    layout.nodes.forEach((node, nodeIndex) => {
      const nodeCellId = sanitizeCellId("node", node.id, nodeIndex);
      nodeCellIds.set(node.id, nodeCellId);
      const nodeX = layout.x + DIAGRAM_GROUP_PADDING_X;
      const nodeY =
        layout.y +
        DIAGRAM_GROUP_HEADER_HEIGHT +
        DIAGRAM_GROUP_PADDING_Y +
        nodeIndex * (DIAGRAM_NODE_HEIGHT + DIAGRAM_NODE_GAP_Y);
      const nodeWidth = layout.width - DIAGRAM_GROUP_PADDING_X * 2;
      lines.push(
        `        <mxCell id="${nodeCellId}" value="${formatNodeValue(node)}" style="${getNodeStyle(node)}" vertex="1" parent="1">`,
      );
      lines.push(
        `          <mxGeometry x="${nodeX}" y="${nodeY}" width="${nodeWidth}" height="${DIAGRAM_NODE_HEIGHT}" as="geometry" />`,
      );
      lines.push("        </mxCell>");
    });
  });

  model.edges.forEach((edge, edgeIndex) => {
    const sourceId = nodeCellIds.get(edge.fromNodeId);
    const targetId = nodeCellIds.get(edge.toNodeId);
    if (!sourceId || !targetId) {
      return;
    }
    const edgeCellId = sanitizeCellId("edge", edge.id, edgeIndex);
    const edgeValue = escapeXml(edge.label || edge.edgeType.replace(/_/g, " "));
    lines.push(
      `        <mxCell id="${edgeCellId}" value="${edgeValue}" style="${getEdgeStyle(edge)}" edge="1" parent="1" source="${sourceId}" target="${targetId}">`,
    );
    lines.push('          <mxGeometry relative="1" as="geometry" />');
    lines.push("        </mxCell>");
  });

  lines.push("      </root>");
  lines.push("    </mxGraphModel>");
  lines.push("  </diagram>");
  lines.push("</mxfile>");
  lines.push("");
  return lines.join("\n");
}
