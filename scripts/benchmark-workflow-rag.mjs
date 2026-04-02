/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Benchmarks workflow graph and hybrid RAG coverage on a real workspace snapshot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildSemanticRetrievalContext } from '../out/context/semantic/retrieval.js';
import { withRagMetadataDatabase } from '../out/context/rag-metadata/database.js';
import { queryRelevantTaskMemory } from '../out/context/rag-metadata/task-memory.js';
import { primeWorkflowArtifactSemanticIndex } from '../out/context/workflow/artifact-semantic/index.js';
import { buildWorkflowRetrievalBlock, shouldEnableWorkflowRereadGuard } from '../out/context/prompt/retrieval-helpers.js';

const workspacePath = path.resolve(process.argv[2] ?? process.cwd());
const storageRoot = path.join(process.env.HOME ?? '', '.galaxy', 'projects');
process.env.CHROMA_URL = process.env.CHROMA_URL?.trim() || 'http://127.0.0.1:1';
const originalWarn = console.warn;
console.warn = (...args) => {
  const [firstArg] = args;
  if (
    typeof firstArg === 'string' &&
    firstArg.includes("The 'path' argument is deprecated. Please use 'ssl', 'host', and 'port' instead")
  ) {
    return;
  }
  originalWarn(...args);
};

/**
 * Returns the project storage directory that belongs to the requested workspace.
 */
function findProjectStorageDir(targetWorkspacePath) {
  const entries = fs.readdirSync(storageRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const projectDirPath = path.join(storageRoot, entry.name);
    const sessionPath = path.join(projectDirPath, 'session-memory.json');
    if (!fs.existsSync(sessionPath)) {
      continue;
    }
    try {
      const sessionMemory = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      if (sessionMemory?.workspacePath === targetWorkspacePath) {
        return projectDirPath;
      }
    } catch {
      // Ignore malformed historical storage snapshots.
    }
  }
  throw new Error(`No project storage found for workspace: ${targetWorkspacePath}`);
}

/**
 * Loads session memory or returns a minimal empty shape when the workspace has no stored memory.
 */
function loadSessionMemory(projectDirPath, targetWorkspacePath) {
  const sessionPath = path.join(projectDirPath, 'session-memory.json');
  if (fs.existsSync(sessionPath)) {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  }

  const now = Date.now();
  return {
    workspaceId: path.basename(projectDirPath),
    workspacePath: targetWorkspacePath,
    activeTaskMemory: {
      taskId: null,
      originalUserGoal: '',
      currentObjective: '',
      definitionOfDone: [],
      completedSteps: [],
      pendingSteps: [],
      blockers: [],
      filesTouched: [],
      keyFiles: [],
      attachments: [],
      deniedCommands: [],
      recentTurnSummaries: [],
      handoffSummary: '',
      lastUpdatedAt: now,
    },
    projectMemory: {
      summary: '',
      conventions: [],
      recurringPitfalls: [],
      recentDecisions: [],
      keyFiles: [],
      lastUpdatedAt: now,
    },
    lastFinalAssistantConclusion: '',
    keyFiles: [],
    lastUpdatedAt: now,
  };
}

/**
 * Counts semantic chunks and embedded chunk vectors in the persisted semantic index.
 */
function countSemanticEmbeddings(projectDirPath) {
  const semanticIndexPath = path.join(projectDirPath, 'semantic-index.json');
  if (!fs.existsSync(semanticIndexPath)) {
    return { total: 0, embedded: 0 };
  }
  const store = JSON.parse(fs.readFileSync(semanticIndexPath, 'utf-8'));
  const chunks = Object.values(store?.chunks ?? {});
  const embedded = chunks.filter((chunk) => chunk?.embeddingModel && Array.isArray(chunk?.embedding)).length;
  return { total: chunks.length, embedded };
}

/**
 * Loads workflow and task-memory coverage counts from SQLite.
 */
function loadSqliteCoverage(targetWorkspacePath) {
  return withRagMetadataDatabase(targetWorkspacePath, (db) => {
    const count = (sql) => {
      const row = db.prepare(sql).get();
      if (!row || typeof row !== 'object') {
        return 0;
      }
      return Number(Object.values(row)[0] ?? 0);
    };
    return Object.freeze({
      taskMemoryEntries: count('SELECT COUNT(*) FROM task_memory_entries'),
      taskMemoryEmbeddings: count('SELECT COUNT(*) FROM task_memory_embeddings'),
      workflowNodes: count('SELECT COUNT(*) FROM workflow_nodes'),
      workflowEdges: count('SELECT COUNT(*) FROM workflow_edges'),
      workflowMaps: count('SELECT COUNT(*) FROM workflow_maps'),
      workflowTraceSummaries: count('SELECT COUNT(*) FROM workflow_trace_summaries'),
      workflowArtifactEmbeddings: count('SELECT COUNT(*) FROM workflow_artifact_embeddings'),
    });
  });
}

/**
 * Benchmarks one representative flow query through workflow and semantic retrieval layers.
 */
async function benchmarkFlowQuery(targetWorkspacePath, sessionMemory, queryText) {
  const workingTurnFiles = Object.freeze([
    ...sessionMemory.activeTaskMemory.filesTouched,
    ...sessionMemory.activeTaskMemory.keyFiles,
  ]);
  const workflowBlock = await buildWorkflowRetrievalBlock({
    workspacePath: targetWorkspacePath,
    queryText,
    workingTurnFiles,
    mentionedPaths: [],
  });
  const semanticBlock = await buildSemanticRetrievalContext({
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
  const taskMemory = await queryRelevantTaskMemory(targetWorkspacePath, queryText, 3);
  return Object.freeze({
    queryText,
    workflowBlockPresent: workflowBlock.content.includes('[WORKFLOW GRAPH RETRIEVAL]'),
    semanticBlockPresent: semanticBlock.content.includes('[SEMANTIC RETRIEVAL]'),
    workflowGuardEnabled: shouldEnableWorkflowRereadGuard(queryText, workflowBlock.entryCount, workflowBlock.candidatePaths),
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
  return [
    '# Workflow Graph Trace RAG Benchmark',
    '',
    `- Workspace: \`${benchmark.workspacePath}\``,
    `- Generated at: ${new Date(benchmark.generatedAt).toISOString()}`,
    `- Chroma mode: ${benchmark.chromaMode}`,
    '',
    '## Coverage',
    '',
    `- Semantic chunks embedded: ${benchmark.semanticCoverage.embedded}/${benchmark.semanticCoverage.total}`,
    `- Task memory entries: ${benchmark.sqliteCoverage.taskMemoryEntries}`,
    `- Task memory embeddings: ${benchmark.sqliteCoverage.taskMemoryEmbeddings}`,
    `- Workflow nodes: ${benchmark.sqliteCoverage.workflowNodes}`,
    `- Workflow edges: ${benchmark.sqliteCoverage.workflowEdges}`,
    `- Workflow maps: ${benchmark.sqliteCoverage.workflowMaps}`,
    `- Workflow trace summaries: ${benchmark.sqliteCoverage.workflowTraceSummaries}`,
    `- Workflow artifact embeddings: ${benchmark.sqliteCoverage.workflowArtifactEmbeddings}`,
    '',
    '## Representative Flow Queries',
    '',
    ...benchmark.queries.map((query) =>
      `- \`${query.queryText}\`: workflowBlock=${query.workflowBlockPresent}, semanticBlock=${query.semanticBlockPresent}, rereadGuard=${query.workflowGuardEnabled}, workflowPaths=${query.workflowCandidatePaths}, promptTokens=${query.finalPromptTokens}, evidence=${query.evidenceEntries}, syntax=${query.syntaxEntries}`,
    ),
    '',
    '## Interpretation',
    '',
    '- This benchmark measures current retrieval coverage on the real workspace snapshot stored in `.galaxy/projects`.',
    '- It helps verify whether workflow graph retrieval is present before a model needs to reread raw files.',
    '- It does not claim that edit-heavy or document-heavy tasks can avoid all rereads, because exact file-state validation is still required for safe range edits.',
    '',
  ].join('\n');
}

const projectDirPath = findProjectStorageDir(workspacePath);
const sessionMemory = loadSessionMemory(projectDirPath, workspacePath);
await queryRelevantTaskMemory(workspacePath, 'warm task memory embeddings', 5);
await primeWorkflowArtifactSemanticIndex(workspacePath);

const benchmarkQueries = Object.freeze([
  'Trace the galaxy vscode extension workflow graph retrieval and quality gate flow.',
  'Which files and services are involved when the extension builds prompt context and workflow retrieval?',
  'Explain the documentation generation and validation flow without rereading the whole workspace.',
]);

const queryResults = [];
for (const queryText of benchmarkQueries) {
  queryResults.push(await benchmarkFlowQuery(workspacePath, sessionMemory, queryText));
}

const benchmark = Object.freeze({
  workspacePath,
  generatedAt: Date.now(),
  chromaMode: process.env.CHROMA_URL === 'http://127.0.0.1:1' ? 'disabled-for-benchmark' : 'configured',
  semanticCoverage: countSemanticEmbeddings(projectDirPath),
  sqliteCoverage: loadSqliteCoverage(workspacePath),
  queries: Object.freeze(queryResults),
});

const reportPath = path.resolve('documents/WORKFLOW_GRAPH_TRACE_RAG_BENCHMARK.md');
fs.writeFileSync(reportPath, formatMarkdownReport(benchmark), 'utf-8');
console.log(JSON.stringify({ reportPath, benchmark }, null, 2));
