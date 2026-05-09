/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Shared scope-resolution helpers for workflow graph explorer and diagram export flows.
 */

import { queryWorkflowGraph } from "../query/index";
import {
  buildViewGraphModelFromEntryNode,
  buildViewGraphModelFromFile,
  buildViewGraphModelFromRoute,
} from "./composer";
import type {
  WorkflowViewGraphComposeOptions,
  WorkflowViewGraphModel,
} from "./model";

export type WorkflowViewResolvedScope = Readonly<
  | {
      kind: "entry_node";
      value: string;
    }
  | {
      kind: "route";
      value: string;
    }
  | {
      kind: "file";
      value: string;
    }
  | {
      kind: "query";
      value: string;
      entryNodeId: string;
    }
>;

export type WorkflowViewResolveInput = Readonly<{
  entryNodeId?: string;
  routePath?: string;
  filePath?: string;
  query?: string;
  maxHops?: number;
  maxNodes?: number;
  includeIncoming?: boolean;
  includeExternal?: boolean;
}>;

function trimString(value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkflowViewComposeOptions(
  options?: WorkflowViewResolveInput,
): WorkflowViewGraphComposeOptions {
  return Object.freeze({
    ...(typeof options?.maxHops === "number" && Number.isFinite(options.maxHops)
      ? { maxHops: options.maxHops }
      : {}),
    ...(typeof options?.maxNodes === "number" &&
    Number.isFinite(options.maxNodes)
      ? { maxNodes: options.maxNodes }
      : {}),
    ...(typeof options?.includeIncoming === "boolean"
      ? { includeIncoming: options.includeIncoming }
      : {}),
    ...(typeof options?.includeExternal === "boolean"
      ? { includeExternal: options.includeExternal }
      : {}),
  });
}

function resolveWorkflowViewScopeFromQuery(
  workspaceRoot: string,
  queryText: string,
): WorkflowViewResolvedScope {
  const queryResult = queryWorkflowGraph(workspaceRoot, queryText, 5);
  const candidates: Array<Readonly<{ entryNodeId: string; score: number }>> =
    [];

  for (const nodeMatch of queryResult.nodes) {
    candidates.push(
      Object.freeze({
        entryNodeId: nodeMatch.node.id,
        score: nodeMatch.score + 1,
      }),
    );
  }
  for (const mapMatch of queryResult.maps) {
    if (mapMatch.map.entryNodeId) {
      candidates.push(
        Object.freeze({
          entryNodeId: mapMatch.map.entryNodeId,
          score: mapMatch.score,
        }),
      );
    }
  }
  for (const traceMatch of queryResult.traces) {
    if (traceMatch.trace.entryNodeId) {
      candidates.push(
        Object.freeze({
          entryNodeId: traceMatch.trace.entryNodeId,
          score: traceMatch.score,
        }),
      );
    }
  }

  const best = [...candidates].sort(
    (left, right) => right.score - left.score,
  )[0];
  if (!best) {
    throw new Error(
      `No workflow graph entry could be resolved from query: ${queryText}`,
    );
  }

  return Object.freeze({
    kind: "query",
    value: queryText,
    entryNodeId: best.entryNodeId,
  });
}

export function resolveWorkflowViewScope(
  workspaceRoot: string,
  options: WorkflowViewResolveInput,
): WorkflowViewResolvedScope {
  const entryNodeId = trimString(options.entryNodeId);
  if (entryNodeId) {
    return Object.freeze({ kind: "entry_node", value: entryNodeId });
  }

  const routePath = trimString(options.routePath);
  if (routePath) {
    return Object.freeze({ kind: "route", value: routePath });
  }

  const filePath = trimString(options.filePath);
  if (filePath) {
    return Object.freeze({ kind: "file", value: filePath });
  }

  const queryText = trimString(options.query);
  if (queryText) {
    return resolveWorkflowViewScopeFromQuery(workspaceRoot, queryText);
  }

  throw new Error(
    "A workflow graph scope is required. Provide entryNodeId, routePath, filePath, or query.",
  );
}

export function buildViewGraphModelFromResolvedScope(
  workspaceRoot: string,
  scope: WorkflowViewResolvedScope,
  composeOptions?: WorkflowViewGraphComposeOptions,
): WorkflowViewGraphModel {
  switch (scope.kind) {
    case "entry_node":
      return buildViewGraphModelFromEntryNode(workspaceRoot, {
        entryNodeId: scope.value,
        ...composeOptions,
      });
    case "route":
      return buildViewGraphModelFromRoute(
        workspaceRoot,
        scope.value,
        composeOptions,
      );
    case "file":
      return buildViewGraphModelFromFile(
        workspaceRoot,
        scope.value,
        composeOptions,
      );
    case "query":
      return buildViewGraphModelFromEntryNode(workspaceRoot, {
        entryNodeId: scope.entryNodeId,
        ...composeOptions,
      });
  }
}

export function resolveWorkflowViewGraphModel(
  workspaceRoot: string,
  options: WorkflowViewResolveInput,
): Readonly<{
  scope: WorkflowViewResolvedScope;
  model: WorkflowViewGraphModel;
}> {
  const scope = resolveWorkflowViewScope(workspaceRoot, options);
  const composeOptions = buildWorkflowViewComposeOptions(options);
  return Object.freeze({
    scope,
    model: buildViewGraphModelFromResolvedScope(
      workspaceRoot,
      scope,
      composeOptions,
    ),
  });
}

export function describeWorkflowViewScope(
  scope: WorkflowViewResolvedScope,
): string {
  switch (scope.kind) {
    case "query":
      return `query \"${scope.value}\"`;
    case "route":
      return `route ${scope.value}`;
    case "file":
      return scope.value;
    case "entry_node":
      return scope.value;
  }
}
