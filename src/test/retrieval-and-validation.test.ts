import * as assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../shared/constants';
import { createDraftLocalAttachment } from '../attachments/attachment-store';
import { extractCodeChunkUnits } from '../context/code-chunk-extractor';
import { createHistoryManager } from '../context/history-manager';
import { buildPromptContext } from '../context/prompt-builder';
import { getProjectStorageInfo } from '../context/project-store';
import { withRagMetadataDatabase } from '../context/rag-metadata/database';
import { getCachedReadResult } from '../context/rag-metadata/read-cache';
import { loadTelemetrySummary } from '../context/telemetry';
import { evaluateWorkflowRereadGuard } from '../context/workflow/reread-guard';
import {
  buildWorkflowGraphSnapshot,
  flushScheduledWorkflowGraphRefresh,
  refreshWorkflowGraph,
  scheduleWorkflowGraphRefresh,
} from '../context/workflow/extractor/runtime';
import {
  getWorkflowSubgraph,
  queryWorkflowEndpoints,
  queryWorkflowGraph,
  queryWorkflowNodesByFilePath,
  queryWorkflowNodesByRoutePath,
  queryWorkflowNodesBySymbolName,
  queryWorkflowScreens,
} from '../context/workflow/query/index';
import { syncWorkflowGraphSnapshot } from '../context/workflow/sync';
import { tryResolveDirectCommand } from '../runtime/direct-command';
import { executeToolAsync } from '../tools/file/dispatch';
import { selectNodeValidationScripts } from '../validation/node';

suite('Retrieval And Validation', () => {
  function createTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-vscode-test-'));
  }

  function cleanupTempWorkspace(workspacePath: string): void {
    const storage = getProjectStorageInfo(workspacePath);

    const removeDir = (targetPath: string): void => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
          return;
        } catch (error) {
          if (attempt >= 2) {
            throw error;
          }
        }
      }
    };

    removeDir(workspacePath);
    removeDir(storage.projectDirPath);
  }

  test('extractCodeChunkUnits returns precise TypeScript symbol ranges', async () => {
    const content = [
      'export class Runner {',
      '  run() {',
      '    return 1;',
      '  }',
      '}',
      '',
      'export function execute(input: string) {',
      '  const value = input.trim();',
      '  return value;',
      '}',
      '',
    ].join('\n');

    const units = await extractCodeChunkUnits({
      relativePath: 'src/sample.ts',
      content,
    });

    assert.strictEqual(units.length >= 2, true);
    const runner = units.find((unit) => unit.name === 'Runner');
    const execute = units.find((unit) => unit.name === 'execute');
    assert.ok(runner);
    assert.ok(execute);
    assert.strictEqual(content.slice(runner!.startIndex, runner!.endIndex), [
      'export class Runner {',
      '  run() {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n'));
    assert.strictEqual(content.slice(execute!.startIndex, execute!.endIndex), [
      'export function execute(input: string) {',
      '  const value = input.trim();',
      '  return value;',
      '}',
    ].join('\n'));
  });

  test('extractCodeChunkUnits returns python class and function units', async () => {
    const content = [
      'class Runner:',
      '    pass',
      '',
      'def execute():',
      '    return "ok"',
      '',
    ].join('\n');

    const units = await extractCodeChunkUnits({
      relativePath: 'src/sample.py',
      content,
    });

    assert.deepStrictEqual(
      units.map((unit) => ({ name: unit.name, kind: unit.kind, startLine: unit.startLine, endLine: unit.endLine })),
      [
        { name: 'Runner', kind: 'class', startLine: 1, endLine: 2 },
        { name: 'execute', kind: 'function', startLine: 4, endLine: 5 },
      ],
    );
  });

  test('selectNodeValidationScripts prefers explicit lint/typecheck/test/build scripts', () => {
    const scripts = {
      lint: 'eslint src',
      'lint:ci': 'eslint src --max-warnings=0',
      'check:types': 'tsc --noEmit',
      test: 'vitest run',
      'build:check': 'vite build',
      dev: 'vite',
    };

    const selected = selectNodeValidationScripts(
      scripts,
      new Set(['typescript', 'javascript']),
      {
        lint: ['lint:ci'],
        staticCheck: [],
        test: [],
        build: [],
      },
    );

    assert.deepStrictEqual(
      selected.map((item) => ({ category: item.category, scriptName: item.scriptName })),
      [
        { category: 'lint', scriptName: 'lint:ci' },
        { category: 'static-check', scriptName: 'check:types' },
        { category: 'test', scriptName: 'test' },
        { category: 'build', scriptName: 'build:check' },
      ],
    );
  });

  test('tryResolveDirectCommand keeps quoted args and normalizes git file checkout', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'pages', 'contract'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'pages', 'contract', 'ContractPage.tsx'), 'export {};', 'utf-8');

      const stashCommand = tryResolveDirectCommand(
        'git stash push -m "wip-before-fix" src/pages/contract/ContractPage.tsx',
        workspacePath,
      );
      assert.ok(stashCommand);
      assert.deepStrictEqual(stashCommand!.args, [
        'stash',
        'push',
        '-m',
        'wip-before-fix',
        'src/pages/contract/ContractPage.tsx',
      ]);

      const checkoutCommand = tryResolveDirectCommand(
        'git checkout src/pages/contract/ContractPage.tsx',
        workspacePath,
      );
      assert.ok(checkoutCommand);
      assert.deepStrictEqual(checkoutCommand!.args, [
        'checkout',
        '--',
        'src/pages/contract/ContractPage.tsx',
      ]);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('edit_file_range rejects stale line edits without snapshot evidence', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'sample.ts'),
        ['const value = 1;', 'console.log(value);', ''].join('\n'),
        'utf-8',
      );

      const result = await executeToolAsync(
        {
          name: 'edit_file_range',
          params: {
            path: 'src/sample.ts',
            start_line: 1,
            end_line: 1,
            new_content: 'const value = 2;',
          },
        },
        {
          workspaceRoot: workspacePath,
          config: DEFAULT_CONFIG,
          revealFile: async () => undefined,
          refreshWorkspaceFiles: async () => undefined,
        },
      );

      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /requires expected_total_lines|requires exact snapshot evidence/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('history manager does not commit final conclusion before quality gate passes', () => {
    const workspacePath = createTempWorkspace();
    try {
      const historyManager = createHistoryManager({ workspacePath });
      historyManager.startTurn({
        id: 'user-1',
        role: 'user',
        content: 'Fix the bug.',
        timestamp: Date.now(),
      });

      historyManager.finalizeTurn({
        assistantText: 'Done. I fixed the bug.',
        commitConclusion: false,
      });

      assert.strictEqual(historyManager.getSessionMemory().lastFinalAssistantConclusion, '');
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('read_document query returns semantic snippets and caches decoded source text', async function () {
    this.timeout(5000);
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'docs'), { recursive: true });
      const documentPath = path.join(workspacePath, 'docs', 'requirements.md');
      fs.writeFileSync(
        documentPath,
        [
          '# Requirements',
          '',
          '## Authentication',
          'The login screen must support password reset and MFA enrollment.',
          '',
          '## Transfers',
          'The transfer limit validation must block amounts above the daily threshold and show an inline error.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = await executeToolAsync(
        {
          name: 'read_document',
          params: {
            path: 'docs/requirements.md',
            query: 'What is the transfer limit validation requirement?',
          },
        },
        {
          workspaceRoot: workspacePath,
          config: DEFAULT_CONFIG,
          revealFile: async () => undefined,
          refreshWorkspaceFiles: async () => undefined,
        },
      );

      assert.strictEqual(result.success, true);
      assert.match(result.content, /\[DOCUMENT SEMANTIC SNIPPETS\]/);
      assert.match(result.content, /transfer limit validation/i);
      assert.strictEqual(result.meta?.readMode, 'document_semantic');

      const stat = fs.statSync(documentPath);
      const cachedSource = getCachedReadResult(workspacePath, {
        filePath: path.resolve(documentPath),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        readMode: 'document_source',
        offset: 0,
        limit: 0,
      });
      assert.ok(cachedSource);
      assert.match(cachedSource?.content ?? '', /daily threshold/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('createDraftLocalAttachment stores extracted text cache instead of cloning document binary', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const storage = getProjectStorageInfo(workspacePath);
      const markdown = [
        '# URD',
        '',
        'Transfer validation must reject values above the configured limit.',
        '',
      ].join('\n');
      const attachment = await createDraftLocalAttachment({
        workspacePath,
        name: 'requirements.md',
        mimeType: 'text/markdown',
        dataUrl: `data:text/markdown;base64,${Buffer.from(markdown, 'utf-8').toString('base64')}`,
      });

      assert.ok(attachment.attachmentId);
      assert.deepStrictEqual(fs.readdirSync(storage.attachmentsFilesDirPath), []);
      const textEntries = fs.readdirSync(storage.attachmentsTextDirPath);
      assert.strictEqual(textEntries.length, 1);
      const cachedTextPath = path.join(storage.attachmentsTextDirPath, textEntries[0]!);
      assert.match(fs.readFileSync(cachedTextPath, 'utf-8'), /configured limit/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow graph snapshot persists and returns graph-centered retrieval context', () => {
    const workspacePath = createTempWorkspace();
    try {
      const now = Date.now();
      syncWorkflowGraphSnapshot(workspacePath, {
        nodes: [
          {
            id: 'screen-customer-form',
            nodeType: 'screen',
            label: 'Customer Form Screen',
            filePath: 'src/pages/customer/FormPage.tsx',
            symbolName: 'CustomerFormPage',
            description: 'Renders the customer submit form.',
            descriptionSource: 'comment',
            createdAt: now,
          },
          {
            id: 'handler-submit-customer',
            nodeType: 'event_handler',
            label: 'handleSubmit',
            filePath: 'src/pages/customer/FormPage.tsx',
            symbolName: 'handleSubmit',
            startLine: 48,
            endLine: 71,
            createdAt: now,
          },
          {
            id: 'api-create-customer',
            nodeType: 'api_endpoint',
            label: 'POST /api/customers',
            filePath: 'src/server/routes/customers.ts',
            symbolName: 'createCustomerRoute',
            routeMethod: 'POST',
            routePath: '/api/customers',
            createdAt: now,
          },
          {
            id: 'service-create-customer',
            nodeType: 'service',
            label: 'createCustomer',
            filePath: 'src/server/services/customer-service.ts',
            symbolName: 'createCustomer',
            createdAt: now,
          },
        ],
        edges: [
          {
            id: 'edge-screen-submit-handler',
            fromNodeId: 'screen-customer-form',
            toNodeId: 'handler-submit-customer',
            edgeType: 'handles_event',
            label: 'submit click',
            createdAt: now,
          },
          {
            id: 'edge-handler-api',
            fromNodeId: 'handler-submit-customer',
            toNodeId: 'api-create-customer',
            edgeType: 'fetches',
            label: 'POST /api/customers',
            supportingFilePath: 'src/pages/customer/FormPage.tsx',
            supportingSymbolName: 'handleSubmit',
            supportingLine: 58,
            createdAt: now,
          },
          {
            id: 'edge-api-service',
            fromNodeId: 'api-create-customer',
            toNodeId: 'service-create-customer',
            edgeType: 'calls',
            label: 'customerService.createCustomer',
            supportingFilePath: 'src/server/routes/customers.ts',
            supportingSymbolName: 'createCustomerRoute',
            supportingLine: 23,
            createdAt: now,
          },
        ],
        maps: [
          {
            id: 'map-customer-submit',
            mapType: 'screen_flow',
            entryNodeId: 'screen-customer-form',
            title: 'Customer submit flow',
            summary: 'Customer Form Screen submits to POST /api/customers and then invokes createCustomer.',
            generatedAt: now,
          },
        ],
        mapSources: [
          { workflowMapId: 'map-customer-submit', sourceKind: 'node', sourceRef: 'screen-customer-form' },
          { workflowMapId: 'map-customer-submit', sourceKind: 'edge', sourceRef: 'edge-handler-api' },
        ],
        traceSummaries: [
          {
            id: 'trace-customer-submit',
            traceKind: 'journey',
            entryNodeId: 'screen-customer-form',
            title: 'Customer create journey',
            queryHint: 'submit customer form',
            narrative: 'From the screen submit button, handleSubmit posts to /api/customers and the backend route delegates to createCustomer.',
            generatedAt: now,
          },
        ],
      });

      const queryResult = queryWorkflowGraph(workspacePath, 'submit customer form api', 3);
      assert.strictEqual(queryResult.maps.length > 0, true);
      assert.strictEqual(queryResult.nodes.length > 0, true);
      assert.strictEqual(queryResult.traces.length > 0, true);
      assert.strictEqual(queryResult.maps[0]?.map.id, 'map-customer-submit');
      assert.strictEqual(queryResult.nodes.some((entry) => entry.node.id === 'handler-submit-customer'), true);

      const subgraph = getWorkflowSubgraph(workspacePath, {
        entryNodeId: 'screen-customer-form',
        maxHops: 3,
      });
      assert.strictEqual(subgraph.entryNode?.id, 'screen-customer-form');
      assert.deepStrictEqual(
        [...subgraph.nodes.map((node) => node.id)].sort(),
        [
          'api-create-customer',
          'handler-submit-customer',
          'screen-customer-form',
          'service-create-customer',
        ],
      );
      assert.strictEqual(subgraph.edges.length, 3);
      assert.strictEqual(subgraph.maps[0]?.id, 'map-customer-submit');
      assert.strictEqual(subgraph.traces[0]?.id, 'trace-customer-submit');
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow artifact timestamps stay stable when source hash does not change', () => {
    const workspacePath = createTempWorkspace();
    try {
      const now = Date.now();
      const snapshot = Object.freeze({
        nodes: Object.freeze([
          Object.freeze({
            id: 'route-customers',
            nodeType: 'api_endpoint',
            label: 'POST /api/customers',
            filePath: 'src/server/routes/customers.ts',
            routeMethod: 'POST',
            routePath: '/api/customers',
            createdAt: now,
          }),
          Object.freeze({
            id: 'service-customers',
            nodeType: 'service',
            label: 'createCustomer',
            filePath: 'src/server/services/customer-service.ts',
            symbolName: 'createCustomer',
            createdAt: now,
          }),
        ]),
        edges: Object.freeze([
          Object.freeze({
            id: 'edge-route-service',
            fromNodeId: 'route-customers',
            toNodeId: 'service-customers',
            edgeType: 'calls',
            createdAt: now,
          }),
        ]),
        maps: Object.freeze([
          Object.freeze({
            id: 'workflow-map:route-customers',
            mapType: 'api_flow',
            entryNodeId: 'route-customers',
            title: 'Flow: POST /api/customers',
            summary: 'POST /api/customers delegates to createCustomer.',
            sourceHash: 'hash-static',
            generatedAt: now,
            updatedAt: now,
          }),
        ]),
        mapSources: Object.freeze([
          Object.freeze({
            workflowMapId: 'workflow-map:route-customers',
            sourceKind: 'node',
            sourceRef: 'route-customers',
            sourceHash: 'hash-static',
          }),
        ]),
        traceSummaries: Object.freeze([
          Object.freeze({
            id: 'workflow-trace:route-customers',
            traceKind: 'api_flow',
            entryNodeId: 'route-customers',
            title: 'Flow: POST /api/customers',
            queryHint: 'customers route create customer',
            narrative: 'The route forwards the request to createCustomer.',
            sourceHash: 'hash-static',
            generatedAt: now,
            updatedAt: now,
          }),
        ]),
      });

      syncWorkflowGraphSnapshot(workspacePath, snapshot);
      const first = withRagMetadataDatabase(workspacePath, (db) => Object.freeze({
        map: db.prepare(`
          SELECT generated_at, updated_at, source_hash
          FROM workflow_maps
          WHERE id = ?
        `).get('workflow-map:route-customers') as { generated_at: number; updated_at: number; source_hash: string | null },
        trace: db.prepare(`
          SELECT generated_at, updated_at, source_hash
          FROM workflow_trace_summaries
          WHERE id = ?
        `).get('workflow-trace:route-customers') as { generated_at: number; updated_at: number; source_hash: string | null },
      }));

      syncWorkflowGraphSnapshot(workspacePath, {
        ...snapshot,
        maps: Object.freeze([
          {
            ...snapshot.maps[0]!,
            generatedAt: now + 10_000,
            updatedAt: now + 10_000,
          },
        ]),
        traceSummaries: Object.freeze([
          {
            ...snapshot.traceSummaries[0]!,
            generatedAt: now + 10_000,
            updatedAt: now + 10_000,
          },
        ]),
      });

      const second = withRagMetadataDatabase(workspacePath, (db) => Object.freeze({
        map: db.prepare(`
          SELECT generated_at, updated_at, source_hash
          FROM workflow_maps
          WHERE id = ?
        `).get('workflow-map:route-customers') as { generated_at: number; updated_at: number; source_hash: string | null },
        trace: db.prepare(`
          SELECT generated_at, updated_at, source_hash
          FROM workflow_trace_summaries
          WHERE id = ?
        `).get('workflow-trace:route-customers') as { generated_at: number; updated_at: number; source_hash: string | null },
      }));

      assert.strictEqual(first.map.source_hash, 'hash-static');
      assert.strictEqual(second.map.source_hash, 'hash-static');
      assert.strictEqual(second.map.generated_at, first.map.generated_at);
      assert.strictEqual(second.map.updated_at, first.map.updated_at);
      assert.strictEqual(second.trace.generated_at, first.trace.generated_at);
      assert.strictEqual(second.trace.updated_at, first.trace.updated_at);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds generic flow graph for http, service, and queue patterns', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'pages', 'customer'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'controllers'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'services'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'repositories'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'workers'), { recursive: true });

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'pages', 'customer', 'CustomerPage.tsx'),
        [
          'export function CustomerPage() {',
          '  async function handleSubmit(payload: unknown) {',
          '    return apiClient.post("/api/customers", payload);',
          '  }',
          '  return <button onClick={() => handleSubmit({})}>Save</button>;',
          '}',
          '',
          'const apiClient = {',
          '  post(path: string, payload: unknown) {',
          '    return fetch(path, { method: "POST", body: JSON.stringify(payload) });',
          '  },',
          '};',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'routes', 'customers.ts'),
        [
          'import { createCustomerController } from "../controllers/customers";',
          'declare const router: { post(path: string, handler: unknown): void };',
          'router.post("/api/customers", createCustomerController);',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'controllers', 'customers.ts'),
        [
          'import { createCustomer } from "../services/customer-service";',
          'export async function createCustomerController(payload: unknown) {',
          '  return createCustomer(payload);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'services', 'customer-service.ts'),
        [
          'import { insertCustomerRecord } from "../repositories/customer-repository";',
          'declare const queue: { publish(topic: string, payload: unknown): void };',
          'export async function createCustomer(payload: unknown) {',
          '  await insertCustomerRecord(payload);',
          '  publishCustomerCreated(payload);',
          '  return payload;',
          '}',
          'export function publishCustomerCreated(payload: unknown) {',
          '  queue.publish("customer.created", payload);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'repositories', 'customer-repository.ts'),
        [
          'declare const db: { query(sql: string, params?: unknown[]): Promise<unknown> };',
          'export async function insertCustomerRecord(payload: unknown) {',
          '  return db.query("insert into customers(id) values (?)", [payload]);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'services', 'audit-service.ts'),
        [
          'export function createCustomerAudit(payload: unknown) {',
          '  return payload;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'workers', 'customer-worker.ts'),
        [
          'import { createCustomerAudit } from "../services/audit-service";',
          'declare const queue: { consume(topic: string, handler: unknown): void };',
          'export async function handleCustomerCreated(payload: unknown) {',
          '  return createCustomerAudit(payload);',
          '}',
          'queue.consume("customer.created", handleCustomerCreated);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
      const edgePairs = snapshot.edges.map((edge) => `${edge.edgeType}:${edge.fromNodeId}->${edge.toNodeId}`);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
      assert.strictEqual((snapshot.traceSummaries?.length ?? 0) > 0, true);

      assert.strictEqual(nodeIds.has('workflow:route:POST:/api/customers'), true);
      assert.strictEqual(nodeIds.has('workflow:queue:customer.created'), true);
      assert.strictEqual(
        snapshot.nodes.some((node) => node.nodeType === 'repository' && node.symbolName === 'insertCustomerRecord'),
        true,
      );
      assert.strictEqual(
        snapshot.nodes.some((node) => node.nodeType === 'db_query' && /db\.query/i.test(node.label)),
        true,
      );
      assert.strictEqual(
        snapshot.nodes.some((node) => node.nodeType === 'controller' && node.symbolName === 'createCustomerController'),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('invokes_http') && edge.includes('workflow:route:POST:/api/customers')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('routes_to') && edge.includes('createCustomerController')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('publishes') && edge.includes('workflow:queue:customer.created')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('calls') && edge.includes('insertCustomerRecord')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('queries') && edge.includes('workflow:db:')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('consumes') && edge.includes('handleCustomerCreated')),
        true,
      );
      assert.strictEqual(
        edgePairs.some((edge) => edge.includes('calls') && edge.includes('createCustomerAudit')),
        true,
      );

      await refreshWorkflowGraph(workspacePath);
      const queryResult = queryWorkflowGraph(workspacePath, 'customer repository db query queue consumer', 6);
      assert.strictEqual(queryResult.nodes.some((entry) => entry.node.id === 'workflow:queue:customer.created'), true);
      assert.strictEqual(queryResult.nodes.some((entry) => entry.node.nodeType === 'db_query'), true);
      assert.strictEqual(queryResult.maps.some((entry) => /^Flow: /.test(entry.map.title)), true);
      assert.strictEqual(queryResult.traces.some((entry) => /customer/i.test(entry.trace.narrative)), true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('buildPromptContext injects workflow graph retrieval for flow queries', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'controllers'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'services'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'repositories'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'workers'), { recursive: true });

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'routes', 'customers.ts'),
        [
          'import { createCustomerController } from "../controllers/customers";',
          'declare const router: { post(path: string, handler: unknown): void };',
          'router.post("/api/customers", createCustomerController);',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'controllers', 'customers.ts'),
        [
          'import { createCustomer } from "../services/customer-service";',
          'export async function createCustomerController(payload: unknown) {',
          '  return createCustomer(payload);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'services', 'customer-service.ts'),
        [
          'import { insertCustomerRecord } from "../repositories/customer-repository";',
          'declare const queue: { publish(topic: string, payload: unknown): void };',
          'export async function createCustomer(payload: unknown) {',
          '  await insertCustomerRecord(payload);',
          '  queue.publish("customer.created", payload);',
          '  return payload;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'repositories', 'customer-repository.ts'),
        [
          'declare const db: { query(sql: string, params?: unknown[]): Promise<unknown> };',
          'export async function insertCustomerRecord(payload: unknown) {',
          '  return db.query("insert into customers(id) values (?)", [payload]);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'workers', 'customer-worker.ts'),
        [
          'import { createCustomer } from "../services/customer-service";',
          'declare const queue: { consume(topic: string, handler: unknown): void };',
          'export async function handleCustomerCreated(payload: unknown) {',
          '  return createCustomer(payload);',
          '}',
          'queue.consume("customer.created", handleCustomerCreated);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const now = Date.now();
      const result = await buildPromptContext({
        agentType: 'manual',
        notes: '',
        sessionMemory: {
          workspaceId: 'workflow-test',
          workspacePath,
          activeTaskMemory: {
            taskId: null,
            originalUserGoal: '',
            currentObjective: '',
            definitionOfDone: Object.freeze([]),
            completedSteps: Object.freeze([]),
            pendingSteps: Object.freeze([]),
            blockers: Object.freeze([]),
            filesTouched: Object.freeze([]),
            keyFiles: Object.freeze([]),
            attachments: Object.freeze([]),
            deniedCommands: Object.freeze([]),
            recentTurnSummaries: Object.freeze([]),
            handoffSummary: '',
            lastUpdatedAt: now,
          },
          projectMemory: {
            summary: '',
            conventions: Object.freeze([]),
            recurringPitfalls: Object.freeze([]),
            recentDecisions: Object.freeze([]),
            keyFiles: Object.freeze([]),
            lastUpdatedAt: now,
          },
          lastFinalAssistantConclusion: '',
          keyFiles: Object.freeze([]),
          lastUpdatedAt: now,
        },
        workingTurn: {
          turnId: 'turn-1',
          userMessage: {
            id: 'user-1',
            role: 'user',
            content: 'Trace the customer API flow through controller, repository, db query, and queue consumer.',
            timestamp: now,
          },
          assistantDraft: '',
          contextMessages: Object.freeze([]),
          toolDigests: Object.freeze([]),
          roundCount: 1,
          tokenEstimate: 0,
          startedAt: now,
          compacted: false,
          droppedContextMessages: 0,
        },
      });

      const combined = result.messages.map((message) => message.content).join('\n\n');
      assert.match(combined, /\[WORKFLOW GRAPH RETRIEVAL\]/);
      assert.match(combined, /\[WORKFLOW SUMMARIES\]/);
      assert.match(combined, /\[TRACE NARRATIVES\]/);
      assert.strictEqual(result.workflowRereadGuard?.enabled, true);
      assert.match(combined, /workflow graph path/i);
      assert.match(combined, /\[SEMANTIC RETRIEVAL\][\s\S]*workflow-graph/i);
      assert.match(combined, /\[MATCHED NODES\]/);
      assert.match(combined, /POST \/api\/customers/);
      assert.match(combined, /db\.query/i);
      assert.match(combined, /customer\.created/i);
      assert.match(combined, /Do not reread raw files just to reconstruct the flow/i);

      const telemetrySummary = loadTelemetrySummary(workspacePath);
      assert.strictEqual(telemetrySummary.workflowQueries >= 1, true);
      assert.strictEqual(telemetrySummary.workflowHits >= 1, true);
      assert.strictEqual(telemetrySummary.workflowGuardActivations >= 1, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow query helpers return direct matches for file, symbol, route, screen, and endpoint lookups', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'pages'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'controllers'), { recursive: true });

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'pages', 'CustomerPage.tsx'),
        [
          'export function CustomerPage() {',
          '  return null;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'routes', 'customers.ts'),
        [
          'import { createCustomerController } from "../controllers/customers";',
          'declare const router: { post(path: string, handler: unknown): void };',
          'router.post("/api/customers", createCustomerController);',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'controllers', 'customers.ts'),
        [
          'export async function createCustomerController(payload: unknown) {',
          '  return payload;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      await refreshWorkflowGraph(workspacePath);

      assert.strictEqual(
        queryWorkflowNodesByFilePath(workspacePath, 'src/server/routes/customers.ts').some((node) => node.routePath === '/api/customers'),
        true,
      );
      assert.strictEqual(
        queryWorkflowNodesBySymbolName(workspacePath, 'createCustomerController').some((node) => node.symbolName === 'createCustomerController'),
        true,
      );
      assert.strictEqual(
        queryWorkflowNodesByRoutePath(workspacePath, '/api/customers').some((node) => node.routePath === '/api/customers'),
        true,
      );
      assert.strictEqual(
        queryWorkflowScreens(workspacePath, 'customer').some((node) => node.nodeType === 'screen'),
        true,
      );
      assert.strictEqual(
        queryWorkflowEndpoints(workspacePath, 'customers').some((node) => node.routePath === '/api/customers'),
        true,
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('scheduleWorkflowGraphRefresh prewarms graph after relevant source changes', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'server', 'controllers'), { recursive: true });

      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'routes', 'customers.ts'),
        [
          'import { createCustomerController } from "../controllers/customers";',
          'declare const router: { post(path: string, handler: unknown): void };',
          'router.post("/api/customers", createCustomerController);',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'server', 'controllers', 'customers.ts'),
        [
          'export async function createCustomerController(payload: unknown) {',
          '  return payload;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      assert.strictEqual(
        scheduleWorkflowGraphRefresh(workspacePath, {
          filePaths: ['README.md'],
          delayMs: 0,
        }),
        false,
      );
      assert.strictEqual(
        scheduleWorkflowGraphRefresh(workspacePath, {
          filePaths: ['src/server/routes/customers.ts'],
          delayMs: 0,
        }),
        true,
      );

      await flushScheduledWorkflowGraphRefresh(workspacePath);

      const queryResult = queryWorkflowGraph(workspacePath, 'customers route api controller', 4);
      assert.strictEqual(queryResult.nodes.some((entry) => entry.node.routePath === '/api/customers'), true);
      assert.strictEqual(queryResult.nodes.some((entry) => entry.node.symbolName === 'createCustomerController'), true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('evaluateWorkflowRereadGuard blocks broad rereads but allows targeted rereads', () => {
    const workspacePath = createTempWorkspace();
    try {
      const broadRead = evaluateWorkflowRereadGuard({
        workspacePath,
        toolName: 'read_file',
        params: Object.freeze({
          path: 'src/server/routes/customers.ts',
          maxLines: 200,
          offset: 0,
        }),
        guard: Object.freeze({
          enabled: true,
          candidatePaths: Object.freeze(['src/server/routes/customers.ts']),
          entryCount: 6,
          queryText: 'Trace the customer flow.',
        }),
      });
      assert.strictEqual(broadRead.blocked, true);

      const targetedRead = evaluateWorkflowRereadGuard({
        workspacePath,
        toolName: 'read_file',
        params: Object.freeze({
          path: 'src/server/routes/customers.ts',
          maxLines: 60,
          offset: 40,
        }),
        guard: Object.freeze({
          enabled: true,
          candidatePaths: Object.freeze(['src/server/routes/customers.ts']),
          entryCount: 6,
          queryText: 'Trace the customer flow.',
        }),
      });
      assert.strictEqual(targetedRead.blocked, false);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });
});
