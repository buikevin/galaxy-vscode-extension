import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { WorkflowGraphSnapshot } from "../context/workflow/entities";
import {
  buildKuzuWorkflowProjectionPath,
  clearWorkflowProjectionFromKuzu,
  queryWorkflowGraphFromKuzu,
  queryWorkflowSubgraphFromKuzu,
} from "../context/workflow/projector/kuzu";
import {
  clearWorkflowGraph,
  syncWorkflowGraphSnapshot,
} from "../context/workflow/sync";

type KuzuQueryResult = Readonly<{
  close?: () => void;
  getAllSync: () => readonly Readonly<Record<string, unknown>>[];
}>;

type KuzuConnection = Readonly<{
  querySync: (
    statement: string,
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

function createTempWorkspace(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "galaxy-vscode-kuzu-projector-test-"),
  );
}

function cleanupTempWorkspace(workspacePath: string): void {
  fs.rmSync(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

function createWorkflowSnapshot(now: number): WorkflowGraphSnapshot {
  return Object.freeze({
    nodes: Object.freeze([
      Object.freeze({
        id: "node-controller",
        nodeType: "controller",
        label: "createCustomerController",
        filePath: "src/server/controllers/customers.ts",
        symbolName: "createCustomerController",
        startLine: 1,
        endLine: 3,
        createdAt: now,
        updatedAt: now,
      }),
      Object.freeze({
        id: "node-service",
        nodeType: "backend_service",
        label: "createCustomer",
        filePath: "src/server/services/customer-service.ts",
        symbolName: "createCustomer",
        startLine: 1,
        endLine: 6,
        createdAt: now,
        updatedAt: now,
      }),
    ]),
    edges: Object.freeze([
      Object.freeze({
        id: "edge-controller-service",
        fromNodeId: "node-controller",
        toNodeId: "node-service",
        edgeType: "calls",
        label: "calls",
        supportingFilePath: "src/server/controllers/customers.ts",
        supportingSymbolName: "createCustomerController",
        supportingLine: 2,
        createdAt: now,
        updatedAt: now,
      }),
    ]),
    maps: Object.freeze([
      Object.freeze({
        id: "workflow-map-1",
        mapType: "request_flow",
        entryNodeId: "node-controller",
        title: "Customer Create Flow",
        summary:
          "Customer creation starts at the controller and then calls the backend service.",
        generatedAt: now,
        updatedAt: now,
      }),
    ]),
    traceSummaries: Object.freeze([
      Object.freeze({
        id: "trace-summary-1",
        traceKind: "request_flow",
        entryNodeId: "node-controller",
        title: "Customer Request Trace",
        queryHint: "customer request trace",
        narrative:
          "The request enters the controller before the service persists the customer.",
        generatedAt: now,
        updatedAt: now,
      }),
    ]),
  });
}

function createExpandedWorkflowSnapshot(now: number): WorkflowGraphSnapshot {
  return Object.freeze({
    nodes: Object.freeze([
      ...createWorkflowSnapshot(now).nodes,
      Object.freeze({
        id: "node-repository",
        nodeType: "backend_service",
        label: "persistCustomer",
        filePath: "src/server/repositories/customer-repository.ts",
        symbolName: "persistCustomer",
        startLine: 1,
        endLine: 8,
        createdAt: now,
        updatedAt: now,
      }),
    ]),
    edges: Object.freeze([
      ...createWorkflowSnapshot(now).edges,
      Object.freeze({
        id: "edge-service-repository",
        fromNodeId: "node-service",
        toNodeId: "node-repository",
        edgeType: "calls",
        label: "calls",
        supportingFilePath: "src/server/services/customer-service.ts",
        supportingSymbolName: "createCustomer",
        supportingLine: 4,
        createdAt: now,
        updatedAt: now,
      }),
    ]),
    maps: createWorkflowSnapshot(now).maps,
    traceSummaries: createWorkflowSnapshot(now).traceSummaries,
  });
}

function loadKuzuModule(): KuzuModule {
  const loaded = require("kuzu") as KuzuModule & { default?: KuzuModule };
  return loaded.Database ? loaded : (loaded.default as KuzuModule);
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
    (result as { close: () => void }).close();
  }
}

function readCount(databasePath: string, statement: string): number {
  const kuzu = loadKuzuModule();
  const database = new kuzu.Database(databasePath);
  const connection = new kuzu.Connection(database);
  try {
    const result = connection.querySync(statement) as KuzuQueryResult;
    const rows = result.getAllSync();
    closeKuzuResult(result);
    return Number(rows[0]?.["count"] ?? 0);
  } finally {
    connection.closeSync();
    database.closeSync();
  }
}

afterEach(() => {
  delete process.env["GALAXY_KUZU_PROJECTOR_ENABLED"];
  delete process.env["GALAXY_KUZU_DB_PATH"];
});

test("syncWorkflowGraphSnapshot projects the latest workflow snapshot to a local Kuzu graph by default", () => {
  const workspacePath = createTempWorkspace();
  try {
    syncWorkflowGraphSnapshot(
      workspacePath,
      createWorkflowSnapshot(Date.now()),
    );

    const databasePath = buildKuzuWorkflowProjectionPath(workspacePath);
    assert.ok(fs.existsSync(databasePath));
    assert.strictEqual(
      readCount(databasePath, "MATCH (n:FlowNode) RETURN COUNT(*) AS count"),
      2,
    );
    assert.strictEqual(
      readCount(databasePath, "MATCH (n:WorkflowMap) RETURN COUNT(*) AS count"),
      1,
    );
    assert.strictEqual(
      readCount(
        databasePath,
        "MATCH (n:TraceSummary) RETURN COUNT(*) AS count",
      ),
      1,
    );
    assert.strictEqual(
      readCount(
        databasePath,
        "MATCH (a:FlowNode)-[rel:WORKFLOW_EDGE]->(b:FlowNode) RETURN COUNT(*) AS count",
      ),
      1,
    );

    clearWorkflowGraph(workspacePath);
    assert.strictEqual(fs.existsSync(databasePath), false);
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("Kuzu local projection can be disabled explicitly", () => {
  const workspacePath = createTempWorkspace();
  try {
    process.env["GALAXY_KUZU_PROJECTOR_ENABLED"] = "false";
    syncWorkflowGraphSnapshot(
      workspacePath,
      createWorkflowSnapshot(Date.now()),
    );

    const databasePath = buildKuzuWorkflowProjectionPath(workspacePath);
    assert.strictEqual(fs.existsSync(databasePath), false);
    assert.strictEqual(clearWorkflowProjectionFromKuzu(workspacePath), false);
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("Kuzu query helpers mirror workflow graph query and subgraph shapes from the local projection", () => {
  const workspacePath = createTempWorkspace();
  try {
    syncWorkflowGraphSnapshot(
      workspacePath,
      createWorkflowSnapshot(Date.now()),
    );

    const queryResult = queryWorkflowGraphFromKuzu(
      workspacePath,
      "customer create flow",
      3,
    );
    assert.ok(queryResult);
    assert.strictEqual(queryResult?.nodes.length, 2);
    assert.strictEqual(queryResult?.maps.length, 1);
    assert.strictEqual(queryResult?.traces.length, 1);

    const subgraph = queryWorkflowSubgraphFromKuzu(workspacePath, {
      entryNodeId: "node-controller",
      maxHops: 3,
      maxNodes: 24,
    });
    assert.ok(subgraph);
    assert.strictEqual(subgraph?.entryNode?.id, "node-controller");
    assert.strictEqual(subgraph?.nodes.length, 2);
    assert.strictEqual(subgraph?.edges.length, 1);
    assert.strictEqual(subgraph?.maps.length, 1);
    assert.strictEqual(subgraph?.traces.length, 1);
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("Kuzu projection tolerates duplicate projected ids by collapsing them before insert", () => {
  const workspacePath = createTempWorkspace();
  const now = Date.now();
  try {
    syncWorkflowGraphSnapshot(
      workspacePath,
      Object.freeze({
        nodes: Object.freeze([
          Object.freeze({
            id: "node-controller",
            nodeType: "controller",
            label: "createCustomerController",
            filePath: "src/server/controllers/customers.ts",
            symbolName: "createCustomerController",
            createdAt: now,
            updatedAt: now,
          }),
          Object.freeze({
            id: "node-controller",
            nodeType: "controller",
            label: "validateCustomerController",
            filePath: "src/server/controllers/customers.ts",
            symbolName: "validateCustomerController",
            createdAt: now,
            updatedAt: now,
          }),
          Object.freeze({
            id: "node-service",
            nodeType: "backend_service",
            label: "createCustomer",
            filePath: "src/server/services/customer-service.ts",
            symbolName: "createCustomer",
            createdAt: now,
            updatedAt: now,
          }),
        ]),
        edges: Object.freeze([
          Object.freeze({
            id: "edge-controller-service",
            fromNodeId: "node-controller",
            toNodeId: "node-service",
            edgeType: "calls",
            createdAt: now,
            updatedAt: now,
          }),
        ]),
      }),
    );

    const databasePath = buildKuzuWorkflowProjectionPath(workspacePath);
    assert.ok(fs.existsSync(databasePath));
    assert.strictEqual(
      readCount(databasePath, "MATCH (n:FlowNode) RETURN COUNT(*) AS count"),
      2,
    );
    assert.strictEqual(
      queryWorkflowGraphFromKuzu(workspacePath, "validate customer", 5)
        ?.nodes[0]?.node.id,
      "node-controller",
    );
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("Kuzu projection can rebuild atomically while an older reader still has the previous database open", () => {
  const workspacePath = createTempWorkspace();
  try {
    syncWorkflowGraphSnapshot(
      workspacePath,
      createWorkflowSnapshot(Date.now()),
    );

    const databasePath = buildKuzuWorkflowProjectionPath(workspacePath);
    const kuzu = loadKuzuModule();
    const database = new kuzu.Database(databasePath);
    const connection = new kuzu.Connection(database);
    try {
      const initialCount = readCount(
        databasePath,
        "MATCH (n:FlowNode) RETURN COUNT(*) AS count",
      );
      assert.strictEqual(initialCount, 2);

      syncWorkflowGraphSnapshot(
        workspacePath,
        createExpandedWorkflowSnapshot(Date.now()),
      );
    } finally {
      connection.closeSync();
      database.closeSync();
    }

    assert.strictEqual(
      readCount(databasePath, "MATCH (n:FlowNode) RETURN COUNT(*) AS count"),
      3,
    );
    assert.strictEqual(
      queryWorkflowGraphFromKuzu(
        workspacePath,
        "persist customer",
        5,
      )?.nodes.some((entry) => entry.node.id === "node-repository"),
      true,
    );
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});
