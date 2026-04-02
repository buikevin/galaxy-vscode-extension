/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Persists and loads the UI transcript JSONL stream for one workspace.
 */

import fs from 'node:fs';
import type { ChatMessage } from '../shared/protocol';
import {
  FULL_READ_THRESHOLD_BYTES,
  TAIL_READ_BYTES,
} from './entities/constants';
import type { UiTranscriptLoadOptions } from './entities/ui-transcript';

/**
 * Revives one transcript row into a typed chat message.
 */
function reviveMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string') {
    return null;
  }
  if (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'tool') {
    return null;
  }
  if (typeof raw.content !== 'string') {
    return null;
  }
  if (typeof raw.timestamp !== 'number') {
    return null;
  }

  const toolCalls = Array.isArray(raw.toolCalls)
    ? Object.freeze(raw.toolCalls as NonNullable<ChatMessage['toolCalls']>)
    : null;
  const attachments = Array.isArray(raw.attachments)
    ? Object.freeze(raw.attachments as NonNullable<ChatMessage['attachments']>)
    : null;
  const figmaAttachments = Array.isArray(raw.figmaAttachments)
    ? Object.freeze(raw.figmaAttachments as NonNullable<ChatMessage['figmaAttachments']>)
    : null;

  return Object.freeze({
    id: raw.id,
    role: raw.role,
    content: raw.content,
    ...(raw.agentType === 'manual' || raw.agentType === 'ollama' || raw.agentType === 'gemini' || raw.agentType === 'claude' || raw.agentType === 'codex'
      ? { agentType: raw.agentType }
      : {}),
    ...(typeof raw.thinking === 'string' ? { thinking: raw.thinking } : {}),
    ...(Array.isArray(raw.images)
      ? { images: Object.freeze(raw.images.filter((item): item is string => typeof item === 'string')) }
      : {}),
    ...(attachments ? { attachments } : {}),
    timestamp: raw.timestamp,
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
    ...(typeof raw.toolParams === 'object' && raw.toolParams !== null
      ? { toolParams: Object.freeze(raw.toolParams as Record<string, unknown>) }
      : {}),
    ...(typeof raw.toolMeta === 'object' && raw.toolMeta !== null
      ? { toolMeta: Object.freeze(raw.toolMeta as Record<string, unknown>) }
      : {}),
    ...(typeof raw.toolSuccess === 'boolean' ? { toolSuccess: raw.toolSuccess } : {}),
    ...(typeof raw.toolCallId === 'string' ? { toolCallId: raw.toolCallId } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(figmaAttachments ? { figmaAttachments } : {}),
  });
}

function parseTranscriptMessages(source: string): readonly ChatMessage[] {
  return Object.freeze(
    source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return reviveMessage(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((message): message is ChatMessage => message !== null)
  );
}

/**
 * Appends one chat message to the JSONL transcript.
 */
export function appendUiTranscriptMessage(filePath: string, message: ChatMessage): void {
  fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, 'utf-8');
}

/**
 * Reads the transcript source efficiently, using tail reads for large files.
 */
function readTranscriptSource(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= FULL_READ_THRESHOLD_BYTES) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  const readSize = Math.min(stat.size, TAIL_READ_BYTES);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, 'r');

  try {
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
  } finally {
    fs.closeSync(fd);
  }

  let chunk = buffer.toString('utf-8');
  const firstNewline = chunk.indexOf('\n');
  if (stat.size > readSize && firstNewline >= 0) {
    chunk = chunk.slice(firstNewline + 1);
  }

  return chunk;
}

/**
 * Loads recent transcript messages from the JSONL store.
 */
export function loadUiTranscript(filePath: string, opts?: UiTranscriptLoadOptions): readonly ChatMessage[] {
  if (!fs.existsSync(filePath)) {
    return Object.freeze([]);
  }

  try {
    const messages = parseTranscriptMessages(readTranscriptSource(filePath));
    const maxMessages = opts?.maxMessages ?? messages.length;
    return Object.freeze(messages.slice(-maxMessages));
  } catch {
    return Object.freeze([]);
  }
}

export function loadInitialUiTranscriptBatch(
  filePath: string,
  opts?: UiTranscriptLoadOptions,
): Readonly<{
  messages: readonly ChatMessage[];
  hasOlderMessages: boolean;
}> {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({
      messages: Object.freeze([]),
      hasOlderMessages: false,
    });
  }

  try {
    const stat = fs.statSync(filePath);
    const parsedMessages = parseTranscriptMessages(readTranscriptSource(filePath));
    const maxMessages = opts?.maxMessages ?? parsedMessages.length;
    const messages = Object.freeze(parsedMessages.slice(-maxMessages));
    return Object.freeze({
      messages,
      hasOlderMessages:
        parsedMessages.length > messages.length ||
        stat.size > FULL_READ_THRESHOLD_BYTES,
    });
  } catch {
    return Object.freeze({
      messages: Object.freeze([]),
      hasOlderMessages: false,
    });
  }
}

export function loadOlderUiTranscriptBatch(
  filePath: string,
  opts?: Readonly<{
    beforeMessageId?: string;
    batchSize?: number;
  }>,
): Readonly<{
  messages: readonly ChatMessage[];
  hasOlderMessages: boolean;
}> {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({
      messages: Object.freeze([]),
      hasOlderMessages: false,
    });
  }

  try {
    const allMessages = parseTranscriptMessages(fs.readFileSync(filePath, "utf-8"));
    const beforeMessageId = opts?.beforeMessageId?.trim();
    const batchSize = Math.max(1, opts?.batchSize ?? 60);
    const beforeIndex = beforeMessageId
      ? allMessages.findIndex((message) => message.id === beforeMessageId)
      : allMessages.length;

    if (beforeIndex <= 0) {
      return Object.freeze({
        messages: Object.freeze([]),
        hasOlderMessages: false,
      });
    }

    const startIndex = Math.max(0, beforeIndex - batchSize);
    return Object.freeze({
      messages: Object.freeze(allMessages.slice(startIndex, beforeIndex)),
      hasOlderMessages: startIndex > 0,
    });
  } catch {
    return Object.freeze({
      messages: Object.freeze([]),
      hasOlderMessages: false,
    });
  }
}

/**
 * Clears the transcript file content.
 */
export function clearUiTranscript(filePath: string): void {
  fs.writeFileSync(filePath, '', 'utf-8');
}
