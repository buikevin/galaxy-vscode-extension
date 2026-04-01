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
    name: 'request_code_review',
    description: 'Ask the internal Code Reviewer sub-agent to review files changed in this session. Use near the end after your edits are ready.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
]);
