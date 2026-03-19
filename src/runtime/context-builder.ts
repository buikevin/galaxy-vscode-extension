import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SELECTED_FILES = 6;
const MAX_FILE_CHARS = 4_000;

function truncateContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_FILE_CHARS)}\n...[truncated]`;
}

async function readAttachedFile(filePath: string, workspaceRoot?: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const label = workspaceRoot ? path.relative(workspaceRoot, filePath) || path.basename(filePath) : filePath;
    return `### FILE: ${label}\n${truncateContent(raw)}`;
  } catch {
    return null;
  }
}

export async function buildSelectedFilesContextNote(opts: {
  selectedFiles: readonly string[];
  workspaceRoot?: string;
}): Promise<string> {
  const fileSections = await Promise.all(
    opts.selectedFiles.slice(0, MAX_SELECTED_FILES).map((filePath) => readAttachedFile(filePath, opts.workspaceRoot)),
  );

  const attachedContext = fileSections.filter((section): section is string => Boolean(section)).join('\n\n');
  return attachedContext ? `Attached workspace context:\n${attachedContext}` : '';
}
