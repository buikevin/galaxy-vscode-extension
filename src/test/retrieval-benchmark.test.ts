import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildRetrievalBenchmarkReport } from "../context/benchmark/retrieval";
import { getProjectStorageInfo } from "../context/project-store";
import {
  appendTaskMemoryEntry,
  replaceTaskMemoryFindings,
} from "../context/rag-metadata/task-memory";
import type { WorkflowGraphSnapshot } from "../context/workflow/entities";
import { syncWorkflowGraphSnapshot } from "../context/workflow/sync";

const localRequire = createRequire(__filename);

function createTempWorkspace(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "galaxy-retrieval-benchmark-test-"),
  );
}

function cleanupTempWorkspace(workspacePath: string): void {
  const storage = getProjectStorageInfo(workspacePath);
  fs.rmSync(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
  fs.rmSync(storage.projectDirPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

function createRichWorkflowSnapshot(now: number): WorkflowGraphSnapshot {
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
    mapSources: Object.freeze([
      Object.freeze({
        workflowMapId: "workflow-map-1",
        sourceKind: "node",
        sourceRef: "node-service",
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

function hasKuzuRuntime(): boolean {
  try {
    localRequire("kuzu");
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  delete process.env["GALAXY_KUZU_PROJECTOR_ENABLED"];
  delete process.env["GALAXY_KUZU_DB_PATH"];
});

test("buildRetrievalBenchmarkReport returns deterministic local benchmark data for workflow and task continuity", async () => {
  const workspacePath = createTempWorkspace();
  try {
    process.env["GALAXY_KUZU_PROJECTOR_ENABLED"] = "false";
    const now = Date.now();
    syncWorkflowGraphSnapshot(workspacePath, createRichWorkflowSnapshot(now));
    const storage = getProjectStorageInfo(workspacePath);
    appendTaskMemoryEntry(workspacePath, {
      turnId: "turn-benchmark-1",
      workspaceId: storage.workspaceId,
      turnKind: "implementation",
      userIntent: "continue fix customer service validation flow",
      assistantConclusion:
        "The customer service path still needs a validation branch before persistence.",
      filesJson: JSON.stringify(["src/server/services/customer-service.ts"]),
      confidence: 0.9,
      freshnessScore: 1,
      createdAt: now,
    });
    replaceTaskMemoryFindings(workspacePath, "turn-benchmark-1", [
      {
        id: "finding-benchmark-1",
        entryTurnId: "turn-benchmark-1",
        kind: "validation_failure",
        summary: "Customer service is still missing a validation guard.",
        filePath: "src/server/services/customer-service.ts",
        line: 2,
        status: "open",
        createdAt: now,
      },
    ]);

    const report = await buildRetrievalBenchmarkReport({
      workspacePath,
      queryText: "continue fix customer service validation flow",
      limit: 3,
      mode: "lexical",
    });

    assert.strictEqual(report.retrieval.primaryIntent, "task_continuity");
    assert.deepStrictEqual(report.retrieval.secondaryIntents, [
      "change_impact",
      "feature_flow",
    ]);
    assert.strictEqual(report.workflow.nodeHitCount, 2);
    assert.strictEqual(report.workflow.entryNodeId, "node-controller");
    assert.strictEqual(report.workflow.subgraph.edgeCount, 1);
    assert.strictEqual(report.taskMemory.entryHitCount, 1);
    assert.strictEqual(report.taskMemory.findingHitCount, 1);
    assert.strictEqual(report.projection.schemaStatementCount, 4);
    assert.strictEqual(report.kuzuWorkflowQuery, null);
    assert.strictEqual(report.kuzuSubgraph, null);
    assert.strictEqual(report.kuzuQueryComparison, null);
    assert.strictEqual(report.kuzuComparison, null);
    assert.strictEqual(report.kuzuDiagnostics.query.available, false);
    assert.strictEqual(report.kuzuDiagnostics.query.aligned, null);
    assert.deepStrictEqual(report.kuzuDiagnostics.query.details, []);
    assert.ok(
      report.candidatePaths.includes("src/server/services/customer-service.ts"),
    );
    assert.strictEqual(
      report.taskMemory.topFindings[0]?.id,
      "finding-benchmark-1",
    );
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("buildRetrievalBenchmarkReport keeps Kuzu query comparison disabled in hybrid mode", async () => {
  const workspacePath = createTempWorkspace();
  try {
    process.env["GALAXY_KUZU_PROJECTOR_ENABLED"] = "false";
    const now = Date.now();
    syncWorkflowGraphSnapshot(workspacePath, createRichWorkflowSnapshot(now));

    const report = await buildRetrievalBenchmarkReport({
      workspacePath,
      queryText: "customer create flow",
      limit: 3,
      mode: "hybrid",
    });

    assert.strictEqual(report.mode, "hybrid");
    assert.strictEqual(report.workflow.entryNodeId, "node-controller");
    assert.strictEqual(report.kuzuWorkflowQuery, null);
    assert.strictEqual(report.kuzuQueryComparison, null);
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});

test("buildRetrievalBenchmarkReport compares local and Kuzu parity when the local projection is available", async (t) => {
  if (!hasKuzuRuntime()) {
    t.skip("kuzu optional dependency is not installed");
    return;
  }
  const workspacePath = createTempWorkspace();
  try {
    process.env["GALAXY_KUZU_PROJECTOR_ENABLED"] = "true";
    const now = Date.now();
    syncWorkflowGraphSnapshot(workspacePath, createRichWorkflowSnapshot(now));

    const report = await buildRetrievalBenchmarkReport({
      workspacePath,
      queryText: "customer create flow",
      limit: 3,
      mode: "lexical",
    });

    assert.strictEqual(report.kuzuWorkflowQuery?.nodeHitCount, 2);
    assert.strictEqual(report.kuzuWorkflowQuery?.mapHitCount, 1);
    assert.strictEqual(report.kuzuWorkflowQuery?.traceHitCount, 1);
    assert.strictEqual(report.kuzuQueryComparison?.aligned, true);
    assert.deepStrictEqual(report.kuzuQueryComparison?.ranking.nodeIds, []);
    assert.deepStrictEqual(report.kuzuQueryComparison?.ranking.mapIds, []);
    assert.deepStrictEqual(report.kuzuQueryComparison?.ranking.traceIds, []);
    assert.deepStrictEqual(
      report.kuzuQueryComparison?.scoreMismatches.nodes,
      [],
    );
    assert.deepStrictEqual(
      report.kuzuQueryComparison?.scoreMismatches.maps,
      [],
    );
    assert.deepStrictEqual(
      report.kuzuQueryComparison?.scoreMismatches.traces,
      [],
    );
    assert.strictEqual(report.kuzuDiagnostics.query.available, true);
    assert.strictEqual(report.kuzuDiagnostics.query.aligned, true);
    assert.deepStrictEqual(report.kuzuDiagnostics.query.details, []);
    assert.strictEqual(report.kuzuSubgraph?.nodeCount, 2);
    assert.strictEqual(report.kuzuSubgraph?.edgeCount, 1);
    assert.strictEqual(report.kuzuSubgraph?.mapCount, 1);
    assert.strictEqual(report.kuzuSubgraph?.traceCount, 1);
    assert.strictEqual(report.kuzuComparison?.aligned, true);
    assert.strictEqual(report.kuzuDiagnostics.subgraph.available, true);
    assert.strictEqual(report.kuzuDiagnostics.subgraph.aligned, true);
    assert.deepStrictEqual(report.kuzuDiagnostics.subgraph.details, []);
  } finally {
    cleanupTempWorkspace(workspacePath);
  }
});
