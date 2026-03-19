import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config/manager';

const NOTES_FILE = 'NOTE.md';

export function getNotesPath(): string {
  return path.join(getConfigDir(), NOTES_FILE);
}

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
