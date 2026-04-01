/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound review finding and review-panel actions extracted from the extension entrypoint.
 */

import {
  applyReviewFinding,
  dismissReviewFindingTool,
  getLatestReviewFindingsTool,
  getLatestTestFailureTool,
  getNextReviewFindingTool,
} from "./review-findings";
import { openProviderReviewPanel } from "./review-panel";
import type {
  ProviderReviewActionBindings,
  ProviderReviewActions,
} from "../shared/provider-review-actions";

/** Builds provider-bound review actions from provider-owned state accessors and callbacks. */
export function createProviderReviewActions(
  bindings: ProviderReviewActionBindings,
): ProviderReviewActions {
  return {
    getLatestTestFailureTool: async () =>
      getLatestTestFailureTool(bindings.projectStorage),
    getLatestReviewFindingsTool: async () =>
      getLatestReviewFindingsTool(bindings.projectStorage),
    getNextReviewFindingTool: async () =>
      getNextReviewFindingTool(bindings.projectStorage),
    dismissReviewFindingTool: async (findingId) =>
      dismissReviewFindingTool(
        {
          workspacePath: bindings.workspacePath,
          persistProjectMetaPatch: bindings.persistProjectMetaPatch,
          updateQualityDetails: bindings.updateQualityDetails,
        },
        bindings.projectStorage,
        findingId,
      ),
    applyReviewFinding: async (findingId) =>
      applyReviewFinding(
        {
          workspacePath: bindings.workspacePath,
          isRunning: bindings.isRunning,
          postMessage: bindings.postMessage,
          clearStreamingBuffers: bindings.clearStreamingBuffers,
          setRunningState: bindings.setRunningState,
          postRunState: bindings.postRunState,
          getEffectiveConfig: bindings.getEffectiveConfig,
          getSelectedAgent: bindings.getSelectedAgent,
          runInternalRepairTurn: bindings.runInternalRepairTurn,
          persistProjectMetaPatch: bindings.persistProjectMetaPatch,
          updateQualityDetails: bindings.updateQualityDetails,
          runValidationAndReviewFlow: bindings.runValidationAndReviewFlow,
        },
        bindings.projectStorage,
        findingId,
      ),
    openNativeReview: async () =>
      openProviderReviewPanel({
        getSummary: bindings.getSummary,
        asWorkspaceRelative: bindings.asWorkspaceRelative,
        createMessageId: bindings.createMessageId,
        handleMessage: bindings.handleMessage,
        refreshWorkspaceFiles: bindings.refreshWorkspaceFiles,
      }),
  };
}
