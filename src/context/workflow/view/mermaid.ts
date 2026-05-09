/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Mermaid export helpers for workflow graph view models.
 */

import type { WorkflowViewGraphModel, WorkflowViewGraphNode } from "./model";

function escapeMermaidText(value: string): string {
  return String(value ?? "")
    .replace(/"/g, "'")
    .replace(/\|/g, "/")
    .replace(/\r?\n/g, " ")
    .trim();
}

function sanitizeMermaidId(
  prefix: string,
  value: string,
  index: number,
): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix}_${normalized || "item"}_${index + 1}`;
}

function formatNodeLabel(node: WorkflowViewGraphNode): string {
  const detail =
    (node.routeMethod && node.routePath
      ? `${node.routeMethod} ${node.routePath}`
      : node.symbolName || node.nodeType) ?? node.nodeType;
  if (detail === node.label) {
    return escapeMermaidText(node.label);
  }
  return escapeMermaidText(`${node.label}<br/>${detail}`);
}

/**
 * Exports a workflow graph view model to Mermaid flowchart syntax.
 */
export function exportViewGraphToMermaid(
  model: WorkflowViewGraphModel,
): string {
  const nodeIds = new Map<string, string>();
  const groupIds = new Map<string, string>();

  model.nodes.forEach((node, index) => {
    nodeIds.set(node.id, sanitizeMermaidId("node", node.id, index));
  });
  model.groups.forEach((group, index) => {
    groupIds.set(
      group.groupKey,
      sanitizeMermaidId("group", group.groupKey, index),
    );
  });

  const lines: string[] = [
    `%% ${escapeMermaidText(model.graphTitle)}`,
    `%% ${escapeMermaidText(model.graphSummary)}`,
    "flowchart LR",
  ];

  const groupedNodes = new Set<string>();
  for (const group of model.groups) {
    const groupNodeIds = group.nodeIds.filter((nodeId) => nodeIds.has(nodeId));
    if (groupNodeIds.length === 0) {
      continue;
    }
    lines.push(
      `  subgraph ${groupIds.get(group.groupKey)}["${escapeMermaidText(group.title)}"]`,
    );
    for (const nodeId of groupNodeIds) {
      const graphNode = model.nodes.find(
        (candidate) => candidate.id === nodeId,
      );
      if (!graphNode) {
        continue;
      }
      groupedNodes.add(nodeId);
      lines.push(`    ${nodeIds.get(nodeId)}["${formatNodeLabel(graphNode)}"]`);
    }
    lines.push("  end");
  }

  for (const node of model.nodes) {
    if (groupedNodes.has(node.id)) {
      continue;
    }
    lines.push(`  ${nodeIds.get(node.id)}["${formatNodeLabel(node)}"]`);
  }

  for (const edge of model.edges) {
    const fromId = nodeIds.get(edge.fromNodeId);
    const toId = nodeIds.get(edge.toNodeId);
    if (!fromId || !toId) {
      continue;
    }
    const edgeLabel = escapeMermaidText(
      edge.label || edge.edgeType.replace(/_/g, " "),
    );
    lines.push(`  ${fromId} -->|${edgeLabel}| ${toId}`);
  }

  return `${lines.join("\n")}\n`;
}
