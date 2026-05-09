import fs from "node:fs";
import path from "node:path";
import {
  mapWorkflowEdgeRow,
  mapWorkflowMapRow,
  mapWorkflowNodeRow,
  mapWorkflowTraceRow,
  sortWorkflowScoredResults,
  tokenizeWorkflowQuery,
} from "../graph-helpers";
import type {
  WorkflowGraphQueryResult,
  WorkflowSubgraphResult,
} from "../entities";
import {
  ensureProjectStorage,
  getProjectStorageInfo,
} from "../../project-store";
import {
  buildWorkflowProjectionPayload,
  type WorkflowProjectionRelationship,
  type WorkflowProjectionPayload,
} from "./payload";

export type KuzuWorkflowProjectionConfig = Readonly<{
  enabled: boolean;
  databasePath: string;
}>;

export type KuzuWorkflowProjectionStats = Readonly<{
  nodeCount: number;
  relationshipCount: number;
  schemaStatementCount: number;
  mergeStatementCount: number;
  cleanupStatementCount: number;
}>;

type KuzuPreparedStatement = Readonly<{
  isSuccess?: () => boolean;
  getErrorMessage?: () => string;
}>;

type KuzuQueryResult = Readonly<{
  close?: () => void;
  getAllSync?: () => readonly Readonly<Record<string, unknown>>[];
}>;

type KuzuConnection = Readonly<{
  querySync: (
    statement: string,
  ) => KuzuQueryResult | readonly KuzuQueryResult[];
  prepareSync: (statement: string) => KuzuPreparedStatement;
  executeSync: (
    preparedStatement: KuzuPreparedStatement,
    params?: Readonly<Record<string, unknown>>,
  ) => KuzuQueryResult | readonly KuzuQueryResult[];
  closeSync: () => void;
}>;

type KuzuDatabase = Readonly<{
  closeSync: () => void;
}>;

type KuzuModule = Readonly<{
  Database: new (databasePath?: string) => KuzuDatabase;
  Connection: new (
    database: KuzuDatabase,
    numThreads?: number,
  ) => KuzuConnection;
}>;

type KuzuProjectionSnapshot = Readonly<{
  nodes: readonly ReturnType<typeof mapWorkflowNodeRow>[];
  edges: readonly ReturnType<typeof mapWorkflowEdgeRow>[];
  maps: readonly ReturnType<typeof mapWorkflowMapRow>[];
  traces: readonly ReturnType<typeof mapWorkflowTraceRow>[];
}>;

const KUZU_SCHEMA_STATEMENTS = Object.freeze([
  [
    "CREATE NODE TABLE IF NOT EXISTS FlowNode(",
    "  id STRING,",
    "  sourceId STRING,",
    "  workspaceId STRING,",
    "  sourceOrdinal INT64,",
    "  nodeType STRING,",
    "  label STRING,",
    "  filePath STRING,",
    "  symbolName STRING,",
    "  routeMethod STRING,",
    "  routePath STRING,",
    "  startLine INT64,",
    "  endLine INT64,",
    "  description STRING,",
    "  descriptionSource STRING,",
    "  confidence DOUBLE,",
    "  sourceHash STRING,",
    "  createdAt INT64,",
    "  updatedAt INT64,",
    "  PRIMARY KEY(id)",
    ");",
  ].join("\n"),
  [
    "CREATE NODE TABLE IF NOT EXISTS WorkflowMap(",
    "  id STRING,",
    "  sourceId STRING,",
    "  workspaceId STRING,",
    "  sourceOrdinal INT64,",
    "  mapType STRING,",
    "  entryNodeId STRING,",
    "  title STRING,",
    "  summaryPreview STRING,",
    "  confidence DOUBLE,",
    "  sourceHash STRING,",
    "  generatedAt INT64,",
    "  updatedAt INT64,",
    "  PRIMARY KEY(id)",
    ");",
  ].join("\n"),
  [
    "CREATE NODE TABLE IF NOT EXISTS TraceSummary(",
    "  id STRING,",
    "  sourceId STRING,",
    "  workspaceId STRING,",
    "  sourceOrdinal INT64,",
    "  traceKind STRING,",
    "  entryNodeId STRING,",
    "  title STRING,",
    "  queryHint STRING,",
    "  narrativePreview STRING,",
    "  confidence DOUBLE,",
    "  sourceHash STRING,",
    "  generatedAt INT64,",
    "  updatedAt INT64,",
    "  PRIMARY KEY(id)",
    ");",
  ].join("\n"),
  [
    "CREATE REL TABLE IF NOT EXISTS WORKFLOW_EDGE(",
    "  FROM FlowNode TO FlowNode,",
    "  id STRING,",
    "  sourceId STRING,",
    "  workspaceId STRING,",
    "  sourceOrdinal INT64,",
    "  edgeType STRING,",
    "  label STRING,",
    "  confidence DOUBLE,",
    "  supportingFilePath STRING,",
    "  supportingSymbolName STRING,",
    "  supportingLine INT64,",
    "  sourceHash STRING,",
    "  createdAt INT64,",
    "  updatedAt INT64",
    ");",
  ].join("\n"),
]);

const KUZU_INSERT_FLOW_NODE = [
  "CREATE (:FlowNode {",
  "  id: $id,",
  "  sourceId: $sourceId,",
  "  workspaceId: $workspaceId,",
  "  sourceOrdinal: $sourceOrdinal,",
  "  nodeType: $nodeType,",
  "  label: $label,",
  "  filePath: $filePath,",
  "  symbolName: $symbolName,",
  "  routeMethod: $routeMethod,",
  "  routePath: $routePath,",
  "  startLine: $startLine,",
  "  endLine: $endLine,",
  "  description: $description,",
  "  descriptionSource: $descriptionSource,",
  "  confidence: $confidence,",
  "  sourceHash: $sourceHash,",
  "  createdAt: $createdAt,",
  "  updatedAt: $updatedAt",
  "});",
].join("\n");

const KUZU_INSERT_WORKFLOW_MAP = [
  "CREATE (:WorkflowMap {",
  "  id: $id,",
  "  sourceId: $sourceId,",
  "  workspaceId: $workspaceId,",
  "  sourceOrdinal: $sourceOrdinal,",
  "  mapType: $mapType,",
  "  entryNodeId: $entryNodeId,",
  "  title: $title,",
  "  summaryPreview: $summaryPreview,",
  "  confidence: $confidence,",
  "  sourceHash: $sourceHash,",
  "  generatedAt: $generatedAt,",
  "  updatedAt: $updatedAt",
  "});",
].join("\n");

const KUZU_INSERT_TRACE_SUMMARY = [
  "CREATE (:TraceSummary {",
  "  id: $id,",
  "  sourceId: $sourceId,",
  "  workspaceId: $workspaceId,",
  "  sourceOrdinal: $sourceOrdinal,",
  "  traceKind: $traceKind,",
  "  entryNodeId: $entryNodeId,",
  "  title: $title,",
  "  queryHint: $queryHint,",
  "  narrativePreview: $narrativePreview,",
  "  confidence: $confidence,",
  "  sourceHash: $sourceHash,",
  "  generatedAt: $generatedAt,",
  "  updatedAt: $updatedAt",
  "});",
].join("\n");

const KUZU_INSERT_WORKFLOW_EDGE = [
  "MATCH (from:FlowNode {id: $fromId}), (to:FlowNode {id: $toId})",
  "CREATE (from)-[:WORKFLOW_EDGE {",
  "  id: $id,",
  "  sourceId: $sourceId,",
  "  workspaceId: $workspaceId,",
  "  sourceOrdinal: $sourceOrdinal,",
  "  edgeType: $edgeType,",
  "  label: $label,",
  "  confidence: $confidence,",
  "  supportingFilePath: $supportingFilePath,",
  "  supportingSymbolName: $supportingSymbolName,",
  "  supportingLine: $supportingLine,",
  "  sourceHash: $sourceHash,",
  "  createdAt: $createdAt,",
  "  updatedAt: $updatedAt",
  "}]->(to);",
].join("\n");

function normalizeEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function loadKuzuModule(): KuzuModule | null {
  try {
    const loaded = require("kuzu") as KuzuModule & { default?: KuzuModule };
    if (typeof loaded.Database === "function") {
      return loaded;
    }
    if (loaded.default && typeof loaded.default.Database === "function") {
      return loaded.default;
    }
    return null;
  } catch {
    return null;
  }
}

function closeKuzuResult(result: unknown): void {
  if (Array.isArray(result)) {
    for (const entry of result) {
      closeKuzuResult(entry);
    }
    return;
  }
  if (
    result &&
    typeof result === "object" &&
    typeof (result as { close?: unknown }).close === "function"
  ) {
    try {
      (result as { close: () => void }).close();
    } catch {
      // Ignore close errors for best-effort cleanup.
    }
  }
}

function normalizeKuzuScalar(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => normalizeKuzuScalar(entry)));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          normalizeKuzuScalar(entry),
        ]),
      ),
    );
  }
  return value;
}

function readKuzuRows(
  connection: KuzuConnection,
  statement: string,
): readonly Readonly<Record<string, unknown>>[] {
  const result = connection.querySync(statement);
  try {
    const results = Array.isArray(result) ? result : [result];
    const rows: Readonly<Record<string, unknown>>[] = [];
    for (const entry of results) {
      if (typeof entry.getAllSync !== "function") {
        continue;
      }
      for (const row of entry.getAllSync()) {
        rows.push(
          normalizeKuzuScalar(row) as Readonly<Record<string, unknown>>,
        );
      }
    }
    return Object.freeze(rows);
  } finally {
    closeKuzuResult(result);
  }
}

function normalizeKuzuParams(
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        value === undefined ? null : value,
      ]),
    ),
  );
}

function prepareRequired(
  connection: KuzuConnection,
  statement: string,
): KuzuPreparedStatement {
  const prepared = connection.prepareSync(statement);
  if (typeof prepared.isSuccess === "function" && !prepared.isSuccess()) {
    throw new Error(
      prepared.getErrorMessage?.() ?? "Failed to prepare Kuzu statement.",
    );
  }
  return prepared;
}

function executePreparedSync(
  connection: KuzuConnection,
  prepared: KuzuPreparedStatement,
  params: Readonly<Record<string, unknown>>,
): void {
  closeKuzuResult(
    connection.executeSync(prepared, normalizeKuzuParams(params)),
  );
}

function runStatementSync(connection: KuzuConnection, statement: string): void {
  closeKuzuResult(connection.querySync(statement));
}

function getProjectionNodes(
  payload: WorkflowProjectionPayload,
  label: string,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    payload.nodes
      .filter((node) => node.labels.includes(label))
      .map((node) => node.properties),
  );
}

function getProjectionRelationships(
  payload: WorkflowProjectionPayload,
  type: string,
): readonly WorkflowProjectionRelationship[] {
  return Object.freeze(
    payload.relationships.filter((relationship) => relationship.type === type),
  );
}

function dedupeProjectionRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  const rowsById = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of rows) {
    const id = String(row["id"] ?? "");
    if (!id) {
      continue;
    }
    rowsById.set(id, row);
  }
  return Object.freeze([...rowsById.values()]);
}

function dedupeProjectionRelationships(
  relationships: readonly WorkflowProjectionRelationship[],
): readonly WorkflowProjectionRelationship[] {
  const relationshipsById = new Map<string, WorkflowProjectionRelationship>();
  for (const relationship of relationships) {
    if (!relationship.id) {
      continue;
    }
    relationshipsById.set(relationship.id, relationship);
  }
  return Object.freeze([...relationshipsById.values()]);
}

function closeKuzuHandles(
  connection: KuzuConnection | null,
  database: KuzuDatabase | null,
): void {
  try {
    connection?.closeSync();
  } catch {
    // Ignore close errors for best-effort cleanup.
  }
  try {
    database?.closeSync();
  } catch {
    // Ignore close errors for best-effort cleanup.
  }
}

function unwrapProjectionSourceId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const separatorIndex = value.indexOf(":");
  return separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
}

function mapKuzuWorkflowNodeProjection(
  row: Readonly<Record<string, unknown>>,
): ReturnType<typeof mapWorkflowNodeRow> {
  return mapWorkflowNodeRow({
    id: String(row["sourceId"] ?? row["id"] ?? ""),
    node_type: String(row["nodeType"] ?? "unknown"),
    label: String(row["label"] ?? row["sourceId"] ?? ""),
    file_path: typeof row["filePath"] === "string" ? row["filePath"] : null,
    symbol_name:
      typeof row["symbolName"] === "string" ? row["symbolName"] : null,
    route_method:
      typeof row["routeMethod"] === "string" ? row["routeMethod"] : null,
    route_path: typeof row["routePath"] === "string" ? row["routePath"] : null,
    start_line: typeof row["startLine"] === "number" ? row["startLine"] : null,
    end_line: typeof row["endLine"] === "number" ? row["endLine"] : null,
    description:
      typeof row["description"] === "string" ? row["description"] : null,
    description_source:
      typeof row["descriptionSource"] === "string"
        ? row["descriptionSource"]
        : null,
    confidence:
      typeof row["confidence"] === "number" ? row["confidence"] : 0.85,
    provenance_json: null,
    source_hash:
      typeof row["sourceHash"] === "string" ? row["sourceHash"] : null,
    created_at:
      typeof row["createdAt"] === "number" ? row["createdAt"] : Date.now(),
    updated_at:
      typeof row["updatedAt"] === "number"
        ? row["updatedAt"]
        : typeof row["createdAt"] === "number"
          ? row["createdAt"]
          : Date.now(),
  });
}

function mapKuzuWorkflowEdgeProjection(
  row: Readonly<Record<string, unknown>>,
): ReturnType<typeof mapWorkflowEdgeRow> {
  return mapWorkflowEdgeRow({
    id: String(row["sourceId"] ?? row["id"] ?? ""),
    from_node_id: String(row["fromNodeId"] ?? ""),
    to_node_id: String(row["toNodeId"] ?? ""),
    edge_type: String(row["edgeType"] ?? "depends_on"),
    label: typeof row["label"] === "string" ? row["label"] : null,
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : 0.8,
    provenance_json: null,
    supporting_file_path:
      typeof row["supportingFilePath"] === "string"
        ? row["supportingFilePath"]
        : null,
    supporting_symbol_name:
      typeof row["supportingSymbolName"] === "string"
        ? row["supportingSymbolName"]
        : null,
    supporting_line:
      typeof row["supportingLine"] === "number" ? row["supportingLine"] : null,
    source_hash:
      typeof row["sourceHash"] === "string" ? row["sourceHash"] : null,
    created_at:
      typeof row["createdAt"] === "number" ? row["createdAt"] : Date.now(),
    updated_at:
      typeof row["updatedAt"] === "number"
        ? row["updatedAt"]
        : typeof row["createdAt"] === "number"
          ? row["createdAt"]
          : Date.now(),
  });
}

function mapKuzuWorkflowMapProjection(
  row: Readonly<Record<string, unknown>>,
  sourceIdByProjectionId: ReadonlyMap<string, string>,
): ReturnType<typeof mapWorkflowMapRow> {
  const entryNodeProjectionId =
    typeof row["entryNodeProjectionId"] === "string"
      ? row["entryNodeProjectionId"]
      : null;
  const entryNodeSourceId = entryNodeProjectionId
    ? (sourceIdByProjectionId.get(entryNodeProjectionId) ??
      unwrapProjectionSourceId(entryNodeProjectionId))
    : null;
  return mapWorkflowMapRow({
    id: String(row["sourceId"] ?? row["id"] ?? ""),
    map_type: String(row["mapType"] ?? "workflow_map"),
    entry_node_id: entryNodeSourceId,
    title: String(row["title"] ?? row["sourceId"] ?? ""),
    summary:
      typeof row["summaryPreview"] === "string" ? row["summaryPreview"] : "",
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : 0.8,
    source_hash:
      typeof row["sourceHash"] === "string" ? row["sourceHash"] : null,
    generated_at:
      typeof row["generatedAt"] === "number" ? row["generatedAt"] : Date.now(),
    updated_at:
      typeof row["updatedAt"] === "number"
        ? row["updatedAt"]
        : typeof row["generatedAt"] === "number"
          ? row["generatedAt"]
          : Date.now(),
  });
}

function mapKuzuWorkflowTraceProjection(
  row: Readonly<Record<string, unknown>>,
  sourceIdByProjectionId: ReadonlyMap<string, string>,
): ReturnType<typeof mapWorkflowTraceRow> {
  const entryNodeProjectionId =
    typeof row["entryNodeProjectionId"] === "string"
      ? row["entryNodeProjectionId"]
      : null;
  const entryNodeSourceId = entryNodeProjectionId
    ? (sourceIdByProjectionId.get(entryNodeProjectionId) ??
      unwrapProjectionSourceId(entryNodeProjectionId))
    : null;
  return mapWorkflowTraceRow({
    id: String(row["sourceId"] ?? row["id"] ?? ""),
    trace_kind: String(row["traceKind"] ?? "workflow_trace"),
    entry_node_id: entryNodeSourceId,
    title: String(row["title"] ?? row["sourceId"] ?? ""),
    query_hint: typeof row["queryHint"] === "string" ? row["queryHint"] : null,
    narrative:
      typeof row["narrativePreview"] === "string"
        ? row["narrativePreview"]
        : "",
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : 0.8,
    source_hash:
      typeof row["sourceHash"] === "string" ? row["sourceHash"] : null,
    generated_at:
      typeof row["generatedAt"] === "number" ? row["generatedAt"] : Date.now(),
    updated_at:
      typeof row["updatedAt"] === "number"
        ? row["updatedAt"]
        : typeof row["generatedAt"] === "number"
          ? row["generatedAt"]
          : Date.now(),
  });
}

function loadKuzuProjectionSnapshot(
  workspacePath: string,
): KuzuProjectionSnapshot | null {
  const config = readKuzuWorkflowProjectionConfig(workspacePath);
  if (
    !hasActiveKuzuWorkflowProjection(config) ||
    !fs.existsSync(config.databasePath)
  ) {
    return null;
  }

  const kuzu = loadKuzuModule();
  if (!kuzu) {
    return null;
  }

  let database: KuzuDatabase | null = null;
  let connection: KuzuConnection | null = null;
  try {
    database = new kuzu.Database(config.databasePath);
    connection = new kuzu.Connection(database);

    const nodeRows = readKuzuRows(
      connection,
      [
        "MATCH (node:FlowNode)",
        "RETURN node.id AS id, node.sourceId AS sourceId, node.sourceOrdinal AS sourceOrdinal, node.nodeType AS nodeType, node.label AS label, node.filePath AS filePath, node.symbolName AS symbolName, node.routeMethod AS routeMethod, node.routePath AS routePath, node.startLine AS startLine, node.endLine AS endLine, node.description AS description, node.descriptionSource AS descriptionSource, node.confidence AS confidence, node.sourceHash AS sourceHash, node.createdAt AS createdAt, node.updatedAt AS updatedAt",
        "ORDER BY node.sourceOrdinal, node.id",
      ].join("\n"),
    );
    const nodeSourceIdByProjectionId = new Map(
      nodeRows.map(
        (row) =>
          [
            String(row["id"] ?? ""),
            String(row["sourceId"] ?? row["id"] ?? ""),
          ] as const,
      ),
    );

    return Object.freeze({
      nodes: Object.freeze(
        nodeRows.map((row) => mapKuzuWorkflowNodeProjection(row)),
      ),
      edges: Object.freeze(
        readKuzuRows(
          connection,
          [
            "MATCH (from:FlowNode)-[rel:WORKFLOW_EDGE]->(to:FlowNode)",
            "RETURN rel.id AS id, rel.sourceId AS sourceId, rel.sourceOrdinal AS sourceOrdinal, from.sourceId AS fromNodeId, to.sourceId AS toNodeId, rel.edgeType AS edgeType, rel.label AS label, rel.confidence AS confidence, rel.supportingFilePath AS supportingFilePath, rel.supportingSymbolName AS supportingSymbolName, rel.supportingLine AS supportingLine, rel.sourceHash AS sourceHash, rel.createdAt AS createdAt, rel.updatedAt AS updatedAt",
            "ORDER BY rel.sourceOrdinal, rel.id",
          ].join("\n"),
        ).map((row) => mapKuzuWorkflowEdgeProjection(row)),
      ),
      maps: Object.freeze(
        readKuzuRows(
          connection,
          [
            "MATCH (map:WorkflowMap)",
            "RETURN map.id AS id, map.sourceId AS sourceId, map.sourceOrdinal AS sourceOrdinal, map.mapType AS mapType, map.entryNodeId AS entryNodeProjectionId, map.title AS title, map.summaryPreview AS summaryPreview, map.confidence AS confidence, map.sourceHash AS sourceHash, map.generatedAt AS generatedAt, map.updatedAt AS updatedAt",
            "ORDER BY map.sourceOrdinal, map.id",
          ].join("\n"),
        ).map((row) =>
          mapKuzuWorkflowMapProjection(row, nodeSourceIdByProjectionId),
        ),
      ),
      traces: Object.freeze(
        readKuzuRows(
          connection,
          [
            "MATCH (trace:TraceSummary)",
            "RETURN trace.id AS id, trace.sourceId AS sourceId, trace.sourceOrdinal AS sourceOrdinal, trace.traceKind AS traceKind, trace.entryNodeId AS entryNodeProjectionId, trace.title AS title, trace.queryHint AS queryHint, trace.narrativePreview AS narrativePreview, trace.confidence AS confidence, trace.sourceHash AS sourceHash, trace.generatedAt AS generatedAt, trace.updatedAt AS updatedAt",
            "ORDER BY trace.sourceOrdinal, trace.id",
          ].join("\n"),
        ).map((row) =>
          mapKuzuWorkflowTraceProjection(row, nodeSourceIdByProjectionId),
        ),
      ),
    });
  } catch (error) {
    console.warn(
      `[galaxy] kuzu query failed for ${workspacePath}: ${String(error)}`,
    );
    return null;
  } finally {
    closeKuzuHandles(connection, database);
  }
}

export function buildKuzuWorkflowProjectionPath(workspacePath: string): string {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  return path.join(storage.projectDirPath, "workflow-graph.kuzu");
}

function buildKuzuWorkflowProjectionTempPath(databasePath: string): string {
  return `${databasePath}.tmp-${process.pid}-${Date.now()}`;
}

export function readKuzuWorkflowProjectionConfig(
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
): KuzuWorkflowProjectionConfig {
  const enabledOverride = env["GALAXY_KUZU_PROJECTOR_ENABLED"];
  return Object.freeze({
    enabled:
      enabledOverride === undefined ? true : normalizeEnvFlag(enabledOverride),
    databasePath:
      env["GALAXY_KUZU_DB_PATH"]?.trim() ||
      buildKuzuWorkflowProjectionPath(workspacePath),
  });
}

export function hasActiveKuzuWorkflowProjection(
  config: KuzuWorkflowProjectionConfig,
): boolean {
  return config.enabled;
}

export function projectWorkflowSnapshotToKuzu(workspacePath: string): boolean {
  const config = readKuzuWorkflowProjectionConfig(workspacePath);
  if (!hasActiveKuzuWorkflowProjection(config)) {
    return false;
  }

  const kuzu = loadKuzuModule();
  if (!kuzu) {
    return false;
  }

  const payload = buildWorkflowProjectionPayload(workspacePath);
  const flowNodes = dedupeProjectionRows(
    getProjectionNodes(payload, "FlowNode"),
  );
  const workflowMaps = dedupeProjectionRows(
    getProjectionNodes(payload, "WorkflowMap"),
  );
  const traceSummaries = dedupeProjectionRows(
    getProjectionNodes(payload, "TraceSummary"),
  );
  const workflowEdges = dedupeProjectionRelationships(
    getProjectionRelationships(payload, "WORKFLOW_EDGE"),
  );

  const tempDatabasePath = buildKuzuWorkflowProjectionTempPath(
    config.databasePath,
  );
  fs.rmSync(tempDatabasePath, { recursive: true, force: true });

  let database: KuzuDatabase | null = null;
  let connection: KuzuConnection | null = null;
  try {
    database = new kuzu.Database(tempDatabasePath);
    connection = new kuzu.Connection(database);

    for (const statement of KUZU_SCHEMA_STATEMENTS) {
      runStatementSync(connection, statement);
    }

    const createFlowNode = prepareRequired(connection, KUZU_INSERT_FLOW_NODE);
    const createWorkflowMap = prepareRequired(
      connection,
      KUZU_INSERT_WORKFLOW_MAP,
    );
    const createTraceSummary = prepareRequired(
      connection,
      KUZU_INSERT_TRACE_SUMMARY,
    );
    const createWorkflowEdge = prepareRequired(
      connection,
      KUZU_INSERT_WORKFLOW_EDGE,
    );

    for (const node of flowNodes) {
      executePreparedSync(connection, createFlowNode, node);
    }
    for (const map of workflowMaps) {
      executePreparedSync(connection, createWorkflowMap, map);
    }
    for (const trace of traceSummaries) {
      executePreparedSync(connection, createTraceSummary, trace);
    }
    for (const edge of workflowEdges) {
      executePreparedSync(connection, createWorkflowEdge, {
        fromId: edge.fromId,
        toId: edge.toId,
        ...edge.properties,
      });
    }

    closeKuzuHandles(connection, database);
    connection = null;
    database = null;
    fs.rmSync(config.databasePath, { recursive: true, force: true });
    fs.renameSync(tempDatabasePath, config.databasePath);

    return true;
  } catch (error) {
    console.warn(
      `[galaxy] kuzu projection failed for ${workspacePath}: ${String(error)}`,
    );
    return false;
  } finally {
    closeKuzuHandles(connection, database);
    fs.rmSync(tempDatabasePath, { recursive: true, force: true });
  }
}

export function clearWorkflowProjectionFromKuzu(
  workspacePath: string,
): boolean {
  const config = readKuzuWorkflowProjectionConfig(workspacePath);
  if (!hasActiveKuzuWorkflowProjection(config)) {
    return false;
  }
  fs.rmSync(config.databasePath, { recursive: true, force: true });
  return true;
}

export function queryWorkflowGraphFromKuzu(
  workspacePath: string,
  queryText: string,
  limit = 5,
): WorkflowGraphQueryResult | null {
  const snapshot = loadKuzuProjectionSnapshot(workspacePath);
  if (!snapshot) {
    return null;
  }

  const tokens = tokenizeWorkflowQuery(queryText);
  if (tokens.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      maps: Object.freeze([]),
      traces: Object.freeze([]),
    });
  }

  const boundedLimit = Math.max(1, Math.min(limit, 32));
  const nodeScores = new Map<string, number>();
  const mapScores = new Map<string, number>();
  const traceScores = new Map<string, number>();
  const nodeRows = new Map<string, ReturnType<typeof mapWorkflowNodeRow>>();
  const mapRows = new Map<string, ReturnType<typeof mapWorkflowMapRow>>();
  const traceRows = new Map<string, ReturnType<typeof mapWorkflowTraceRow>>();
  const bump = (
    scores: Map<string, number>,
    id: string,
    amount: number,
  ): void => {
    scores.set(id, (scores.get(id) ?? 0) + amount);
  };

  for (const token of tokens) {
    for (const node of snapshot.nodes
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(token) ||
          entry.symbolName?.toLowerCase().includes(token) ||
          entry.routePath?.toLowerCase().includes(token) ||
          entry.filePath?.toLowerCase().includes(token),
      )
      .slice(0, 32)) {
      nodeRows.set(node.id, node);
      const exactLabel = node.label.toLowerCase() === token;
      const exactSymbol = node.symbolName?.toLowerCase() === token;
      const exactRoute = node.routePath?.toLowerCase() === token;
      bump(
        nodeScores,
        node.id,
        exactLabel || exactSymbol ? 10 : exactRoute ? 9 : 4,
      );
    }
    for (const map of snapshot.maps
      .filter(
        (entry) =>
          entry.title.toLowerCase().includes(token) ||
          entry.summary.toLowerCase().includes(token),
      )
      .slice(0, 24)) {
      mapRows.set(map.id, map);
      bump(mapScores, map.id, map.title.toLowerCase() === token ? 9 : 4);
    }
    for (const trace of snapshot.traces
      .filter(
        (entry) =>
          entry.title.toLowerCase().includes(token) ||
          entry.narrative.toLowerCase().includes(token) ||
          entry.queryHint?.toLowerCase().includes(token),
      )
      .slice(0, 24)) {
      traceRows.set(trace.id, trace);
      bump(traceScores, trace.id, trace.title.toLowerCase() === token ? 8 : 3);
    }
  }

  return Object.freeze({
    nodes: Object.freeze(
      sortWorkflowScoredResults(
        nodeRows.entries(),
        nodeScores,
        boundedLimit,
      ).map(({ value, score }) => Object.freeze({ node: value, score })),
    ),
    maps: Object.freeze(
      sortWorkflowScoredResults(mapRows.entries(), mapScores, boundedLimit).map(
        ({ value, score }) => Object.freeze({ map: value, score }),
      ),
    ),
    traces: Object.freeze(
      sortWorkflowScoredResults(
        traceRows.entries(),
        traceScores,
        boundedLimit,
      ).map(({ value, score }) => Object.freeze({ trace: value, score })),
    ),
  });
}

export function queryWorkflowSubgraphFromKuzu(
  workspacePath: string,
  opts: Readonly<{
    entryNodeId: string;
    maxHops?: number;
    maxNodes?: number;
    includeIncoming?: boolean;
  }>,
): WorkflowSubgraphResult | null {
  const snapshot = loadKuzuProjectionSnapshot(workspacePath);
  if (!snapshot) {
    return null;
  }

  const maxHops = Math.max(1, Math.min(opts.maxHops ?? 2, 4));
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 24, 60));
  const includeIncoming = opts.includeIncoming ?? true;
  const nodeIds = new Set<string>([opts.entryNodeId]);
  const edgeMap = new Map<string, ReturnType<typeof mapWorkflowEdgeRow>>();
  let frontier = new Set<string>([opts.entryNodeId]);

  for (
    let hop = 0;
    hop < maxHops && frontier.size > 0 && nodeIds.size < maxNodes;
    hop += 1
  ) {
    const nextFrontier = new Set<string>();
    for (const nodeId of frontier) {
      for (const edge of snapshot.edges.filter(
        (entry) => entry.fromNodeId === nodeId || entry.toNodeId === nodeId,
      )) {
        const touchesIncoming = edge.toNodeId === nodeId;
        if (!includeIncoming && touchesIncoming) {
          continue;
        }
        edgeMap.set(edge.id, edge);
        if (nodeIds.size < maxNodes) {
          if (!nodeIds.has(edge.fromNodeId)) {
            nodeIds.add(edge.fromNodeId);
            nextFrontier.add(edge.fromNodeId);
          }
          if (!nodeIds.has(edge.toNodeId)) {
            nodeIds.add(edge.toNodeId);
            nextFrontier.add(edge.toNodeId);
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  const nodesById = new Map(
    snapshot.nodes.map((node) => [node.id, node] as const),
  );
  const nodes = Object.freeze(
    [...nodeIds]
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is ReturnType<typeof mapWorkflowNodeRow> => !!node)
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
  const maps = Object.freeze(
    snapshot.maps
      .filter((map) => map.entryNodeId === opts.entryNodeId)
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id),
      ),
  );
  const traces = Object.freeze(
    snapshot.traces
      .filter((trace) => trace.entryNodeId === opts.entryNodeId)
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id),
      ),
  );
  const entryNode = nodes.find((node) => node.id === opts.entryNodeId);

  return Object.freeze({
    ...(entryNode ? { entryNode } : {}),
    nodes,
    edges: Object.freeze(
      [...edgeMap.values()].sort(
        (left, right) =>
          left.fromNodeId.localeCompare(right.fromNodeId) ||
          left.toNodeId.localeCompare(right.toNodeId),
      ),
    ),
    maps,
    traces,
  });
}

export function buildKuzuWorkflowProjectionStats(
  workspacePath: string,
): KuzuWorkflowProjectionStats {
  const payload = buildWorkflowProjectionPayload(workspacePath);
  return Object.freeze({
    nodeCount: payload.nodes.length,
    relationshipCount: payload.relationships.length,
    schemaStatementCount: KUZU_SCHEMA_STATEMENTS.length,
    mergeStatementCount: 4,
    cleanupStatementCount: 1,
  });
}
