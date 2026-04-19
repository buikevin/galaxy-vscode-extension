/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Parse shell-free commands so the host can execute simple binaries directly when shell parsing is unnecessary.
 */

import fs from "node:fs";
import path from "node:path";
import type { DirectCommand } from "../shared/runtime";
import { resolveCommandBinary } from "./shell-resolver";

/**
 * Checks whether a command string contains shell operators that require real shell parsing.
 *
 * @param commandText Raw command text provided by the model.
 * @returns `true` when the command should stay on the shell execution path.
 */
function containsShellOperators(commandText: string): boolean {
  const normalized = commandText.trim();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    normalized.includes("&&") ||
    normalized.includes("||") ||
    normalized.includes("|") ||
    normalized.includes(";") ||
    normalized.includes(">") ||
    normalized.includes("<") ||
    normalized.includes("`") ||
    normalized.includes("$(")
  );
}

/**
 * Escapes one argument for readable command logging.
 *
 * @param arg Parsed command argument.
 * @returns Display-safe argument representation.
 */
function quoteArgForDisplay(arg: string): string {
  if (!arg.length) {
    return '""';
  }
  if (/[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

/**
 * Tokenizes a simple shell-free command line into binary and argument tokens.
 *
 * @param commandText Raw command text to tokenize.
 * @returns Parsed tokens, or `null` when shell syntax makes direct execution unsafe.
 */
export function tokenizeDirectCommandText(
  commandText: string,
): readonly string[] | null {
  const input = commandText.trim();
  if (!input || containsShellOperators(input)) {
    return null;
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const nextChar = input[index + 1] ?? "";

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      const shouldEscape = quote
        ? nextChar === quote || nextChar === "\\"
        : nextChar === '"' || nextChar === "'" || nextChar === "\\";
      if (!shouldEscape) {
        current += char;
        continue;
      }
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

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
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

/**
 * Normalizes ambiguous `git checkout file.ts` calls into `git checkout -- file.ts` when every argument is a real path.
 *
 * @param args Parsed git arguments excluding the `git` binary token.
 * @param cwd Working directory used to resolve path-like checkout targets.
 * @returns Possibly normalized git argument list.
 */
function normalizeGitCheckoutArgs(
  args: readonly string[],
  cwd: string,
): readonly string[] {
  if (args[0] !== "checkout") {
    return args;
  }

  const checkoutArgs = args.slice(1);
  if (
    checkoutArgs.length === 0 ||
    checkoutArgs.includes("--") ||
    checkoutArgs.some((item) => item.startsWith("-"))
  ) {
    return args;
  }

  const allLookLikeExistingPaths = checkoutArgs.every((item) => {
    const resolved = path.resolve(cwd, item);
    return fs.existsSync(resolved);
  });

  return allLookLikeExistingPaths
    ? Object.freeze(["checkout", "--", ...checkoutArgs])
    : args;
}

/**
 * Resolves a command into a direct executable invocation when shell parsing is unnecessary.
 *
 * @param commandText Raw command text emitted by the model.
 * @param cwd Working directory used for path resolution.
 * @returns Direct command metadata, or `null` when the command must stay on the shell path.
 */
export function tryResolveDirectCommand(
  commandText: string,
  cwd: string,
): DirectCommand | null {
  const tokens = tokenizeDirectCommandText(commandText);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const [binary, ...rawArgs] = tokens;
  const args =
    binary === "git" ? normalizeGitCheckoutArgs(rawArgs, cwd) : rawArgs;
  const resolvedBinary = resolveCommandBinary(binary, cwd);
  if (!resolvedBinary) {
    return null;
  }

  return Object.freeze({
    binary,
    args: Object.freeze([...args]),
    resolvedBinary,
    displayCommandText: [binary, ...args]
      .map((part) => quoteArgForDisplay(part))
      .join(" "),
  });
}
