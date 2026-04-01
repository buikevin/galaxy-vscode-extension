/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Action-oriented tool schema definitions for command and git workflows.
 */

import type { ToolDefinition } from '../../entities/file-tools';

export const ACTION_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'run_terminal_command',
    description: 'Start a terminal command in the workspace and return immediately with a command id. Prefer this over run_project_command for long-running commands.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        command: Object.freeze({ type: 'string', description: 'Exact command to run in the workspace shell' }),
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum output characters to track in memory, default 8000' }),
      }),
      required: Object.freeze(['command']),
    }),
  }),
  Object.freeze({
    name: 'await_terminal_command',
    description: 'Wait for a previously started terminal command to finish, or return that it is still running after a timeout.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        commandId: Object.freeze({ type: 'string', description: 'Command id returned by run_terminal_command' }),
        timeoutMs: Object.freeze({ type: 'number', description: 'How long to wait before returning still-running status (default 15000)' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum tail output characters to include (default 8000)' }),
      }),
      required: Object.freeze(['commandId']),
    }),
  }),
  Object.freeze({
    name: 'get_terminal_output',
    description: 'Read the current tail output of a previously started terminal command without waiting for completion.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        commandId: Object.freeze({ type: 'string', description: 'Command id returned by run_terminal_command' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum tail output characters to include (default 8000)' }),
      }),
      required: Object.freeze(['commandId']),
    }),
  }),
  Object.freeze({
    name: 'kill_terminal_command',
    description: 'Send a termination signal to a previously started terminal command.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        commandId: Object.freeze({ type: 'string', description: 'Command id returned by run_terminal_command' }),
      }),
      required: Object.freeze(['commandId']),
    }),
  }),
  Object.freeze({
    name: 'git_status',
    description: 'Get the current git working tree status for the workspace, an optional subdirectory, or one specific path.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        short: Object.freeze({ type: 'boolean', description: 'Use git status --short for compact output' }),
        pathspec: Object.freeze({ type: 'string', description: 'Optional file or path to scope git status to one target' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'git_diff',
    description: 'Read git diff output, optionally staged or scoped to one path.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        pathspec: Object.freeze({ type: 'string', description: 'Optional file or path to diff' }),
        staged: Object.freeze({ type: 'boolean', description: 'Show staged diff instead of unstaged diff' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum output characters to include (default 8000)' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'git_add',
    description: 'Stage one or more paths with git add. Uses "." when no explicit paths are provided.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        paths: Object.freeze({
          type: 'array',
          items: Object.freeze({ type: 'string' }),
          description: 'Workspace-relative file or directory paths to stage',
        }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'git_commit',
    description: 'Create a git commit with a required commit message.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        message: Object.freeze({ type: 'string', description: 'Commit message' }),
        all: Object.freeze({ type: 'boolean', description: 'Use git commit -a to include tracked modified files' }),
      }),
      required: Object.freeze(['message']),
    }),
  }),
  Object.freeze({
    name: 'git_push',
    description: 'Push the current branch or a specified ref to a remote.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        remote: Object.freeze({ type: 'string', description: 'Optional remote name, for example origin' }),
        branch: Object.freeze({ type: 'string', description: 'Optional branch or ref to push' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'git_pull',
    description: 'Pull from the current remote tracking branch or a specified remote/branch.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        remote: Object.freeze({ type: 'string', description: 'Optional remote name, for example origin' }),
        branch: Object.freeze({ type: 'string', description: 'Optional branch or ref to pull' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'git_checkout',
    description: 'Checkout an existing branch/ref, or create a new branch when createBranch is true.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        ref: Object.freeze({ type: 'string', description: 'Branch, tag, or commit-ish to checkout' }),
        createBranch: Object.freeze({ type: 'boolean', description: 'Use git checkout -b <ref>' }),
      }),
      required: Object.freeze(['ref']),
    }),
  }),
  Object.freeze({
    name: 'run_project_command',
    description: 'Legacy compatibility shim for running a workspace command directly. Prefer run_terminal_command plus await/get/kill terminal tools for new flows.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        command: Object.freeze({ type: 'string', description: 'Exact command to run in the workspace shell' }),
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum output characters to return, default 8000' }),
      }),
      required: Object.freeze(['command']),
    }),
  }),
]);
