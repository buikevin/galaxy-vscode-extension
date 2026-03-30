import * as assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config/types';
import { createDraftLocalAttachment } from '../attachments/attachment-store';
import { extractCodeChunkUnits } from '../context/code-chunk-extractor';
import { createHistoryManager } from '../context/history-manager';
import { getProjectStorageInfo } from '../context/project-store';
import { getCachedReadResult } from '../context/rag-metadata-store';
import { tryResolveDirectCommand } from '../runtime/direct-command';
import { executeToolAsync } from '../tools/file-tools';
import { selectNodeValidationScripts } from '../validation/project-validator';

suite('Retrieval And Validation', () => {
  function createTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-vscode-test-'));
  }

  function cleanupTempWorkspace(workspacePath: string): void {
    const storage = getProjectStorageInfo(workspacePath);
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(storage.projectDirPath, { recursive: true, force: true });
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

  test('read_document query returns semantic snippets and caches decoded source text', async () => {
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
});
