import * as assert from 'assert';
import { extractCodeChunkUnits } from '../context/code-chunk-extractor';
import { selectNodeValidationScripts } from '../validation/project-validator';

suite('Retrieval And Validation', () => {
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
});
