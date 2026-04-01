/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound command stream and background completion actions extracted from the extension entrypoint.
 */

import {
  emitProviderCommandStreamChunk,
  emitProviderCommandStreamEnd,
  emitProviderCommandStreamStart,
  flushProviderBackgroundCommandCompletions,
  handleProviderBackgroundCommandCompletion,
  revealShellTerminal,
} from "./command-stream";
import type {
  ProviderBackgroundCommandBindings,
  ProviderCommandStreamBindings,
} from "../shared/command-stream";
import type {
  ProviderCommandActionBindings,
  ProviderCommandActions,
} from "../shared/provider-command-actions";

/** Builds provider-bound command actions from provider-owned state accessors and callbacks. */
export function createProviderCommandActions(
  bindings: ProviderCommandActionBindings,
): ProviderCommandActions {
  const commandStreamBindings: ProviderCommandStreamBindings = {
    commandTerminalRegistry: bindings.commandTerminalRegistry,
    activeShellSessions: bindings.activeShellSessions,
    commandContextPath: bindings.commandContextPath,
    appendLog: bindings.appendLog,
    postMessage: bindings.postMessage,
  };

  const backgroundCommandBindings: ProviderBackgroundCommandBindings = {
    commandContextPath: bindings.commandContextPath,
    appendLog: bindings.appendLog,
    asWorkspaceRelative: bindings.asWorkspaceRelative,
    getIsRunning: bindings.getIsRunning,
    getBackgroundCompletionRunning: bindings.getBackgroundCompletionRunning,
    setBackgroundCompletionRunning: bindings.setBackgroundCompletionRunning,
    getPendingBackgroundCompletions: bindings.getPendingBackgroundCompletions,
    setPendingBackgroundCompletions: bindings.setPendingBackgroundCompletions,
    setStatusText: bindings.setStatusText,
    reportProgress: bindings.reportProgress,
    postRunState: bindings.postRunState,
    getEffectiveConfig: bindings.getEffectiveConfig,
    getSelectedAgent: bindings.getSelectedAgent,
    runInternalRepairTurn: bindings.runInternalRepairTurn,
    runValidationAndReviewFlow: bindings.runValidationAndReviewFlow,
  };

  return {
    revealShellTerminal: async (toolCallId) =>
      revealShellTerminal(bindings.commandTerminalRegistry, toolCallId),
    emitCommandStreamStart: async (payload) =>
      emitProviderCommandStreamStart(commandStreamBindings, payload),
    emitCommandStreamChunk: async (payload) =>
      emitProviderCommandStreamChunk(commandStreamBindings, payload),
    emitCommandStreamEnd: async (payload) =>
      emitProviderCommandStreamEnd(commandStreamBindings, payload),
    handleBackgroundCommandCompletion: async (payload) =>
      handleProviderBackgroundCommandCompletion(
        backgroundCommandBindings,
        payload,
      ),
    flushBackgroundCommandCompletions: async () =>
      flushProviderBackgroundCommandCompletions(backgroundCommandBindings),
  };
}
