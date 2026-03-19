import type { AgentType, ChatMessage } from '../shared/protocol';
import type { ToolCall } from '../tools/file-tools';

export type RuntimeMessage = ChatMessage;

export type StreamChunk =
  | Readonly<{ type: 'text'; delta: string }>
  | Readonly<{ type: 'thinking'; delta: string }>
  | Readonly<{ type: 'tool_call'; call: ToolCall }>
  | Readonly<{ type: 'done' }>
  | Readonly<{ type: 'error'; message: string }>;

export type StreamHandler = (chunk: StreamChunk) => void;

export interface AgentDriver {
  readonly name: AgentType;
  chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void>;
}
