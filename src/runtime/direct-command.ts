import fs from 'node:fs';
import path from 'node:path';
import { resolveCommandBinary } from './shell-resolver';

export type DirectCommand = Readonly<{
  binary: string;
  args: readonly string[];
  resolvedBinary: string;
  displayCommandText: string;
}>;

function containsShellOperators(commandText: string): boolean {
  const normalized = commandText.trim();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('\n') ||
    normalized.includes('\r') ||
    normalized.includes('&&') ||
    normalized.includes('||') ||
    normalized.includes('|') ||
    normalized.includes(';') ||
    normalized.includes('>') ||
    normalized.includes('<') ||
    normalized.includes('`') ||
    normalized.includes('$(')
  );
}

function quoteArgForDisplay(arg: string): string {
  if (!arg.length) {
    return '""';
  }
  if (/[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

export function tokenizeDirectCommandText(commandText: string): readonly string[] | null {
  const input = commandText.trim();
  if (!input || containsShellOperators(input)) {
    return null;
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping || quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens.length > 0 ? Object.freeze(tokens) : null;
}

function normalizeGitCheckoutArgs(args: readonly string[], cwd: string): readonly string[] {
  if (args[0] !== 'checkout') {
    return args;
  }

  const checkoutArgs = args.slice(1);
  if (
    checkoutArgs.length === 0 ||
    checkoutArgs.includes('--') ||
    checkoutArgs.some((item) => item.startsWith('-'))
  ) {
    return args;
  }

  const allLookLikeExistingPaths = checkoutArgs.every((item) => {
    const resolved = path.resolve(cwd, item);
    return fs.existsSync(resolved);
  });

  return allLookLikeExistingPaths
    ? Object.freeze(['checkout', '--', ...checkoutArgs])
    : args;
}

export function tryResolveDirectCommand(commandText: string, cwd: string): DirectCommand | null {
  const tokens = tokenizeDirectCommandText(commandText);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const [binary, ...rawArgs] = tokens;
  const args = binary === 'git'
    ? normalizeGitCheckoutArgs(rawArgs, cwd)
    : rawArgs;
  const resolvedBinary = resolveCommandBinary(binary, cwd);
  if (!resolvedBinary) {
    return null;
  }

  return Object.freeze({
    binary,
    args: Object.freeze([...args]),
    resolvedBinary,
    displayCommandText: [binary, ...args].map((part) => quoteArgForDisplay(part)).join(' '),
  });
}
