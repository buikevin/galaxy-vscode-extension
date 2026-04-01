/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Reads workspace-agnostic operator notes from the shared config directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config/manager';
import { NOTES_FILE } from './entities/constants';

/**
 * Returns the absolute path of the persisted notes file.
 */
export function getNotesPath(): string {
  return path.join(getConfigDir(), NOTES_FILE);
}

/**
 * Loads operator notes if the notes file exists.
 */
export function loadNotes(): string {
  const notesPath = getNotesPath();
  if (!fs.existsSync(notesPath)) {
    return '';
  }

  try {
    return fs.readFileSync(notesPath, 'utf-8');
  } catch {
    return '';
  }
}
