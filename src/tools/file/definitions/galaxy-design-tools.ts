/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Galaxy Design tool schema definitions.
 */

import type { ToolDefinition } from '../../entities/file-tools';

export const GALAXY_DESIGN_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'galaxy_design_project_info',
    description: 'Detect the target project framework, package manager, and whether Galaxy Design is already initialized.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_registry',
    description: 'Inspect published Galaxy Design registries to understand available components and dependencies.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        framework: Object.freeze({ type: 'string', description: 'Optional framework filter' }),
        component: Object.freeze({ type: 'string', description: 'Exact component name to inspect' }),
        group: Object.freeze({ type: 'string', description: 'Component group to inspect' }),
        query: Object.freeze({ type: 'string', description: 'Search query across Galaxy Design registries' }),
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_init',
    description: 'Initialize Galaxy Design in a detected project. This may require approval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_add',
    description: 'Add Galaxy Design components to an initialized project. This may require approval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        components: Object.freeze({
          type: 'array',
          items: Object.freeze({ type: 'string' }),
          description: 'Galaxy Design component names to add',
        }),
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze(['components']),
    }),
  }),
]);
