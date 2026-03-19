import type { HostMessage } from '@shared/protocol';

type VsCodeApi<State> = {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

function createFallbackApi<State>(): VsCodeApi<State> {
  let state: State | undefined;
  return {
    postMessage(message: unknown) {
      console.warn('[Galaxy Code] VS Code API unavailable. Dropping message.', message);
    },
    getState() {
      return state;
    },
    setState(nextState: State) {
      state = nextState;
    },
  };
}

function resolveVsCodeApi<State>(): VsCodeApi<State> {
  try {
    if (typeof acquireVsCodeApi === 'function') {
      return acquireVsCodeApi<State>();
    }
  } catch (error) {
    console.error('[Galaxy Code] Failed to acquire VS Code API.', error);
  }

  return createFallbackApi<State>();
}

export const vscode = resolveVsCodeApi<{
  input?: string;
  selectedAgent?: string;
  selectedFiles?: string[];
  activeTab?: string;
  fileQuery?: string;
}>();

export function postHostMessage(message: unknown): void {
  vscode.postMessage(message);
}

export function readPersistedState(): ReturnType<typeof vscode.getState> {
  return vscode.getState();
}

export function persistState(state: NonNullable<ReturnType<typeof vscode.getState>>): void {
  vscode.setState(state);
}

export type WebviewHostEvent = MessageEvent<HostMessage>;
