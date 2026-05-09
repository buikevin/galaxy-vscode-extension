/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Benchmarks workflow graph and hybrid RAG coverage on a real workspace snapshot.
 */

import fs from "node:fs";
import path from "node:path";

const storageRoot = path.join(process.env.HOME ?? "", ".galaxy", "projects");
process.env.CHROMA_URL = process.env.CHROMA_URL?.trim() || "http://127.0.0.1:1";
const originalWarn = console.warn;
console.warn = (...args) => {
  const [firstArg] = args;
  if (
    typeof firstArg === "string" &&
    firstArg.includes(
      "The 'path' argument is deprecated. Please use 'ssl', 'host', and 'port' instead",
    )
  ) {
    return;
  }
  originalWarn(...args);
};

function parseArgs(argv) {
  let workspacePath = process.cwd();
  let positionalWorkspaceConsumed = false;
  let assertLocalBenchmark = false;
  let assertKuzuQueryParity = false;
  let assertKuzuSubgraphParity = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --workspace");
      }
      workspacePath = path.resolve(value);
      positionalWorkspaceConsumed = true;
      index += 1;
      continue;
    }
    if (arg === "--assert-local-benchmark") {
      assertLocalBenchmark = true;
      continue;
    }
    if (arg === "--assert-kuzu-parity") {
      assertKuzuQueryParity = true;
      assertKuzuSubgraphParity = true;
      continue;
    }
    if (arg === "--assert-kuzu-query-parity") {
      assertKuzuQueryParity = true;
      continue;
    }
    if (arg === "--assert-kuzu-subgraph-parity") {
      assertKuzuSubgraphParity = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (!positionalWorkspaceConsumed) {
      workspacePath = path.resolve(arg);
      positionalWorkspaceConsumed = true;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }

  return Object.freeze({
    workspacePath,
    assertLocalBenchmark,
    assertKuzuQueryParity,
    assertKuzuSubgraphParity,
  });
}

function normalizeEnvFlag(value) {
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

async function loadBenchmarkRuntime() {
  const [
    benchmarkModule,
    projectStoreModule,
    semanticRetrievalModule,
    ragDatabaseModule,
    taskMemoryModule,
    workflowArtifactModule,
    workflowExtractorModule,
    retrievalHelpersModule,
  ] = await Promise.all([
    import("../out/context/benchmark/retrieval.js"),
    import("../out/context/project-store.js"),
    import("../out/context/semantic/retrieval.js"),
    import("../out/context/rag-metadata/database.js"),
    import("../out/context/rag-metadata/task-memory.js"),
    import("../out/context/workflow/artifact-semantic/index.js"),
    import("../out/context/workflow/extractor/runtime.js"),
    import("../out/context/prompt/retrieval-helpers.js"),
  ]);

  return Object.freeze({
    buildRetrievalBenchmarkReport:
      benchmarkModule.buildRetrievalBenchmarkReport,
    getProjectStorageInfo: projectStoreModule.getProjectStorageInfo,
    buildSemanticRetrievalContext:
      semanticRetrievalModule.buildSemanticRetrievalContext,
    withRagMetadataDatabase: ragDatabaseModule.withRagMetadataDatabase,
    queryRelevantTaskMemory: taskMemoryModule.queryRelevantTaskMemory,
    primeWorkflowArtifactSemanticIndex:
      workflowArtifactModule.primeWorkflowArtifactSemanticIndex,
    refreshWorkflowGraph: workflowExtractorModule.refreshWorkflowGraph,
    buildWorkflowRetrievalBlock:
      retrievalHelpersModule.buildWorkflowRetrievalBlock,
    shouldEnableWorkflowRereadGuard:
      retrievalHelpersModule.shouldEnableWorkflowRereadGuard,
  });
}

function summarizeLabels(label, values) {
  if (!values || values.length === 0) {
    return null;
  }
  const preview = values.slice(0, 4).join(", ");
  const suffix = values.length > 4 ? ` (+${values.length - 4} more)` : "";
  return `${label}: ${preview}${suffix}`;
}

function summarizeIds(label, ids) {
  if (!ids || ids.length === 0) {
    return null;
  }
  const preview = ids.slice(0, 5).join(", ");
  const suffix = ids.length > 5 ? ` (+${ids.length - 5} more)` : "";
  return `${label}: ${preview}${suffix}`;
}

function summarizeScoreMismatches(label, mismatches) {
  if (!mismatches || mismatches.length === 0) {
    return null;
  }
  const preview = mismatches
    .slice(0, 4)
    .map((entry) => `${entry.id}(${entry.localScore}!=${entry.backendScore})`)
    .join(", ");
  const suffix =
    mismatches.length > 4 ? ` (+${mismatches.length - 4} more)` : "";
  return `${label}: ${preview}${suffix}`;
}

function formatBackendStatus(diagnostic) {
  if (!diagnostic.available) {
    return "unavailable";
  }
  return diagnostic.aligned ? "aligned" : "drift";
}

function formatBackendDiagnosticSuffix(label, diagnostic) {
  if (!diagnostic.available || diagnostic.details.length === 0) {
    return null;
  }
  return `${label}Details=${diagnostic.details.join(" | ")}`;
}

function collectBenchmarkAssertionFailures(benchmark, options) {
  const failures = [];

  if (options.assertLocalBenchmark) {
    if (benchmark.queries.length === 0) {
      failures.push({
        scope: "local-benchmark",
        message: "No representative benchmark queries were evaluated.",
      });
    }
    if (benchmark.retrievalBenchmarks.length !== benchmark.queries.length) {
      failures.push({
        scope: "local-benchmark",
        message: `Expected ${benchmark.queries.length} retrieval benchmark results but found ${benchmark.retrievalBenchmarks.length}.`,
      });
    }

    const missingWorkflowBlock = benchmark.queries
      .filter((query) => !query.workflowBlockPresent)
      .map((query) => query.queryText);
    const missingSemanticBlock = benchmark.queries
      .filter((query) => !query.semanticBlockPresent)
      .map((query) => query.queryText);
    const noWorkflowHits = benchmark.retrievalBenchmarks
      .filter(
        (query) =>
          query.workflow.nodeHitCount +
            query.workflow.mapHitCount +
            query.workflow.traceHitCount ===
          0,
      )
      .map((query) => query.queryText);
    const noCandidatePaths = benchmark.retrievalBenchmarks
      .filter((query) => query.candidatePaths.length === 0)
      .map((query) => query.queryText);

    const details = [
      summarizeLabels("missingWorkflowBlock", missingWorkflowBlock),
      summarizeLabels("missingSemanticBlock", missingSemanticBlock),
      summarizeLabels("noWorkflowHits", noWorkflowHits),
      summarizeLabels("noCandidatePaths", noCandidatePaths),
    ].filter((entry) => entry !== null);

    if (details.length > 0) {
      failures.push({
        scope: "local-benchmark",
        message: `Local retrieval benchmark contract drift detected: ${details.join("; ")}`,
      });
    }
  }

  if (options.assertKuzuQueryParity) {
    for (const report of benchmark.retrievalBenchmarks) {
      if (
        report.kuzuWorkflowQuery === null ||
        report.kuzuQueryComparison === null
      ) {
        failures.push({
          scope: "kuzu-query-parity",
          message: `Kuzu query parity requested for "${report.queryText}" but query comparison data is unavailable. Ensure the local Kuzu projector is enabled and the workflow graph has been refreshed.`,
        });
        continue;
      }

      if (!report.kuzuQueryComparison.aligned) {
        const details = [
          summarizeIds(
            "localOnly.nodeIds",
            report.kuzuQueryComparison.localOnly.nodeIds,
          ),
          summarizeIds(
            "localOnly.mapIds",
            report.kuzuQueryComparison.localOnly.mapIds,
          ),
          summarizeIds(
            "localOnly.traceIds",
            report.kuzuQueryComparison.localOnly.traceIds,
          ),
          summarizeIds(
            "backendOnly.nodeIds",
            report.kuzuQueryComparison.backendOnly.nodeIds,
          ),
          summarizeIds(
            "backendOnly.mapIds",
            report.kuzuQueryComparison.backendOnly.mapIds,
          ),
          summarizeIds(
            "backendOnly.traceIds",
            report.kuzuQueryComparison.backendOnly.traceIds,
          ),
          summarizeIds(
            "ranking.nodeIds",
            report.kuzuQueryComparison.ranking.nodeIds,
          ),
          summarizeIds(
            "ranking.mapIds",
            report.kuzuQueryComparison.ranking.mapIds,
          ),
          summarizeIds(
            "ranking.traceIds",
            report.kuzuQueryComparison.ranking.traceIds,
          ),
          summarizeScoreMismatches(
            "scoreMismatches.nodes",
            report.kuzuQueryComparison.scoreMismatches.nodes,
          ),
          summarizeScoreMismatches(
            "scoreMismatches.maps",
            report.kuzuQueryComparison.scoreMismatches.maps,
          ),
          summarizeScoreMismatches(
            "scoreMismatches.traces",
            report.kuzuQueryComparison.scoreMismatches.traces,
          ),
        ].filter((entry) => entry !== null);

        failures.push({
          scope: "kuzu-query-parity",
          message: `Kuzu query parity drift detected for "${report.queryText}"${details.length > 0 ? `: ${details.join("; ")}` : "."}`,
        });
      }
    }
  }

  if (options.assertKuzuSubgraphParity) {
    for (const report of benchmark.retrievalBenchmarks) {
      if (report.kuzuSubgraph === null || report.kuzuComparison === null) {
        failures.push({
          scope: "kuzu-subgraph-parity",
          message: `Kuzu subgraph parity requested for "${report.queryText}" but subgraph comparison data is unavailable. Ensure the local Kuzu projector is enabled and the query resolves an entry node.`,
        });
        continue;
      }

      if (!report.kuzuComparison.aligned) {
        const details = [
          summarizeIds(
            "localOnly.nodeIds",
            report.kuzuComparison.localOnly.nodeIds,
          ),
          summarizeIds(
            "localOnly.edgeIds",
            report.kuzuComparison.localOnly.edgeIds,
          ),
          summarizeIds(
            "localOnly.mapIds",
            report.kuzuComparison.localOnly.mapIds,
          ),
          summarizeIds(
            "localOnly.traceIds",
            report.kuzuComparison.localOnly.traceIds,
          ),
          summarizeIds(
            "backendOnly.nodeIds",
            report.kuzuComparison.backendOnly.nodeIds,
          ),
          summarizeIds(
            "backendOnly.edgeIds",
            report.kuzuComparison.backendOnly.edgeIds,
          ),
          summarizeIds(
            "backendOnly.mapIds",
            report.kuzuComparison.backendOnly.mapIds,
          ),
          summarizeIds(
            "backendOnly.traceIds",
            report.kuzuComparison.backendOnly.traceIds,
          ),
        ].filter((entry) => entry !== null);

        failures.push({
          scope: "kuzu-subgraph-parity",
          message: `Kuzu subgraph parity drift detected for "${report.queryText}"${details.length > 0 ? `: ${details.join("; ")}` : "."}`,
        });
      }
    }
  }

  return Object.freeze(failures);
}

/**
 * Returns the project storage directory that belongs to the requested workspace.
 */
function findProjectStorageDir(targetWorkspacePath, runtime) {
  const entries = fs.existsSync(storageRoot)
    ? fs
        .readdirSync(storageRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
    : [];
  for (const entry of entries) {
    const projectDirPath = path.join(storageRoot, entry.name);
    const sessionPath = path.join(projectDirPath, "session-memory.json");
    if (!fs.existsSync(sessionPath)) {
      continue;
    }
    try {
      const sessionMemory = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      if (sessionMemory?.workspacePath === targetWorkspacePath) {
        return projectDirPath;
      }
    } catch {
      // Ignore malformed historical storage snapshots.
    }
  }
  const storage = runtime.getProjectStorageInfo(targetWorkspacePath);
  fs.mkdirSync(storage.projectDirPath, { recursive: true });
  return storage.projectDirPath;
}

/**
 * Loads session memory or returns a minimal empty shape when the workspace has no stored memory.
 */
function loadSessionMemory(projectDirPath, targetWorkspacePath) {
  const sessionPath = path.join(projectDirPath, "session-memory.json");
  if (fs.existsSync(sessionPath)) {
    return JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
  }

  const now = Date.now();
  return {
    workspaceId: path.basename(projectDirPath),
    workspacePath: targetWorkspacePath,
    activeTaskMemory: {
      taskId: null,
      originalUserGoal: "",
      currentObjective: "",
      definitionOfDone: [],
      completedSteps: [],
      pendingSteps: [],
      blockers: [],
      filesTouched: [],
      keyFiles: [],
      attachments: [],
      deniedCommands: [],
      recentTurnSummaries: [],
      handoffSummary: "",
      lastUpdatedAt: now,
    },
    projectMemory: {
      summary: "",
      conventions: [],
      recurringPitfalls: [],
      recentDecisions: [],
      keyFiles: [],
      lastUpdatedAt: now,
    },
    lastFinalAssistantConclusion: "",
    keyFiles: [],
    lastUpdatedAt: now,
  };
}

/**
 * Counts semantic chunks and embedded chunk vectors in the persisted semantic index.
 */
function countSemanticEmbeddings(projectDirPath) {
  const semanticIndexPath = path.join(projectDirPath, "semantic-index.json");
  if (!fs.existsSync(semanticIndexPath)) {
    return { total: 0, embedded: 0 };
  }
  const store = JSON.parse(fs.readFileSync(semanticIndexPath, "utf-8"));
  const chunks = Object.values(store?.chunks ?? {});
  const embedded = chunks.filter(
    (chunk) => chunk?.embeddingModel && Array.isArray(chunk?.embedding),
  ).length;
  return { total: chunks.length, embedded };
}

/**
 * Loads workflow and task-memory coverage counts from SQLite.
 */
function loadSqliteCoverage(targetWorkspacePath, runtime) {
  return runtime.withRagMetadataDatabase(targetWorkspacePath, (db) => {
    const count = (sql) => {
      const row = db.prepare(sql).get();
      if (!row || typeof row !== "object") {
        return 0;
      }
      return Number(Object.values(row)[0] ?? 0);
    };
    return Object.freeze({
      taskMemoryEntries: count("SELECT COUNT(*) FROM task_memory_entries"),
      taskMemoryEmbeddings: count(
        "SELECT COUNT(*) FROM task_memory_embeddings",
      ),
      workflowNodes: count("SELECT COUNT(*) FROM workflow_nodes"),
      workflowEdges: count("SELECT COUNT(*) FROM workflow_edges"),
      workflowMaps: count("SELECT COUNT(*) FROM workflow_maps"),
      workflowTraceSummaries: count(
        "SELECT COUNT(*) FROM workflow_trace_summaries",
      ),
      workflowArtifactEmbeddings: count(
        "SELECT COUNT(*) FROM workflow_artifact_embeddings",
      ),
    });
  });
}

/**
 * Benchmarks one representative flow query through workflow and semantic retrieval layers.
 */
async function benchmarkFlowQuery(
  targetWorkspacePath,
  sessionMemory,
  queryText,
  runtime,
) {
  const workingTurnFiles = Object.freeze([
    ...sessionMemory.activeTaskMemory.filesTouched,
    ...sessionMemory.activeTaskMemory.keyFiles,
  ]);
  const workflowBlock = await runtime.buildWorkflowRetrievalBlock({
    workspacePath: targetWorkspacePath,
    queryText,
    workingTurnFiles,
    mentionedPaths: [],
  });
  const semanticBlock = await runtime.buildSemanticRetrievalContext({
    workspacePath: targetWorkspacePath,
    queryText,
    candidateFiles: [
      ...workflowBlock.candidatePaths,
      ...sessionMemory.activeTaskMemory.keyFiles,
      ...sessionMemory.projectMemory.keyFiles,
    ],
    records: [],
    primaryPaths: [],
    definitionPaths: [],
    referencePaths: [],
    workflowPathScores: workflowBlock.pathScores,
  });
  const taskMemory = await runtime.queryRelevantTaskMemory(
    targetWorkspacePath,
    queryText,
    3,
  );
  return Object.freeze({
    queryText,
    workflowBlockPresent: workflowBlock.content.includes(
      "[WORKFLOW GRAPH RETRIEVAL]",
    ),
    semanticBlockPresent: semanticBlock.content.includes(
      "[SEMANTIC RETRIEVAL]",
    ),
    workflowGuardEnabled: runtime.shouldEnableWorkflowRereadGuard(
      queryText,
      workflowBlock.entryCount,
      workflowBlock.candidatePaths,
    ),
    workflowCandidatePaths: workflowBlock.candidatePaths.length,
    finalPromptTokens: semanticBlock.tokens,
    evidenceEntries: taskMemory.entries.length,
    syntaxEntries: semanticBlock.entryCount,
  });
}

/**
 * Formats the benchmark as a Markdown report for manual review.
 */
function formatMarkdownReport(benchmark) {
  const projection = benchmark.retrievalBenchmarks[0]?.projection ?? null;
  return [
    "# Workflow Graph Trace RAG Benchmark",
    "",
    `- Workspace: \`${benchmark.workspacePath}\``,
    `- Generated at: ${new Date(benchmark.generatedAt).toISOString()}`,
    `- Chroma mode: ${benchmark.chromaMode}`,
    "",
    "## Coverage",
    "",
    `- Semantic chunks embedded: ${benchmark.semanticCoverage.embedded}/${benchmark.semanticCoverage.total}`,
    `- Task memory entries: ${benchmark.sqliteCoverage.taskMemoryEntries}`,
    `- Task memory embeddings: ${benchmark.sqliteCoverage.taskMemoryEmbeddings}`,
    `- Workflow nodes: ${benchmark.sqliteCoverage.workflowNodes}`,
    `- Workflow edges: ${benchmark.sqliteCoverage.workflowEdges}`,
    `- Workflow maps: ${benchmark.sqliteCoverage.workflowMaps}`,
    `- Workflow trace summaries: ${benchmark.sqliteCoverage.workflowTraceSummaries}`,
    `- Workflow artifact embeddings: ${benchmark.sqliteCoverage.workflowArtifactEmbeddings}`,
    ...(projection
      ? [
          `- Kuzu projection nodes: ${projection.nodeCount}`,
          `- Kuzu projection relationships: ${projection.relationshipCount}`,
          `- Kuzu projection schema statements: ${projection.schemaStatementCount}`,
        ]
      : []),
    "",
    "## Representative Flow Queries",
    "",
    ...benchmark.queries.map(
      (query) =>
        `- \`${query.queryText}\`: workflowBlock=${query.workflowBlockPresent}, semanticBlock=${query.semanticBlockPresent}, rereadGuard=${query.workflowGuardEnabled}, workflowPaths=${query.workflowCandidatePaths}, promptTokens=${query.finalPromptTokens}, evidence=${query.evidenceEntries}, syntax=${query.syntaxEntries}`,
    ),
    "",
    "## Local Retrieval Benchmarks",
    "",
    ...benchmark.retrievalBenchmarks.map((query) => {
      const details = [
        formatBackendDiagnosticSuffix("kuzuQuery", query.kuzuDiagnostics.query),
        formatBackendDiagnosticSuffix(
          "kuzuSubgraph",
          query.kuzuDiagnostics.subgraph,
        ),
      ].filter((entry) => entry !== null);
      return `- \`${query.queryText}\`: intent=${query.retrieval.primaryIntent}, mode=${query.mode}, nodes=${query.workflow.nodeHitCount}, maps=${query.workflow.mapHitCount}, traces=${query.workflow.traceHitCount}, subgraphNodes=${query.workflow.subgraph.nodeCount}, taskMemory=${query.taskMemory.entryHitCount}, candidatePaths=${query.candidatePaths.length}, kuzuQuery=${formatBackendStatus(query.kuzuDiagnostics.query)}, kuzuSubgraph=${formatBackendStatus(query.kuzuDiagnostics.subgraph)}${details.length > 0 ? `, ${details.join(", ")}` : ""}`;
    }),
    "",
    "## Interpretation",
    "",
    "- This benchmark measures current retrieval coverage on the real workspace snapshot stored in `.galaxy/projects`.",
    "- It helps verify whether workflow graph retrieval is present before a model needs to reread raw files.",
    "- The local retrieval benchmark section mirrors the headless benchmark contract used by galaxy-code and can compare local results against the embedded Kuzu read path when the projector is available.",
    "- It does not claim that edit-heavy or document-heavy tasks can avoid all rereads, because exact file-state validation is still required for safe range edits.",
    "",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = await loadBenchmarkRuntime();
  if (options.assertKuzuQueryParity || options.assertKuzuSubgraphParity) {
    await runtime.refreshWorkflowGraph(options.workspacePath);
  }
  const projectDirPath = findProjectStorageDir(options.workspacePath, runtime);
  const sessionMemory = loadSessionMemory(
    projectDirPath,
    options.workspacePath,
  );
  await runtime.queryRelevantTaskMemory(
    options.workspacePath,
    "warm task memory embeddings",
    5,
  );
  await runtime.primeWorkflowArtifactSemanticIndex(options.workspacePath);

  const benchmarkQueries = Object.freeze([
    "Trace the galaxy vscode extension workflow graph retrieval and quality gate flow.",
    "Which files and services are involved when the extension builds prompt context and workflow retrieval?",
    "Explain the documentation generation and validation flow without rereading the whole workspace.",
  ]);

  const queryResults = [];
  const retrievalBenchmarks = [];
  for (const queryText of benchmarkQueries) {
    queryResults.push(
      await benchmarkFlowQuery(
        options.workspacePath,
        sessionMemory,
        queryText,
        runtime,
      ),
    );
    retrievalBenchmarks.push(
      await runtime.buildRetrievalBenchmarkReport({
        workspacePath: options.workspacePath,
        queryText,
        limit: 3,
        mode: "lexical",
      }),
    );
  }

  const benchmark = Object.freeze({
    workspacePath: options.workspacePath,
    generatedAt: Date.now(),
    chromaMode:
      process.env.CHROMA_URL === "http://127.0.0.1:1"
        ? "disabled-for-benchmark"
        : "configured",
    semanticCoverage: countSemanticEmbeddings(projectDirPath),
    sqliteCoverage: loadSqliteCoverage(options.workspacePath, runtime),
    queries: Object.freeze(queryResults),
    retrievalBenchmarks: Object.freeze(retrievalBenchmarks),
  });

  const reportPath = path.resolve(
    "documents/WORKFLOW_GRAPH_TRACE_RAG_BENCHMARK.md",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, formatMarkdownReport(benchmark), "utf-8");
  console.log(JSON.stringify({ reportPath, benchmark }, null, 2));

  const failures = collectBenchmarkAssertionFailures(benchmark, options);
  for (const failure of failures) {
    console.error(`[galaxy] ${failure.scope}: ${failure.message}`);
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`[galaxy] workflow benchmark failed: ${String(error)}`);
  process.exitCode = 1;
});
