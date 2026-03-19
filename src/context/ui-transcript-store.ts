import fs from 'node:fs';
import type { ChatMessage } from '../shared/protocol';

type LoadOptions = Readonly<{
  maxMessages?: number;
}>;

const FULL_READ_THRESHOLD_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 128 * 1024;

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

export function appendUiTranscriptMessage(filePath: string, message: ChatMessage): void {
  fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, 'utf-8');
}

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

export function loadUiTranscript(filePath: string, opts?: LoadOptions): readonly ChatMessage[] {
  if (!fs.existsSync(filePath)) {
    return Object.freeze([]);
  }

  try {
    const lines = readTranscriptSource(filePath).split(/\r?\n/).filter(Boolean);
    const messages = lines
      .map((line) => {
        try {
          return reviveMessage(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((message): message is ChatMessage => message !== null);

    const maxMessages = opts?.maxMessages ?? messages.length;
    return Object.freeze(messages.slice(-maxMessages));
  } catch {
    return Object.freeze([]);
  }
}

export function clearUiTranscript(filePath: string): void {
  fs.writeFileSync(filePath, '', 'utf-8');
}
