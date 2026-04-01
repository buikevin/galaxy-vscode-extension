/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared in-memory state for managed project commands in the VS Code runtime.
 */

import type { ManagedCommandRecord } from '../entities/project-command';

/** In-memory registry of active and recently finished managed commands. */
export const managedCommands = new Map<string, ManagedCommandRecord>();
