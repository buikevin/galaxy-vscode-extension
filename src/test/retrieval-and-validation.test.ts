import * as assert from 'assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../shared/constants';
import type { GalaxyConfig } from '../shared/config';
import { createDraftLocalAttachment } from '../attachments/attachment-store';
import { detectActiveProjectPath, detectActiveProjectPathFromCommandContext, resolveEffectiveProjectPath } from '../context/active-project';
import { extractCodeChunkUnits } from '../context/code-chunk-extractor';
import { cosineSimilarityEmbedding, embedTexts } from '../context/gemini-embeddings';
import { createToolDigest } from '../context/history/helpers';
import { createHistoryManager } from '../context/history-manager';
import { buildPromptContext } from '../context/prompt-builder';
import { narrowManualPlanningScope, shouldEmitManualPlanningHints } from '../context/prompt/context-blocks';
import { getProjectStorageInfo } from '../context/project-store';
import { withRagMetadataDatabase } from '../context/rag-metadata/database';
import { getCachedReadResult } from '../context/rag-metadata/read-cache';
import { loadTelemetrySummary } from '../context/telemetry';
import { evaluateWorkflowRereadGuard } from '../context/workflow/reread-guard';
import { buildAntiLoopGuardrails, buildEvidenceReuseBlock, deriveStaleEvidence } from '../context/tool-evidence/selectors';
import { clearSession, captureOriginal, trackFileWrite } from '../runtime/session-tracker';
import { flushBackgroundCommandCompletions } from '../extension-host/command-stream';
import { createChatRuntimeCallbacks as createHostChatRuntimeCallbacks } from '../extension-host/chat-runtime-callbacks';
import { debugChatMessage } from '../extension-host/message-runtime';
import { runInternalRepairTurn } from '../extension-host/chat-runtime';
import { isDocumentationOnlySessionFiles, runValidationAndReviewFlow } from '../extension-host/quality-gates';
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
import { buildWorkflowArtifacts } from '../context/workflow/extractor/artifacts';
import { tokenizeDirectCommandText, tryResolveDirectCommand } from '../runtime/direct-command';
import { buildShellEnvironment, resolveCommandBinary, resolveShellProfile } from '../runtime/shell-resolver';
import {
  editFileRangeTool,
  editFileTool,
  insertFileAtLineTool,
  multiEditFileRangesTool,
  writeFileTool,
} from '../tools/file/edit';
import { getEnabledToolDefinitions, findDiscoveredExtensionTool, isToolEnabled } from '../tools/file/definitions';
import { executeToolAsync } from '../tools/file/dispatch';
import { validateCodeTool } from '../tools/file/diff-validate';
import { grepTool, headTool, listDirTool, readFileTool, tailTool } from '../tools/file/path-read';
import { galaxyDesignProjectInfoTool } from '../tools/galaxy-design';
import {
  gitAddTool,
  gitCheckoutTool,
  gitCommitTool,
  gitDiffTool,
  gitPullTool,
  gitPushTool,
  gitStatusTool,
} from '../tools/project-command/git';
import {
  awaitManagedProjectCommandTool,
  getManagedProjectCommandOutputTool,
  killManagedProjectCommandTool,
  startManagedCommandTool,
} from '../tools/project-command/managed';
import { runProjectCommandTool } from '../tools/project-command/execute';
import { managedCommands } from '../tools/project-command/state';
import { selectNodeValidationScripts } from '../validation/node';
import type { ChatRuntimeCallbacks } from '../shared/chat-runtime';
import type { BackgroundCommandCompletion } from '../shared/extension-host';
import type { HistoryManager } from '../context/entities/history-manager';
import type { AgentType, ChatMessage } from '../shared/protocol';
import type { FileToolContext } from '../tools/entities/file-tools';

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

  async function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: platform,
    });
    try {
      return await run();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor);
      }
    }
  }

  function createTempGitWorkspace(): string {
    const workspacePath = createTempWorkspace();
    execSync('git init', { cwd: workspacePath, stdio: 'ignore' });
    execSync('git config user.name "Galaxy Test"', { cwd: workspacePath, stdio: 'ignore' });
    execSync('git config user.email "galaxy-test@example.com"', { cwd: workspacePath, stdio: 'ignore' });
    return workspacePath;
  }

  function getCurrentGitBranch(workspacePath: string): string {
    return execSync('git branch --show-current', { cwd: workspacePath, encoding: 'utf-8' }).trim();
  }

  function createMockChatRuntimeCallbacks(): ChatRuntimeCallbacks & {
    transcriptMessages: ChatMessage[];
    errors: string[];
    tempWorkspacePath: string;
  } {
    const transcriptMessages: ChatMessage[] = [];
    const errors: string[] = [];
    const tempWorkspacePath = createTempWorkspace();
    const historyManager: HistoryManager = createHistoryManager({
      workspacePath: tempWorkspacePath,
    });

    const toolContext: FileToolContext = {
      workspaceRoot: tempWorkspacePath,
      config: DEFAULT_CONFIG,
      revealFile: async () => {},
      refreshWorkspaceFiles: async () => {},
    };

    return {
      workspacePath: process.cwd(),
      historyManager,
      transcriptMessages,
      errors,
      tempWorkspacePath,
      addMessage: async (message) => {
        transcriptMessages.push(message);
      },
      appendLog: () => {},
      setStatusText: () => {},
      reportProgress: () => {},
      postRunState: async () => {},
      buildToolContext: () => toolContext,
      onChunk: async () => {},
      onMessage: async (message) => {
        transcriptMessages.push(message);
      },
      onToolCalls: async () => {},
      onEvidenceContext: async () => {},
      requestToolApproval: async () => 'allow',
      showWorkbenchError: (message) => {
        errors.push(message);
      },
      postErrorMessage: async (message) => {
        errors.push(message);
      },
      writeDebug: () => {},
      writeDebugBlock: () => {},
      shouldGateAssistantFinalMessage: () => false,
      getEffectiveConfig: () => DEFAULT_CONFIG,
      runValidationAndReviewFlow: async () => Object.freeze({ passed: true, repaired: false }),
      hasStreamingBuffers: () => false,
      clearStreamingBuffers: () => {},
      postInit: async () => {},
      buildContinueMessage: ({ attempt }) =>
        Object.freeze({
          id: `continue-test-${attempt}`,
          role: 'user' as const,
          content: 'continue',
          timestamp: Date.now(),
        }),
    };
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

  test('createToolDigest does not mark failed edit attempts as filesWritten', () => {
    const digest = createToolDigest(Object.freeze({
      id: 'tool-failed-edit',
      role: 'tool' as const,
      content: 'Error: Target range no longer matches',
      timestamp: Date.now(),
      toolName: 'edit_file_range',
      toolSuccess: false,
      toolParams: Object.freeze({
        path: 'src/pages/contract/ContractPage.tsx',
        start_line: 10,
        end_line: 20,
      }),
    }));

    assert.strictEqual(digest.success, false);
    assert.deepStrictEqual(digest.filesWritten, []);
  });

  test('deriveStaleEvidence does not invalidate prior reads after a failed edit attempt', () => {
    const evidence = Object.freeze([
      Object.freeze({
        toolName: 'read_file',
        success: true,
        stale: false,
        summary: 'Read ContractPage.tsx',
        filePath: 'src/pages/contract/ContractPage.tsx',
        readMode: 'full',
        contentPreview: 'const value = formatDate(order.date);',
      }),
      Object.freeze({
        toolName: 'edit_file_range',
        success: false,
        stale: false,
        summary: 'Failed to edit ContractPage.tsx by line range',
        filePath: 'src/pages/contract/ContractPage.tsx',
        operation: 'edit',
        changedLineRanges: Object.freeze([]),
      }),
    ]) as Parameters<typeof deriveStaleEvidence>[0];

    const freshened = deriveStaleEvidence(evidence);
    assert.strictEqual(freshened[0]?.stale ?? false, false);
    assert.strictEqual(freshened[1]?.stale ?? false, false);
  });

  test('deriveStaleEvidence invalidates prior reads after a successful edit', () => {
    const evidence = Object.freeze([
      Object.freeze({
        toolName: 'read_file',
        success: true,
        stale: false,
        summary: 'Read ContractPage.tsx',
        filePath: 'src/pages/contract/ContractPage.tsx',
        readMode: 'full',
        contentPreview: 'const value = formatDate(order.date);',
      }),
      Object.freeze({
        toolName: 'edit_file_range',
        success: true,
        stale: false,
        summary: 'Edited ContractPage.tsx by line range',
        filePath: 'src/pages/contract/ContractPage.tsx',
        operation: 'edit',
        changedLineRanges: Object.freeze([{ startLine: 10, endLine: 18 }]),
      }),
    ]) as Parameters<typeof deriveStaleEvidence>[0];

    const freshened = deriveStaleEvidence(evidence);
    assert.strictEqual(freshened[0]?.stale ?? false, true);
    assert.strictEqual(freshened[1]?.stale ?? false, false);
  });

  test('embedTexts falls back to deterministic local embeddings when remote embeddings fail', async () => {
    const embeddings = await embedTexts(
      ['submit order from product detail page', 'submit order from product detail page'],
      'RETRIEVAL_QUERY',
    );

    assert.ok(embeddings);
    assert.strictEqual(embeddings!.length, 2);
    assert.strictEqual(embeddings![0]!.length > 0, true);
    assert.deepStrictEqual(embeddings![0], embeddings![1]);
  });

  test('fallback embeddings still preserve relative similarity for close texts', async () => {
    const embeddings = await embedTexts(
      [
        'phone product grid with buy button and order flow',
        'phone product grid with buy button and order flow',
        'python worker consumes queue and writes invoice status',
      ],
      'RETRIEVAL_DOCUMENT',
    );

    assert.ok(embeddings);
    const sameSimilarity = cosineSimilarityEmbedding(embeddings![0], embeddings![1]);
    const differentSimilarity = cosineSimilarityEmbedding(embeddings![0], embeddings![2]);
    assert.strictEqual(sameSimilarity > 0.99, true);
    assert.strictEqual(sameSimilarity > differentSimilarity, true);
  });

  test('runInternalRepairTurn does not mirror internal repair prompts into the visible transcript', async function () {
    this.timeout(10_000);
    const callbacks = createMockChatRuntimeCallbacks();
    const repairMessage: ChatMessage = Object.freeze({
      id: 'review-repair-test',
      role: 'user',
      content: '[SYSTEM CODE REVIEW FEEDBACK]\nInternal repair prompt.',
      timestamp: Date.now(),
    });
    try {
      const result = await runInternalRepairTurn(callbacks, {
        config: DEFAULT_CONFIG,
        agentType: 'manual',
        userMessage: repairMessage,
        showUserMessageInTranscript: false,
      });

      assert.strictEqual(typeof result.hadError, 'boolean');
      assert.strictEqual(
        callbacks.transcriptMessages.some((message) => message.id === repairMessage.id),
        false,
      );
    } finally {
      cleanupTempWorkspace(callbacks.tempWorkspacePath);
    }
  });

  test('host chat runtime callbacks dedupe unchanged evidence context payloads', async () => {
    const workspacePath = createTempWorkspace();
    const historyManager: HistoryManager = createHistoryManager({ workspacePath });
    const postedMessages: Array<{ type: string }> = [];
    const debugBlocks: Array<{ scope: string; content: string }> = [];
    const logs: string[] = [];

    try {
      const callbacks = createHostChatRuntimeCallbacks({
        workspacePath,
        historyManager,
        addMessage: async () => {},
        appendLog: (_kind, text) => {
          logs.push(text);
        },
        setStatusText: () => {},
        reportProgress: () => {},
        postRunState: async () => {},
        postMessage: async (message) => {
          postedMessages.push({ type: message.type });
        },
        emitAssistantStream: async () => {},
        emitAssistantThinking: async () => {},
        debugChatMessage: () => {},
        writeDebug: () => {},
        writeDebugBlock: (scope, content) => {
          debugBlocks.push({ scope, content });
        },
        requestToolApproval: async () => 'allow',
        showWorkbenchError: () => {},
        shouldGateAssistantFinalMessage: () => false,
        getEffectiveConfig: () => DEFAULT_CONFIG,
        runValidationAndReviewFlow: async () => Object.freeze({ passed: true, repaired: false }),
        hasStreamingBuffers: () => false,
        clearStreamingBuffers: () => {},
        postInit: async () => {},
        buildContinueMessage: ({ attempt }) =>
          Object.freeze({
            id: `continue-test-${attempt}`,
            role: 'user' as const,
            content: 'continue',
            timestamp: Date.now(),
          }),
        tools: Object.freeze({
          revealFile: async () => {},
          refreshWorkspaceFiles: async () => {},
          openTrackedDiff: async () => ({ success: true, content: '' }),
          showProblems: async () => ({ success: true, content: '' }),
          workspaceSearch: async () => ({ success: true, content: '' }),
          findReferences: async () => ({ success: true, content: '' }),
          executeExtensionCommand: async () => ({ success: true, content: '' }),
          invokeLanguageModelTool: async () => ({ success: true, content: '' }),
          searchExtensionTools: async () => ({ success: true, content: '' }),
          activateExtensionTools: async () => ({ success: true, content: '' }),
          getLatestTestFailure: async () => ({ success: true, content: '' }),
          getLatestReviewFindings: async () => ({ success: true, content: '' }),
          getNextReviewFinding: async () => ({ success: true, content: '' }),
          dismissReviewFinding: async () => ({ success: true, content: '' }),
          onProjectCommandStart: () => {},
          onProjectCommandChunk: () => {},
          onProjectCommandEnd: () => {},
          onProjectCommandComplete: async () => {},
        }),
      });

      const payload = Object.freeze({
        content: '',
        tokens: 0,
        entryCount: 0,
        readPlanProgressItems: Object.freeze([
          Object.freeze({
            label: 'read_file src/app/page.tsx',
            confirmed: true,
            status: 'confirmed' as const,
            targetPath: 'src/app/page.tsx',
            tool: 'read_file' as const,
          }),
        ]),
        confirmedReadCount: 1,
        manualPlanningContent: '[MANUAL PLANNING HINTS]\nStart with targeted reads: read_file(src/app/page.tsx)',
        manualReadBatchItems: Object.freeze(['read_file src/app/page.tsx — inspect handler']),
        focusSymbols: Object.freeze(['handleSubmit']),
        readPlanProgressContent: '[READ PLAN PROGRESS]',
        retrievalLifecycleContent: '[RETRIEVAL LIFECYCLE]',
        antiLoopGuardrailsContent: '[ANTI-LOOP]',
        workflowRereadGuard: Object.freeze({
          enabled: false,
          candidatePaths: Object.freeze([]),
          entryCount: 0,
          queryText: 'test',
        }),
      });

      await callbacks.onEvidenceContext('turn', payload);
      await callbacks.onEvidenceContext('turn', payload);

      assert.strictEqual(postedMessages.filter((message) => message.type === 'evidence-context').length, 1);
      assert.strictEqual(debugBlocks.filter((block) => block.scope === 'manual-read-plan').length, 1);
      assert.strictEqual(logs.filter((text) => text.startsWith('Manual read plan:')).length, 1);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('host chat runtime callbacks only re-log read-plan progress when progress actually changes', async () => {
    const workspacePath = createTempWorkspace();
    const historyManager: HistoryManager = createHistoryManager({ workspacePath });
    const postedMessages: Array<{ type: string }> = [];
    const debugBlocks: Array<{ scope: string; content: string }> = [];
    const logs: string[] = [];

    try {
      const callbacks = createHostChatRuntimeCallbacks({
        workspacePath,
        historyManager,
        addMessage: async () => {},
        appendLog: (_kind, text) => {
          logs.push(text);
        },
        setStatusText: () => {},
        reportProgress: () => {},
        postRunState: async () => {},
        postMessage: async (message) => {
          postedMessages.push({ type: message.type });
        },
        emitAssistantStream: async () => {},
        emitAssistantThinking: async () => {},
        debugChatMessage: () => {},
        writeDebug: () => {},
        writeDebugBlock: (scope, content) => {
          debugBlocks.push({ scope, content });
        },
        requestToolApproval: async () => 'allow',
        showWorkbenchError: () => {},
        shouldGateAssistantFinalMessage: () => false,
        getEffectiveConfig: () => DEFAULT_CONFIG,
        runValidationAndReviewFlow: async () => Object.freeze({ passed: true, repaired: false }),
        hasStreamingBuffers: () => false,
        clearStreamingBuffers: () => {},
        postInit: async () => {},
        buildContinueMessage: ({ attempt }) =>
          Object.freeze({
            id: `continue-test-${attempt}`,
            role: 'user' as const,
            content: 'continue',
            timestamp: Date.now(),
          }),
        tools: Object.freeze({
          revealFile: async () => {},
          refreshWorkspaceFiles: async () => {},
          openTrackedDiff: async () => ({ success: true, content: '' }),
          showProblems: async () => ({ success: true, content: '' }),
          workspaceSearch: async () => ({ success: true, content: '' }),
          findReferences: async () => ({ success: true, content: '' }),
          executeExtensionCommand: async () => ({ success: true, content: '' }),
          invokeLanguageModelTool: async () => ({ success: true, content: '' }),
          searchExtensionTools: async () => ({ success: true, content: '' }),
          activateExtensionTools: async () => ({ success: true, content: '' }),
          getLatestTestFailure: async () => ({ success: true, content: '' }),
          getLatestReviewFindings: async () => ({ success: true, content: '' }),
          getNextReviewFinding: async () => ({ success: true, content: '' }),
          dismissReviewFinding: async () => ({ success: true, content: '' }),
          onProjectCommandStart: () => {},
          onProjectCommandChunk: () => {},
          onProjectCommandEnd: () => {},
          onProjectCommandComplete: async () => {},
        }),
      });

      const basePayload = Object.freeze({
        content: '',
        tokens: 0,
        entryCount: 0,
        readPlanProgressItems: Object.freeze([
          Object.freeze({
            label: 'read_file src/app/page.tsx',
            confirmed: true,
            status: 'confirmed' as const,
            targetPath: 'src/app/page.tsx',
            tool: 'read_file' as const,
          }),
        ]),
        confirmedReadCount: 1,
        manualPlanningContent: '[MANUAL PLANNING HINTS]\nStart with targeted reads: read_file(src/app/page.tsx)',
        manualReadBatchItems: Object.freeze(['read_file src/app/page.tsx — inspect handler']),
        focusSymbols: Object.freeze(['handleSubmit']),
        readPlanProgressContent: '[READ PLAN PROGRESS]',
        retrievalLifecycleContent: '[RETRIEVAL LIFECYCLE]',
        antiLoopGuardrailsContent: '[ANTI-LOOP]',
        evidenceReuseContent: '[REUSE]',
        workflowRereadGuard: Object.freeze({
          enabled: false,
          candidatePaths: Object.freeze([]),
          entryCount: 0,
          queryText: 'test',
        }),
      });

      const changedOnlyGuardrailsPayload = Object.freeze({
        ...basePayload,
        antiLoopGuardrailsContent: '[ANTI-LOOP UPDATED]',
      });

      await callbacks.onEvidenceContext('turn', basePayload);
      await callbacks.onEvidenceContext('turn', changedOnlyGuardrailsPayload);

      assert.strictEqual(postedMessages.filter((message) => message.type === 'evidence-context').length, 2);
      assert.strictEqual(debugBlocks.filter((block) => block.scope === 'manual-read-plan').length, 1);
      assert.strictEqual(logs.filter((text) => text.startsWith('Manual read plan:')).length, 1);
      assert.strictEqual(logs.filter((text) => text.startsWith('Read plan progress:')).length, 1);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('documentation-only session files skip blocking review and validation', async () => {
    assert.strictEqual(
      isDocumentationOnlySessionFiles([
        { filePath: '/tmp/README.md' },
        { filePath: '/tmp/docs/guide.mdx' },
      ]),
      true,
    );
    assert.strictEqual(
      isDocumentationOnlySessionFiles([
        { filePath: '/tmp/README.md' },
        { filePath: '/tmp/src/index.ts' },
      ]),
      false,
    );

    const workspacePath = createTempWorkspace();
    const readmePath = path.join(workspacePath, 'README.md');
    fs.writeFileSync(readmePath, '# doc only\n', 'utf-8');
    captureOriginal(readmePath);
    trackFileWrite(readmePath);
    const logs: string[] = [];

    try {
      const result = await runValidationAndReviewFlow({
        workspacePath,
        projectStorage: getProjectStorageInfo(workspacePath),
        agentType: 'manual',
        callbacks: {
          getEffectiveConfig: () => DEFAULT_CONFIG,
          updateStatus: async () => {},
          appendLog: (_kind, text) => {
            logs.push(text);
          },
          updateQualityDetails: () => {},
          persistProjectMetaPatch: () => {},
          addMessage: async () => {},
          runInternalRepairTurn: async () => Object.freeze({ hadError: false, filesWritten: Object.freeze([]) }),
          emitCommandStreamStart: async () => {},
          emitCommandStreamChunk: async () => {},
          emitCommandStreamEnd: async () => {},
        },
      });

      assert.deepStrictEqual(result, Object.freeze({ passed: true, repaired: false }));
      assert.strictEqual(logs.some((text) => text.includes('documentation files only')), true);
    } finally {
      clearSession();
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('background command completion records context without starting an automatic repair turn', async () => {
    const workspacePath = createTempWorkspace();
    const commandContextPath = path.join(workspacePath, 'context.json');
    const logs: string[] = [];
    let repairCalls = 0;
    let validationCalls = 0;
    const completions: BackgroundCommandCompletion[] = [
      Object.freeze({
        toolCallId: 'tool-1',
        commandText: 'echo done',
        cwd: workspacePath,
        exitCode: 0,
        success: true,
        durationMs: 25,
        output: 'done',
        background: true,
      }),
    ];

    try {
      await flushBackgroundCommandCompletions({
        commandContextPath,
        appendLog: (_kind, text) => {
          logs.push(text);
        },
        asWorkspaceRelative: (filePath) => path.relative(workspacePath, filePath),
        getIsRunning: () => false,
        getBackgroundCompletionRunning: () => false,
        setBackgroundCompletionRunning: () => {},
        getPendingBackgroundCompletions: () => completions,
        setPendingBackgroundCompletions: (next) => {
          completions.splice(0, completions.length, ...next);
        },
        setStatusText: () => {},
        reportProgress: () => {},
        postRunState: async () => {},
        getEffectiveConfig: () => DEFAULT_CONFIG,
        getSelectedAgent: (): AgentType => 'manual',
        runInternalRepairTurn: async () => {
          repairCalls += 1;
          return Object.freeze({ hadError: false, filesWritten: Object.freeze([]) });
        },
        runValidationAndReviewFlow: async () => {
          validationCalls += 1;
          return Object.freeze({ passed: true, repaired: false });
        },
      });

      assert.strictEqual(repairCalls, 0);
      assert.strictEqual(validationCalls, 0);
      assert.strictEqual(fs.existsSync(commandContextPath), true);
      assert.strictEqual(
        logs.some((text) => text.includes('No automatic repair turn was started')),
        true,
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
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

  test('editFileTool rejects ambiguous replacements and only replaces all when requested', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'duplicate.ts');
      fs.writeFileSync(
        filePath,
        ['const label = "draft";', 'console.log("draft");', ''].join('\n'),
        'utf-8',
      );

      const ambiguous = editFileTool(
        workspacePath,
        'src/duplicate.ts',
        '"draft"',
        '"published"',
      );
      assert.strictEqual(ambiguous.success, false);
      assert.match(ambiguous.error ?? '', /appears 2 times/i);

      const replaced = editFileTool(
        workspacePath,
        'src/duplicate.ts',
        '"draft"',
        '"published"',
        true,
      );
      assert.strictEqual(replaced.success, true);
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        ['const label = "published";', 'console.log("published");', ''].join('\n'),
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('editFileRangeTool replaces the exact range without leaving duplicate old lines', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'range.ts');
      fs.writeFileSync(
        filePath,
        [
          'const count = 1;',
          'const status = "draft";',
          'console.log(status);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = editFileRangeTool(workspacePath, 'src/range.ts', {
        startLine: 2,
        endLine: 2,
        newContent: 'const status = "published";',
        expectedTotalLines: 4,
        expectedRangeContent: 'const status = "draft";',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        [
          'const count = 1;',
          'const status = "published";',
          'console.log(status);',
          '',
        ].join('\n'),
      );
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf-8').includes('const status = "draft";'),
        false,
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('insertFileAtLineTool inserts once at the anchored location and rejects stale anchors', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'insert.ts');
      fs.writeFileSync(
        filePath,
        ['const first = 1;', 'const third = 3;', ''].join('\n'),
        'utf-8',
      );

      const stale = insertFileAtLineTool(workspacePath, 'src/insert.ts', {
        line: 2,
        contentToInsert: 'const second = 2;',
        expectedTotalLines: 3,
        anchorBefore: 'const wrong = 0;',
        anchorAfter: 'const third = 3;',
      });
      assert.strictEqual(stale.success, false);
      assert.match(stale.error ?? '', /no longer matches the last read snapshot/i);

      const inserted = insertFileAtLineTool(workspacePath, 'src/insert.ts', {
        line: 2,
        contentToInsert: 'const second = 2;',
        expectedTotalLines: 3,
        anchorBefore: 'const first = 1;',
        anchorAfter: 'const third = 3;',
      });
      assert.strictEqual(inserted.success, true);
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        ['const first = 1;', 'const second = 2;', 'const third = 3;', ''].join('\n'),
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('editFileRangeTool relocates stale line numbers when exact snapshot content still matches uniquely', () => {
    const workspacePath = createTempWorkspace();
    const filePath = path.join(workspacePath, 'src/ContractPage.tsx');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        [
          '// prepended later',
          "import { formatDate } from './date';",
          '',
          'export function ContractPage() {',
        "  const display = formatDate('2026-03-22');",
        '  return <span>{display}</span>;',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = editFileRangeTool(workspacePath, 'src/ContractPage.tsx', Object.freeze({
      startLine: 3,
      endLine: 5,
      newContent: [
        'export function ContractPage() {',
        "  const display = formatDateUrD('2026-03-22');",
        '  return <span>{display}</span>;',
        '}',
      ].join('\n'),
      expectedTotalLines: 6,
      expectedRangeContent: [
        'export function ContractPage() {',
        "  const display = formatDate('2026-03-22');",
        '  return <span>{display}</span>;',
      ].join('\n'),
      anchorBefore: '',
      anchorAfter: '}',
    }));

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.meta as { relocated?: boolean } | undefined)?.relocated, true);
    const updated = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(updated.includes("formatDateUrD('2026-03-22')"), true);
    assert.strictEqual(updated.includes("formatDate('2026-03-22')"), false);

    cleanupTempWorkspace(workspacePath);
  });

  test('insertFileAtLineTool relocates insertion points when anchors still match after line shifts', () => {
    const workspacePath = createTempWorkspace();
    const filePath = path.join(workspacePath, 'src/ContractPage.tsx');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        '// prepended later',
        "import { oldHelper } from './old-helper';",
        '',
        'export function ContractPage() {',
        '  return null;',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = insertFileAtLineTool(workspacePath, 'src/ContractPage.tsx', Object.freeze({
      line: 1,
      contentToInsert: "import { formatDateUrD } from './date';",
      expectedTotalLines: 5,
      anchorBefore: '',
      anchorAfter: "import { oldHelper } from './old-helper';",
    }));

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.meta as { relocated?: boolean } | undefined)?.relocated, true);
    const updatedLines = fs.readFileSync(filePath, 'utf-8').split('\n');
    assert.strictEqual(updatedLines[1], "import { formatDateUrD } from './date';");

    cleanupTempWorkspace(workspacePath);
  });

  test('multiEditFileRangesTool relocates multiple stale ranges using exact snapshot evidence', () => {
    const workspacePath = createTempWorkspace();
    const filePath = path.join(workspacePath, 'src/ContractPage.tsx');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        '// prepended later',
        "import { formatDate } from './date';",
        '',
        'function formatContractDate(value: string) {',
        '  return formatDate(value);',
        '}',
        '',
        'export function ContractPage() {',
        "  const display = formatContractDate('2026-03-22');",
        '  return <span>{display}</span>;',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = multiEditFileRangesTool(
      workspacePath,
      'src/ContractPage.tsx',
      Object.freeze([
        Object.freeze({
          start_line: 1,
          end_line: 1,
          new_content: "import { formatDateUrD } from './date';",
          expected_range_content: "import { formatDate } from './date';",
          anchor_before: '// prepended later',
          anchor_after: '',
        }),
        Object.freeze({
          start_line: 7,
          end_line: 7,
          new_content: "  const display = formatDateUrD('2026-03-22');",
          expected_range_content: "  const display = formatContractDate('2026-03-22');",
          anchor_before: 'export function ContractPage() {',
          anchor_after: '  return <span>{display}</span>;',
        }),
      ]),
      10,
    );

    assert.strictEqual(result.success, true);
    const updated = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(updated.includes("import { formatDateUrD } from './date';"), true);
    assert.strictEqual(updated.includes("  const display = formatDateUrD('2026-03-22');"), true);

    cleanupTempWorkspace(workspacePath);
  });

  test('multiEditFileRangesTool applies disjoint edits without overlap or duplicated remnants', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'multi.ts');
      fs.writeFileSync(
        filePath,
        [
          'const first = "a";',
          'const second = "b";',
          'const third = "c";',
          'console.log(first, second, third);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const overlap = multiEditFileRangesTool(
        workspacePath,
        'src/multi.ts',
        [
          { start_line: 1, end_line: 2, new_content: 'const first = "x";', expected_range_content: ['const first = "a";', 'const second = "b";'].join('\n') },
          { start_line: 2, end_line: 3, new_content: 'const second = "y";', expected_range_content: ['const second = "b";', 'const third = "c";'].join('\n') },
        ],
        5,
      );
      assert.strictEqual(overlap.success, false);
      assert.match(overlap.error ?? '', /overlapping edit ranges/i);

      const applied = multiEditFileRangesTool(
        workspacePath,
        'src/multi.ts',
        [
          {
            start_line: 1,
            end_line: 1,
            new_content: 'const first = "x";',
            expected_range_content: 'const first = "a";',
          },
          {
            start_line: 3,
            end_line: 3,
            new_content: 'const third = "z";',
            expected_range_content: 'const third = "c";',
          },
        ],
        5,
      );
      assert.strictEqual(applied.success, true);
      assert.strictEqual(
        fs.readFileSync(filePath, 'utf-8'),
        [
          'const first = "x";',
          'const second = "b";',
          'const third = "z";',
          'console.log(first, second, third);',
          '',
        ].join('\n'),
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('writeFileTool creates a new file and refuses to overwrite an existing file', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const created = writeFileTool(workspacePath, 'src/new-file.ts', 'export const created = true;\n');
      assert.strictEqual(created.success, true);
      assert.match(created.content, /Written/i);

      const duplicate = writeFileTool(workspacePath, 'src/new-file.ts', 'export const created = false;\n');
      assert.strictEqual(duplicate.success, false);
      assert.match(duplicate.error ?? '', /Refusing to overwrite existing file/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('readFileTool caches partial reads and head/tail return the expected slices', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'sample.txt');
      const content = [
        'line-1',
        'line-2',
        'line-3',
        'line-4',
        'line-5',
        'line-6',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, content, 'utf-8');

      const firstRead = readFileTool(workspacePath, 'src/sample.txt', { maxLines: 2, offset: 1 });
      assert.strictEqual(firstRead.success, true);
      assert.strictEqual(firstRead.meta?.cacheHit, false);
      assert.match(firstRead.content, /line-2/);
      assert.match(firstRead.content, /\[\.\.\. 4 more lines\]/);

      const secondRead = readFileTool(workspacePath, 'src/sample.txt', { maxLines: 2, offset: 1 });
      assert.strictEqual(secondRead.success, true);
      assert.strictEqual(secondRead.meta?.cacheHit, true);

      const head = headTool(workspacePath, 'src/sample.txt', 2);
      assert.strictEqual(head.content, ['line-1', 'line-2', '[... 5 more lines]'].join('\n'));

      const tail = tailTool(workspacePath, 'src/sample.txt', 2);
      assert.strictEqual(tail.content, ['line-6', ''].join('\n'));
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('grepTool and listDirTool return focused workspace results without hidden noise', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, '.hidden'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'alpha.ts'),
        ['export const token = "alpha";', 'console.log(token);', ''].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'nested', 'beta.ts'),
        ['export const token = "beta";', 'console.log(token);', ''].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(path.join(workspacePath, '.hidden', 'secret.ts'), 'export const token = "secret";\n', 'utf-8');

      const grep = grepTool(workspacePath, 'token', 'src', { contextLines: 0 });
      assert.strictEqual(grep.success, true);
      assert.match(grep.content, /src\/alpha\.ts:1/);
      assert.match(grep.content, /src\/nested\/beta\.ts:1/);
      assert.strictEqual(grep.content.includes('.hidden'), false);

      const listing = listDirTool(workspacePath, '.', { depth: 1 });
      assert.strictEqual(listing.success, true);
      assert.match(listing.content, /src\//);
      assert.match(listing.content, /  nested\//);
      assert.strictEqual(listing.content.includes('.hidden'), false);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('validateCodeTool validates JSON files and reports malformed JSON clearly', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'config'), { recursive: true });
      const goodPath = path.join(workspacePath, 'config', 'valid.json');
      const badPath = path.join(workspacePath, 'config', 'invalid.json');
      fs.writeFileSync(goodPath, JSON.stringify({ ok: true }, null, 2), 'utf-8');
      fs.writeFileSync(badPath, '{ "broken": true,, }', 'utf-8');

      const valid = validateCodeTool(goodPath);
      assert.strictEqual(valid.success, true);
      assert.match(valid.content, /Valid JSON/i);

      const invalid = validateCodeTool(badPath);
      assert.strictEqual(invalid.success, false);
      assert.match(invalid.error ?? '', /Validation failed/i);
      assert.match(invalid.content, /JSON|Unexpected token|position/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('tool definitions honor capability toggles and discovered extension tools', () => {
    const config: GalaxyConfig = {
      ...DEFAULT_CONFIG,
      toolCapabilities: {
        ...DEFAULT_CONFIG.toolCapabilities,
        webResearch: false,
      },
      toolToggles: {
        ...DEFAULT_CONFIG.toolToggles,
        read_file: true,
        grep: true,
      },
      extensionToolToggles: {
        ...DEFAULT_CONFIG.extensionToolToggles,
        open_diff_tool: true,
      },
      availableExtensionToolGroups: [
        {
          extensionId: 'sample.extension',
          label: 'Sample Extension',
          description: 'Sample extension-contributed tools.',
          version: '1.0.0',
          source: 'mcp_curated',
          tools: [
            {
              key: 'open_diff_tool',
              title: 'Open Diff',
              description: 'Open a diff view.',
              runtimeName: 'sample_open_diff',
              tags: ['diff'],
              invocation: 'command',
              commandId: 'sample.openDiff',
            },
          ],
        },
      ],
    };

    assert.strictEqual(isToolEnabled('read_file', config), true);
    assert.strictEqual(isToolEnabled('search_web', config), false);
    assert.ok(findDiscoveredExtensionTool(config, 'sample_open_diff'));

    const definitions = getEnabledToolDefinitions(config);
    const names = definitions.map((definition) => definition.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.includes('search_web'));
    assert.ok(names.includes('sample_open_diff'));
  });

  test('executeToolAsync dispatches read/write/list helpers through the shared tool context', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      let refreshCalls = 0;
      const toolContext = {
        workspaceRoot: workspacePath,
        config: DEFAULT_CONFIG,
        revealFile: async () => undefined,
        refreshWorkspaceFiles: async () => {
          refreshCalls += 1;
        },
      };

      const writeResult = await executeToolAsync(
        {
          name: 'write_file',
          params: {
            path: 'src/dispatched.ts',
            content: 'export const dispatched = true;\n',
          },
        },
        toolContext,
      );
      assert.strictEqual(writeResult.success, true);
      assert.strictEqual(refreshCalls, 1);

      const readResult = await executeToolAsync(
        {
          name: 'read_file',
          params: {
            path: 'src/dispatched.ts',
            maxLines: 10,
            offset: 0,
          },
        },
        toolContext,
      );
      assert.strictEqual(readResult.success, true);
      assert.match(readResult.content, /dispatched = true/);

      const listResult = await executeToolAsync(
        {
          name: 'list_dir',
          params: {
            path: 'src',
            depth: 0,
          },
        },
        toolContext,
      );
      assert.strictEqual(listResult.success, true);
      assert.match(listResult.content, /dispatched\.ts/);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('runProjectCommandTool executes a direct finite command and captures its output', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const result = await runProjectCommandTool(
        workspacePath,
        'node -e "console.log(\'project-command-ok\')"',
      );

      assert.strictEqual(result.success, true);
      assert.match(String(result.meta?.tailOutput ?? ''), /project-command-ok/);
      assert.strictEqual(result.meta?.background, undefined);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('runProjectCommandTool resolves detected project-command ids from workspace profile', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(workspacePath, 'package.json'),
        JSON.stringify(
          {
            name: 'command-profile-app',
            scripts: {
              build: 'node -e "console.log(\'profile-build-ok\')"',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runProjectCommandTool(workspacePath, 'npm-build');
      assert.strictEqual(result.success, true);
      assert.match(String(result.meta?.commandText ?? ''), /npm run build/);
      assert.match(String(result.meta?.tailOutput ?? ''), /profile-build-ok/);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('runProjectCommandTool marks async handoff commands as background running instead of completed', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const result = await runProjectCommandTool(
        workspacePath,
        'node -e "setTimeout(() => console.log(\'background-finish\'), 250)"',
        { asyncStartOnly: true },
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.meta?.background, true);
      assert.strictEqual(result.meta?.running, true);
      assert.strictEqual(result.meta?.commandState, 'running');
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('managed project commands can be started, inspected, awaited, and cleaned up', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const started = startManagedCommandTool(
        workspacePath,
        'node -e "console.log(\'managed-start\'); setTimeout(() => console.log(\'managed-end\'), 50)"',
      );
      assert.strictEqual(started.success, true);
      const commandId = String(started.meta?.commandId ?? '');
      assert.ok(commandId);

      const outputWhileRunning = getManagedProjectCommandOutputTool(commandId, { maxChars: 2000 });
      assert.strictEqual(outputWhileRunning.success, true);

      const completed = await awaitManagedProjectCommandTool(commandId, { timeoutMs: 4000, maxChars: 2000 });
      assert.strictEqual(completed.success, true);
      assert.match(String(completed.meta?.tailOutput ?? ''), /managed-start/);
      assert.match(String(completed.meta?.tailOutput ?? ''), /managed-end/);

      const killAfterDone = killManagedProjectCommandTool(commandId);
      assert.strictEqual(killAfterDone.success, true);
      assert.match(killAfterDone.content, /already completed/i);
    } finally {
      managedCommands.clear();
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('managed command await reports running state before completion', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const started = startManagedCommandTool(
        workspacePath,
        'node -e "setTimeout(() => console.log(\'late-finish\'), 300)"',
      );
      assert.strictEqual(started.success, true);
      const commandId = String(started.meta?.commandId ?? '');

      const pending = await awaitManagedProjectCommandTool(commandId, { timeoutMs: 10, maxChars: 1000 });
      assert.strictEqual(pending.success, true);
      assert.strictEqual(pending.meta?.running, true);

      const completed = await awaitManagedProjectCommandTool(commandId, { timeoutMs: 4000, maxChars: 1000 });
      assert.strictEqual(completed.success, true);
      assert.match(String(completed.meta?.tailOutput ?? ''), /late-finish/);
    } finally {
      managedCommands.clear();
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('managed command helpers can resolve the sole running command even when the model passes an imprecise id', async () => {
    const workspacePath = createTempWorkspace();
    try {
      const started = startManagedCommandTool(
        workspacePath,
        'node -e "setTimeout(() => console.log(\'fallback-finish\'), 200)"',
        { toolCallId: 'tool-call-fallback' },
      );
      assert.strictEqual(started.success, true);

      const pendingByToolCallId = await awaitManagedProjectCommandTool('tool-call-fallback', { timeoutMs: 10, maxChars: 1000 });
      assert.strictEqual(pendingByToolCallId.success, true);
      assert.strictEqual(pendingByToolCallId.meta?.running, true);

      const completedByUnknownAlias = await awaitManagedProjectCommandTool('4', { timeoutMs: 4000, maxChars: 1000 });
      assert.strictEqual(completedByUnknownAlias.success, true);
      assert.match(String(completedByUnknownAlias.meta?.tailOutput ?? ''), /fallback-finish/);
    } finally {
      managedCommands.clear();
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('gitStatusTool and gitDiffTool report repository state for a temp git workspace', async () => {
    const workspacePath = createTempGitWorkspace();
    try {
      fs.writeFileSync(path.join(workspacePath, 'tracked.ts'), 'export const value = 1;\n', 'utf-8');

      const status = await gitStatusTool(workspacePath, { short: true });
      assert.strictEqual(status.success, true);
      assert.match(status.content, /tracked\.ts/);

      const diff = await gitDiffTool(workspacePath, { pathspec: 'tracked.ts' });
      assert.strictEqual(diff.success, true);
      assert.match(String(diff.meta?.commandLabel ?? ''), /git diff/);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('gitAddTool and gitCommitTool stage and commit changes in a temp repo', async () => {
    const workspacePath = createTempGitWorkspace();
    try {
      fs.writeFileSync(path.join(workspacePath, 'commit.ts'), 'export const version = 1;\n', 'utf-8');

      const addResult = await gitAddTool(workspacePath, ['commit.ts']);
      assert.strictEqual(addResult.success, true);

      const stagedStatus = execSync('git status --short', { cwd: workspacePath, encoding: 'utf-8' });
      assert.match(stagedStatus, /A\s+commit\.ts/);

      const commitResult = await gitCommitTool(workspacePath, 'Add commit fixture');
      assert.strictEqual(commitResult.success, true);
      assert.match(commitResult.content, /Add commit fixture|1 file changed/i);

      const log = execSync('git log --oneline -1', { cwd: workspacePath, encoding: 'utf-8' });
      assert.match(log, /Add commit fixture/);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('gitCheckoutTool can create and switch to a new branch', async () => {
    const workspacePath = createTempGitWorkspace();
    try {
      fs.writeFileSync(path.join(workspacePath, 'branch.ts'), 'export const branchValue = 1;\n', 'utf-8');
      execSync('git add branch.ts && git commit -m "seed branch repo"', { cwd: workspacePath, stdio: 'ignore' });

      const checkoutResult = await gitCheckoutTool(workspacePath, 'feature/test-branch', { createBranch: true });
      assert.strictEqual(checkoutResult.success, true);
      assert.match(checkoutResult.content, /Switched to a new branch|switched to branch/i);
      assert.strictEqual(getCurrentGitBranch(workspacePath), 'feature/test-branch');
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('gitPushTool and gitPullTool work with a local bare remote', async function () {
    this.timeout(10000);
    const remotePath = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-git-remote-'));
    const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-git-clone-'));
    const workspacePath = createTempGitWorkspace();
    try {
      execSync('git init --bare', { cwd: remotePath, stdio: 'ignore' });
      execSync(`git remote add origin "${remotePath}"`, { cwd: workspacePath, stdio: 'ignore' });

      fs.writeFileSync(path.join(workspacePath, 'shared.ts'), 'export const shared = 1;\n', 'utf-8');
      execSync('git add shared.ts && git commit -m "initial commit"', { cwd: workspacePath, stdio: 'ignore' });
      const currentBranch = getCurrentGitBranch(workspacePath);

      const pushResult = await gitPushTool(workspacePath, { remote: 'origin', branch: currentBranch });
      assert.strictEqual(pushResult.success, true);

      execSync(`git clone "${remotePath}" "${clonePath}"`, { stdio: 'ignore' });
      execSync('git config user.name "Galaxy Clone"', { cwd: clonePath, stdio: 'ignore' });
      execSync('git config user.email "galaxy-clone@example.com"', { cwd: clonePath, stdio: 'ignore' });
      fs.writeFileSync(path.join(clonePath, 'shared.ts'), 'export const shared = 2;\n', 'utf-8');
      execSync('git add shared.ts && git commit -m "remote update"', { cwd: clonePath, stdio: 'ignore' });
      execSync(`git push origin ${currentBranch}`, { cwd: clonePath, stdio: 'ignore' });

      const pullResult = await gitPullTool(workspacePath, { remote: 'origin', branch: currentBranch });
      assert.strictEqual(pullResult.success, true);
      assert.match(fs.readFileSync(path.join(workspacePath, 'shared.ts'), 'utf-8'), /shared = 2/);
    } finally {
      fs.rmSync(remotePath, { recursive: true, force: true });
      fs.rmSync(clonePath, { recursive: true, force: true });
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('gitPushTool and gitPullTool surface actionable failures when no remote is configured', async () => {
    const workspacePath = createTempGitWorkspace();
    try {
      fs.writeFileSync(path.join(workspacePath, 'lonely.ts'), 'export const lonely = true;\n', 'utf-8');
      execSync('git add lonely.ts && git commit -m "seed no-remote repo"', { cwd: workspacePath, stdio: 'ignore' });

      const pushResult = await gitPushTool(workspacePath, { remote: 'origin', branch: getCurrentGitBranch(workspacePath) });
      assert.strictEqual(pushResult.success, false);
      assert.match(pushResult.error ?? '', /git push failed/i);
      assert.match(String(pushResult.content), /origin|No configured push destination|does not appear to be a git repository/i);

      const pullResult = await gitPullTool(workspacePath, { remote: 'origin', branch: getCurrentGitBranch(workspacePath) });
      assert.strictEqual(pullResult.success, false);
      assert.match(pullResult.error ?? '', /git pull failed/i);
      assert.match(String(pullResult.content), /origin|does not appear to be a git repository|Could not read from remote repository/i);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('tokenizeDirectCommandText keeps quoted Windows-like arguments and rejects shell operators', () => {
    assert.deepStrictEqual(
      tokenizeDirectCommandText('git checkout "src/pages/Customer Info.tsx"'),
      ['git', 'checkout', 'src/pages/Customer Info.tsx'],
    );
    assert.strictEqual(tokenizeDirectCommandText('npm run build && npm test'), null);
  });

  test('buildShellEnvironment adds Windows-preferred PATH entries under win32 simulation', async () => {
    await withMockedPlatform('win32', async () => {
      const env = buildShellEnvironment({
        USERPROFILE: 'C:\\Users\\Galaxy',
        LOCALAPPDATA: 'C:\\Users\\Galaxy\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        PATH: 'C:\\Windows\\System32',
      });
      const pathValue = String(env.PATH ?? '');
      assert.match(pathValue, /Git[\\/]+cmd/i);
      assert.match(pathValue, /scoop[\\/]+shims/i);
      assert.match(pathValue, /Windows[\\/]+System32/i);
    });
  });

  test('resolveShellProfile falls back to cmd under win32 simulation when PowerShell is unavailable', async () => {
    await withMockedPlatform('win32', async () => {
      const profile = resolveShellProfile();
      assert.strictEqual(profile.kind, 'cmd');
      assert.match(profile.executable.toLowerCase(), /cmd(\.exe)?/);
      assert.deepStrictEqual(profile.commandArgs('echo hello'), ['/d', '/s', '/c', 'echo hello']);
    });
  });

  test('resolveCommandBinary resolves relative .cmd paths under win32 simulation', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'scripts'), { recursive: true });
      const scriptPath = path.join(workspacePath, 'scripts', 'test.cmd');
      fs.writeFileSync(scriptPath, '@echo off\r\necho ok\r\n', 'utf-8');

      await withMockedPlatform('win32', async () => {
        const resolved = resolveCommandBinary('./scripts/test.cmd', workspacePath);
        assert.strictEqual(resolved, scriptPath);
      });
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('debugChatMessage logs explicit running state for background tool messages', () => {
    const debugLogPath = path.join(createTempWorkspace(), 'debug.log');
    try {
      debugChatMessage(debugLogPath, 'manual', Object.freeze({
        id: 'tool-running',
        role: 'tool',
        content: 'Command started.',
        timestamp: Date.now(),
        toolName: 'run_terminal_command',
        toolSuccess: true,
        toolCallId: 'call-running',
        toolMeta: Object.freeze({
          background: true,
          running: true,
          commandState: 'running',
        }),
      }));

      const log = fs.readFileSync(debugLogPath, 'utf-8');
      assert.match(log, /tool-message/);
      assert.match(log, /state=running/);
    } finally {
      cleanupTempWorkspace(path.dirname(debugLogPath));
    }
  });

  test('narrowManualPlanningScope keeps manual plan focused on the active file scope', () => {
    const scoped = narrowManualPlanningScope({
      scopedPaths: Object.freeze(['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']),
      primaryPaths: Object.freeze([
        'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
        'galaxy-code/src/theme.ts',
      ]),
      definitionPaths: Object.freeze([
        'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
        'galaxy-code/src/theme.ts',
      ]),
      referencePaths: Object.freeze([
        'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
        'galaxy-code/src/theme.ts',
      ]),
      primaryCandidates: Object.freeze([
        Object.freeze({
          relation: 'primary' as const,
          symbolName: 'DocsSection',
          filePath: 'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
          line: 120,
          description: 'DocsSection @ documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md:120',
        }),
        Object.freeze({
          relation: 'primary' as const,
          symbolName: 'ThemeConfig',
          filePath: 'galaxy-code/src/theme.ts',
          line: 10,
          description: 'ThemeConfig @ galaxy-code/src/theme.ts:10',
        }),
      ]),
      definitionCandidates: Object.freeze([
        Object.freeze({
          relation: 'definition' as const,
          symbolName: 'DocsDefinition',
          filePath: 'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
          line: 140,
          description: 'DocsDefinition @ documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md:140',
        }),
        Object.freeze({
          relation: 'definition' as const,
          symbolName: 'ThemeDefinition',
          filePath: 'galaxy-code/src/theme.ts',
          line: 20,
          description: 'ThemeDefinition @ galaxy-code/src/theme.ts:20',
        }),
      ]),
      referenceCandidates: Object.freeze([
        Object.freeze({
          relation: 'reference' as const,
          symbolName: 'DocsUsage',
          filePath: 'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
          line: 150,
          description: 'DocsUsage @ documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md:150',
        }),
        Object.freeze({
          relation: 'reference' as const,
          symbolName: 'ThemeUsage',
          filePath: 'galaxy-code/src/theme.ts',
          line: 30,
          description: 'ThemeUsage @ galaxy-code/src/theme.ts:30',
        }),
      ]),
      manualReadPlan: Object.freeze([
        Object.freeze({
          tool: 'read_file' as const,
          targetPath: 'documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md',
          line: 120,
          symbolName: 'DocsSection',
          reason: 'Inspect docs section',
        }),
        Object.freeze({
          tool: 'read_file' as const,
          targetPath: 'galaxy-code/src/theme.ts',
          line: 10,
          symbolName: 'ThemeConfig',
          reason: 'Inspect unrelated file',
        }),
      ]),
    });

    assert.deepStrictEqual(scoped.primaryPaths, ['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']);
    assert.deepStrictEqual(scoped.definitionPaths, ['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']);
    assert.deepStrictEqual(scoped.referencePaths, ['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']);
    assert.deepStrictEqual(scoped.primaryCandidates.map((candidate) => candidate.filePath), ['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']);
    assert.deepStrictEqual(scoped.manualReadPlan.map((step) => step.targetPath), ['documents/GALAXY_VSCODE_EXTENSION_DOCUMENTATION.md']);
  });

  test('shouldEmitManualPlanningHints suppresses repeated planning after confirmed reads without refresh needs', () => {
    assert.strictEqual(
      shouldEmitManualPlanningHints({
        confirmedReadCount: 2,
        pendingReadPlanCount: 3,
        refreshReadPathCount: 0,
        workingTurnFileCount: 4,
      }),
      false,
    );
    assert.strictEqual(
      shouldEmitManualPlanningHints({
        confirmedReadCount: 2,
        pendingReadPlanCount: 0,
        refreshReadPathCount: 1,
        workingTurnFileCount: 4,
      }),
      true,
    );
    assert.strictEqual(
      shouldEmitManualPlanningHints({
        confirmedReadCount: 0,
        pendingReadPlanCount: 2,
        refreshReadPathCount: 0,
        workingTurnFileCount: 0,
      }),
      true,
    );
  });

  test('galaxyDesignProjectInfoTool detects framework and package manager from package.json', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(workspacePath, 'package.json'),
        JSON.stringify(
          {
            name: 'design-app',
            packageManager: 'pnpm@9.0.0',
            dependencies: {
              react: '^19.0.0',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await galaxyDesignProjectInfoTool(workspacePath);
      assert.strictEqual(result.success, true);
      assert.match(result.content, /Framework: react/i);
      assert.match(result.content, /Package manager: pnpm \(package-json\)/i);
      assert.strictEqual(result.meta?.framework, 'react');
      assert.strictEqual(result.meta?.packageManager, 'pnpm');
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('multiEditFileRangesTool updates a TSX component fixture without leaving duplicated state blocks', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'pages', 'customer'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'pages', 'customer', 'CustomerInfoPage.tsx');
      fs.writeFileSync(
        filePath,
        [
          'import { useState } from "react";',
          '',
          'export function CustomerInfoPage() {',
          '  const [filterFullName, setFilterFullName] = useState("");',
          '  const [filterPhone, setFilterPhone] = useState("");',
          '  const [customers, setCustomers] = useState<string[]>([]);',
          '',
          '  return (',
          '    <section>',
          '      <button type="button">Search</button>',
          '    </section>',
          '  );',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = multiEditFileRangesTool(
        workspacePath,
        'src/pages/customer/CustomerInfoPage.tsx',
        [
          {
            start_line: 4,
            end_line: 5,
            new_content: [
              '  const [filterFullName, setFilterFullName] = useState("");',
              '  const [filterIdNumber, setFilterIdNumber] = useState("");',
              '  const [filterPhone, setFilterPhone] = useState("");',
            ].join('\n'),
            expected_range_content: [
              '  const [filterFullName, setFilterFullName] = useState("");',
              '  const [filterPhone, setFilterPhone] = useState("");',
            ].join('\n'),
          },
          {
            start_line: 10,
            end_line: 10,
            new_content: '      <button type="button">Search Customer</button>',
            expected_range_content: '      <button type="button">Search</button>',
          },
        ],
        14,
      );

      assert.strictEqual(result.success, true);
      const updated = fs.readFileSync(filePath, 'utf-8');
      assert.match(updated, /filterIdNumber/);
      assert.match(updated, /Search Customer/);
      assert.strictEqual(updated.match(/filterFullName/g)?.length ?? 0, 1);
      assert.strictEqual(updated.match(/filterPhone/g)?.length ?? 0, 1);
      assert.strictEqual(updated.match(/Search<\/button>/g)?.length ?? 0, 0);
      assert.strictEqual(updated.includes('const [filterPhone, setFilterPhone] = useState("");\n  const [filterPhone, setFilterPhone] = useState("");'), false);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('targeted edit tools reject stale snapshot variants without mutating the file', () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      const filePath = path.join(workspacePath, 'src', 'stale.ts');
      const original = [
        'const first = 1;',
        'const second = 2;',
        'const third = 3;',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, original, 'utf-8');

      const cases = [
        {
          label: 'range edit with stale expected_range_content',
          run: () => editFileRangeTool(workspacePath, 'src/stale.ts', {
            startLine: 2,
            endLine: 2,
            newContent: 'const second = 20;',
            expectedTotalLines: 4,
            expectedRangeContent: 'const second = 999;',
          }),
          pattern: /no longer matches the last read snapshot/i,
        },
        {
          label: 'range edit with stale anchor_after',
          run: () => editFileRangeTool(workspacePath, 'src/stale.ts', {
            startLine: 2,
            endLine: 2,
            newContent: 'const second = 20;',
            expectedTotalLines: 4,
            anchorBefore: 'const first = 1;',
            anchorAfter: 'const wrong = 0;',
          }),
          pattern: /no longer matches the last read snapshot/i,
        },
        {
          label: 'insert with stale anchor_before',
          run: () => insertFileAtLineTool(workspacePath, 'src/stale.ts', {
            line: 2,
            contentToInsert: 'const inserted = true;',
            expectedTotalLines: 4,
            anchorBefore: 'const missing = 0;',
            anchorAfter: 'const second = 2;',
          }),
          pattern: /no longer matches the last read snapshot/i,
        },
      ];

      for (const testCase of cases) {
        const result = testCase.run();
        assert.strictEqual(result.success, false, testCase.label);
        assert.match(result.error ?? '', testCase.pattern, testCase.label);
        assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), original, testCase.label);
      }
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

  test('workflow extractor builds component composition edges for frontend-only workspaces', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'app'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'components', 'ui'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            jsx: 'preserve',
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
            },
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'components', 'ui', 'button.tsx'),
        [
          "export function Button() {",
          "  return <button>Click</button>;",
          "}",
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'app', 'page.tsx'),
        [
          "import { Button } from '@/components/ui/button';",
          '',
          'export default function HomePage() {',
          '  return (',
          '    <main>',
          '      <Button />',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      const renderEdge = snapshot.edges.find((edge) => edge.edgeType === 'renders');
      assert.ok(renderEdge);
      assert.strictEqual(
        snapshot.nodes.some((node) => node.nodeType === 'screen'),
        true,
      );
      assert.strictEqual(
        snapshot.nodes.some((node) => node.nodeType === 'component'),
        true,
      );
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor ignores generated frontend output directories like .next', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'app'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, '.next', 'server', 'chunks'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            jsx: 'preserve',
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'app', 'page.tsx'),
        [
          'export default function HomePage() {',
          '  return <main>Hello</main>;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, '.next', 'server', 'chunks', 'runtime.js'),
        [
          'export function generatedRuntimeHelper() {',
          "  return 'generated';",
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.length > 0, true);
      assert.strictEqual(snapshot.nodes.every((node) => !(node.filePath ?? '').includes('.next/')), true);
      assert.strictEqual(
        snapshot.edges.every((edge) => !edge.fromNodeId.includes('.next/') && !edge.toNodeId.includes('.next/')),
        true,
      );
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Vue SFC composition edges for frontend-only workspaces', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'views'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'components'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'components', 'BaseButton.vue'),
        [
          '<template>',
          '  <button><slot /></button>',
          '</template>',
          '<script setup lang="ts">',
          'defineOptions({ name: "BaseButton" });',
          '</script>',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'views', 'HomeView.vue'),
        [
          '<template>',
          '  <main>',
          '    <BaseButton />',
          '  </main>',
          '</template>',
          '<script setup lang="ts">',
          'import BaseButton from "../components/BaseButton.vue";',
          'defineOptions({ name: "HomeView" });',
          '</script>',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'screen' && node.filePath === 'src/views/HomeView.vue'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'component' && node.filePath === 'src/components/BaseButton.vue'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'renders'), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Java Spring controller-service-repository flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'main', 'java', 'com', 'example'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'main', 'java', 'com', 'example', 'OrderRepository.java'),
        [
          'package com.example;',
          '',
          'import org.springframework.stereotype.Repository;',
          '',
          '@Repository',
          'public class OrderRepository {',
          '  public String findById(String id) {',
          '    return id;',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'main', 'java', 'com', 'example', 'OrderService.java'),
        [
          'package com.example;',
          '',
          'import org.springframework.stereotype.Service;',
          '',
          '@Service',
          'public class OrderService {',
          '  private final OrderRepository orderRepository;',
          '',
          '  public OrderService(OrderRepository orderRepository) {',
          '    this.orderRepository = orderRepository;',
          '  }',
          '',
          '  public String getOrder(String id) {',
          '    return orderRepository.findById(id);',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'main', 'java', 'com', 'example', 'OrderController.java'),
        [
          'package com.example;',
          '',
          'import org.springframework.web.bind.annotation.GetMapping;',
          'import org.springframework.web.bind.annotation.RequestMapping;',
          'import org.springframework.web.bind.annotation.RestController;',
          '',
          '@RestController',
          '@RequestMapping("/api/orders")',
          'public class OrderController {',
          '  private final OrderService orderService;',
          '',
          '  public OrderController(OrderService orderService) {',
          '    this.orderService = orderService;',
          '  }',
          '',
          '  @GetMapping("/{id}")',
          '  public String getOrder() {',
          '    return orderService.getOrder("1");',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'controller' && node.label === 'OrderController'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'backend_service' && node.label === 'OrderService'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'repository' && node.label === 'OrderRepository'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/api/orders/{id}'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls'), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds NestJS controller-service flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'orders'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'orders', 'orders.service.ts'),
        [
          'import { Injectable } from "@nestjs/common";',
          '',
          '@Injectable()',
          'export class OrdersService {',
          '  getOrder(id: string) {',
          '    return id;',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'orders', 'orders.controller.ts'),
        [
          'import { Controller, Get } from "@nestjs/common";',
          'import { OrdersService } from "./orders.service";',
          '',
          '@Controller("orders")',
          'export class OrdersController {',
          '  constructor(private readonly ordersService: OrdersService) {}',
          '',
          '  @Get(":id")',
          '  getOrder() {',
          '    return this.ordersService.getOrder("1");',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'controller' && node.label === 'OrdersController'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'backend_service' && node.label === 'OrdersService'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/orders/:id'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls'), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Express route-to-handler flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'controllers'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'services'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'services', 'orders-service.ts'),
        [
          'export async function loadOrderById(id: string) {',
          '  return { id };',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'controllers', 'orders.ts'),
        [
          'import { loadOrderById } from "../services/orders-service";',
          'export async function getOrderHandler() {',
          '  return loadOrderById("1");',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'routes', 'orders.ts'),
        [
          'import { getOrderHandler } from "../controllers/orders";',
          'declare const router: { get(path: string, handler: unknown): void };',
          'router.get("/api/orders/:id", getOrderHandler);',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/api/orders/:id'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /getOrderHandler/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls' && edge.toNodeId.includes('loadOrderById')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Python FastAPI route-to-function flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'app', 'orders.py'),
        [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/orders")',
          '',
          'def load_order(order_id: str):',
          '    return {"id": order_id}',
          '',
          '@router.get("/{order_id}")',
          'async def get_order(order_id: str):',
          '    return load_order(order_id)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/orders/{order_id}'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'get_order' && node.nodeType === 'controller'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'load_order'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /get_order/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls' && edge.toNodeId.includes('load_order')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Go route-to-handler flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'internal', 'service'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'internal', 'handler'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'internal', 'service', 'orders.go'),
        [
          'package service',
          '',
          'func LoadOrder(id string) string {',
          '  return id',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'internal', 'handler', 'orders.go'),
        [
          'package handler',
          '',
          'func GetOrderHandler() string {',
          '  return LoadOrder("1")',
          '}',
          '',
          'func RegisterRoutes() {',
          '  router.GET("/api/orders/:id", GetOrderHandler)',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/api/orders/:id'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'GetOrderHandler' && node.nodeType === 'controller'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'LoadOrder'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /GetOrderHandler/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls' && edge.toNodeId.includes('LoadOrder')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Tauri frontend-to-command flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src-tauri', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            jsx: 'preserve',
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'commands.ts'),
        [
          'export async function loadSettings() {',
          '  return invoke("load_settings");',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src-tauri', 'src', 'lib.rs'),
        [
          '#[tauri::command]',
          'fn load_settings() -> String {',
          '  "ok".to_string()',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'rpc_endpoint' && node.symbolName === 'load_settings'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'invokes_rpc' && /load_settings/.test(edge.label ?? '')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Electron renderer-to-main IPC flow graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'renderer'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'main'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'renderer', 'settings.ts'),
        [
          'export async function loadSettings() {',
          '  return ipcRenderer.invoke("settings:load");',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'main', 'ipc.ts'),
        [
          'export function registerIpc() {',
          '  ipcMain.handle("settings:load", async () => ({ theme: "dark" }));',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'rpc_endpoint' && node.symbolName === 'settings:load'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'invokes_rpc' && /settings:load/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /settings:load/.test(edge.label ?? '')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Flutter widget composition and navigation graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'lib', 'screens'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'lib', 'widgets'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'lib', 'widgets', 'order_card.dart'),
        [
          'import "package:flutter/widgets.dart";',
          '',
          'class OrderCard extends StatelessWidget {',
          '  @override',
          '  Widget build(BuildContext context) {',
          '    return Text("order");',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'lib', 'screens', 'orders_page.dart'),
        [
          'import "package:flutter/widgets.dart";',
          'import "../widgets/order_card.dart";',
          '',
          'class OrdersPage extends StatelessWidget {',
          '  @override',
          '  Widget build(BuildContext context) {',
          '    Navigator.pushNamed(context, "/orders/detail");',
          '    return Scaffold(',
          '      body: Column(',
          '        children: [OrderCard()],',
          '      ),',
          '    );',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'screen' && node.symbolName === 'OrdersPage'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'component' && node.symbolName === 'OrderCard'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'renders' && /OrderCard/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'navigates_to' && /orders\/detail/.test(edge.label ?? '')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Laravel route-controller-service graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'routes'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'app', 'Http', 'Controllers'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'app', 'Services'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'app', 'Services', 'OrderService.php'),
        [
          '<?php',
          'class OrderService {',
          '    public function getOrder() {',
          "        return ['id' => 1];",
          '    }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'app', 'Http', 'Controllers', 'OrderController.php'),
        [
          '<?php',
          'class OrderController {',
          '    public function __construct(private OrderService $orderService) {}',
          '',
          '    public function show() {',
          '        return $this->orderService->getOrder();',
          '    }',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'routes', 'web.php'),
        [
          '<?php',
          "Route::get('/orders/{id}', [OrderController::class, 'show']);",
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/orders/{id}'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'controller' && node.symbolName === 'OrderController'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'backend_service' && node.symbolName === 'OrderService'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /OrderController@show/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls' && edge.toNodeId.includes('OrderService')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('workflow extractor builds Rust web route-handler-service graphs', async () => {
    const workspacePath = createTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspacePath, 'src', 'services'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src', 'handlers'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'services', 'orders.rs'),
        [
          'pub async fn fetch_order() -> String {',
          '    "ok".to_string()',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'handlers', 'orders.rs'),
        [
          'use crate::services::orders::fetch_order;',
          '',
          'async fn get_order() -> String {',
          '    fetch_order().await',
          '}',
          '',
          'fn app() {',
          '    let _app = Router::new().route("/orders/:id", get(get_order));',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
      assert.strictEqual(snapshot.nodes.some((node) => node.nodeType === 'api_endpoint' && node.routePath === '/orders/:id'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'get_order'), true);
      assert.strictEqual(snapshot.nodes.some((node) => node.symbolName === 'fetch_order'), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'routes_to' && /get_order/.test(edge.label ?? '')), true);
      assert.strictEqual(snapshot.edges.some((edge) => edge.edgeType === 'calls' && edge.toNodeId.includes('fetch_order')), true);
      assert.strictEqual((snapshot.maps?.length ?? 0) > 0, true);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('active project detection promotes nested generated projects from changed files and command context', () => {
    const workspacePath = createTempWorkspace();
    try {
      const nestedProjectPath = path.join(workspacePath, 'nutrition-website');
      fs.mkdirSync(path.join(nestedProjectPath, 'src', 'app'), { recursive: true });
      fs.writeFileSync(path.join(nestedProjectPath, 'package.json'), '{"name":"nutrition-website"}', 'utf-8');
      fs.writeFileSync(
        path.join(nestedProjectPath, 'tsconfig.json'),
        '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}',
        'utf-8',
      );
      fs.writeFileSync(path.join(nestedProjectPath, 'src', 'app', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf-8');

      const detectedFromFiles = detectActiveProjectPath(workspacePath, Object.freeze([
        'nutrition-website/src/app/page.tsx',
      ]));
      assert.strictEqual(detectedFromFiles, nestedProjectPath);

      const commandContextPath = getProjectStorageInfo(workspacePath).commandContextPath;
      fs.mkdirSync(path.dirname(commandContextPath), { recursive: true });
      fs.writeFileSync(
        commandContextPath,
        JSON.stringify({
          command: 'npx create-next-app nutrition-website',
          cwd: workspacePath,
          status: 'completed',
          changedFiles: ['nutrition-website/package.json', 'nutrition-website/src/app/page.tsx'],
        }, null, 2),
        'utf-8',
      );

      assert.strictEqual(detectActiveProjectPathFromCommandContext(workspacePath), nestedProjectPath);
      assert.strictEqual(resolveEffectiveProjectPath({ workspacePath }), nestedProjectPath);
    } finally {
      cleanupTempWorkspace(workspacePath);
    }
  });

  test('buildPromptContext injects workflow graph retrieval for flow queries', async function () {
    this.timeout(10_000);
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

  test('buildPromptContext uses the nested active project root when command context points to a generated app', async function () {
    this.timeout(10_000);
    const workspacePath = createTempWorkspace();
    try {
      const nestedProjectPath = path.join(workspacePath, 'nutrition-website');
      fs.mkdirSync(path.join(nestedProjectPath, 'src', 'app'), { recursive: true });
      fs.mkdirSync(path.join(nestedProjectPath, 'src', 'components'), { recursive: true });
      fs.writeFileSync(
        path.join(nestedProjectPath, 'package.json'),
        JSON.stringify({ name: 'nutrition-website' }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(nestedProjectPath, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['./src/*'],
            },
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(nestedProjectPath, 'src', 'app', 'page.tsx'),
        [
          'import { Header } from "@/components/header";',
          'export default function Page() {',
          '  return <Header />;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(nestedProjectPath, 'src', 'components', 'header.tsx'),
        'export function Header() { return <header>Hi</header>; }\n',
        'utf-8',
      );

      const commandContextPath = getProjectStorageInfo(workspacePath).commandContextPath;
      fs.mkdirSync(path.dirname(commandContextPath), { recursive: true });
      fs.writeFileSync(
        commandContextPath,
        JSON.stringify({
          command: 'npx create-next-app nutrition-website',
          cwd: workspacePath,
          status: 'completed',
          changedFiles: [
            'nutrition-website/package.json',
            'nutrition-website/tsconfig.json',
            'nutrition-website/src/app/page.tsx',
            'nutrition-website/src/components/header.tsx',
          ],
        }, null, 2),
        'utf-8',
      );

      const now = Date.now();
      const result = await buildPromptContext({
        agentType: 'manual',
        notes: '',
        sessionMemory: {
          workspaceId: 'workspace-root',
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
          turnId: 'turn-nested',
          userMessage: {
            id: 'user-nested',
            role: 'user',
            content: 'Trace how the page renders the header component.',
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

      assert.strictEqual(result.effectiveWorkspacePath, nestedProjectPath);
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

  test('buildWorkflowArtifacts can promote connected generic entrypoints into workflow artifacts', () => {
    const now = Date.now();
    const artifacts = buildWorkflowArtifacts({
      nodes: Object.freeze([
        Object.freeze({
          id: 'entry-handler',
          nodeType: 'entrypoint',
          label: 'handleSubmit',
          filePath: 'src/features/orders/submit.ts',
          confidence: 0.82,
          createdAt: now,
        }),
        Object.freeze({
          id: 'service-submit',
          nodeType: 'backend_service',
          label: 'submitOrder',
          filePath: 'src/features/orders/service.ts',
          confidence: 0.9,
          createdAt: now,
        }),
      ]),
      edges: Object.freeze([
        Object.freeze({
          id: 'edge-submit',
          fromNodeId: 'entry-handler',
          toNodeId: 'service-submit',
          edgeType: 'calls',
          confidence: 0.88,
          createdAt: now,
        }),
      ]),
    });

    assert.strictEqual(artifacts.maps.some((map) => map.entryNodeId === 'entry-handler'), true);
    assert.strictEqual(artifacts.traceSummaries.some((trace) => trace.entryNodeId === 'entry-handler'), true);
  });

  test('tool evidence guardrails tell the agent to batch documentation edits before rereading broadly', () => {
    const now = Date.now();
    const readPlanProgress = Object.freeze([
      Object.freeze({
        label: 'read_file docs/guide.md',
        confirmed: true,
        status: 'confirmed' as const,
        targetPath: 'docs/guide.md',
        tool: 'read_file' as const,
      }),
    ]);
    const evidence = Object.freeze([
      Object.freeze({
        evidenceId: 'read-1',
        workspaceId: 'workspace',
        turnId: 'turn',
        toolName: 'read_file' as const,
        summary: 'Read docs/guide.md',
        success: true,
        capturedAt: now - 1000,
        stale: false,
        tags: Object.freeze([]),
        filePath: 'docs/guide.md',
        readMode: 'full' as const,
        contentPreview: '# Guide',
        truncated: false,
      }),
      Object.freeze({
        evidenceId: 'edit-1',
        workspaceId: 'workspace',
        turnId: 'turn',
        toolName: 'edit_file_range' as const,
        summary: 'Edited docs/guide.md',
        success: true,
        capturedAt: now,
        stale: false,
        tags: Object.freeze([]),
        filePath: 'docs/guide.md',
        operation: 'edit' as const,
        existedBefore: true,
        changedLineRanges: Object.freeze([Object.freeze({ startLine: 10, endLine: 18 })]),
      }),
    ]);

    const antiLoop = buildAntiLoopGuardrails(evidence, readPlanProgress);
    const reuse = buildEvidenceReuseBlock(readPlanProgress);
    assert.match(antiLoop, /documentation files already read and edited/i);
    assert.match(antiLoop, /docs\/guide\.md/);
    assert.match(reuse, /reuse the confirmed document context first/i);
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
