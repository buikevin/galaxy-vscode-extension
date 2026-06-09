/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Quality and review tool schema definitions.
 */

import type { ToolDefinition } from '../../entities/file-tools';

export const QUALITY_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'validate_code',
    description: 'Run a lightweight single-file validation fallback. Use this when you need an explicit check for one file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'run_validation_suite',
    description: 'Run the project-level validation suite for the current session files or explicit paths. Returns lint, typecheck, test, build, and fallback validation results.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        paths: Object.freeze({
          type: 'array',
          items: Object.freeze({ type: 'string' }),
          description: 'Optional workspace files to validate instead of the current session files',
        }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'get_change_summary',
    description: 'Return the current session change summary for review: changed files, added/deleted line counts, and compact diff previews.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'request_code_review',
    description: 'Ask the internal Code Reviewer sub-agent to review files changed in this session. Use near the end after your edits are ready.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
]);
