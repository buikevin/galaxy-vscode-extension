/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound quality preference and tool-state actions extracted from the extension entrypoint.
 */

import type {
  PersistedToolingState,
  ProviderQualityActionBindings,
  ProviderQualityActions,
} from "../shared/quality-settings";
import {
  applyExtensionToolTogglesState,
  applyQualityPreferencesState,
  applyToolCapabilitiesState,
  applyToolTogglesState,
  readQualityPreferencesFromVsCodeSettings,
  syncQualityPreferencesToVsCodeSettings,
} from "./quality-settings";

/** Updates provider-owned state fields from one persisted tooling-state snapshot. */
function applyPersistedToolingState(
  bindings: ProviderQualityActionBindings,
  nextState: PersistedToolingState,
): void {
  bindings.setQualityPreferences(nextState.qualityPreferences);
  bindings.setToolCapabilities(nextState.toolCapabilities);
  bindings.setToolToggles(nextState.toolToggles);
  bindings.setExtensionToolToggles(nextState.extensionToolToggles);
}

/** Posts quality and tool state updates after a persisted state transition. */
async function postPersistedToolingState(
  bindings: ProviderQualityActionBindings,
  nextState: PersistedToolingState,
): Promise<void> {
  await bindings.postMessage({
    type: "quality-preferences-updated",
    payload: nextState.qualityPreferences,
  });
  await bindings.postMessage({
    type: "tool-capabilities-updated",
    payload: nextState.toolCapabilities,
  });
  await bindings.postMessage({
    type: "tool-toggles-updated",
    payload: nextState.toolToggles,
  });
}

/** Builds provider-bound quality actions from provider-owned state accessors and callbacks. */
export function createProviderQualityActions(
  bindings: ProviderQualityActionBindings,
): ProviderQualityActions {
  const applyQualityPreferences: ProviderQualityActions["applyQualityPreferences"] =
    async (next, opts) => {
      const nextState = await applyQualityPreferencesState({
        projectStorage: bindings.projectStorage,
        extensionToolGroups: bindings.getExtensionToolGroups(),
        next,
        syncVsCodeSettings: opts?.syncVsCodeSettings !== false,
      });
      applyPersistedToolingState(bindings, nextState);
      await postPersistedToolingState(bindings, nextState);

      if (opts?.logMessage) {
        bindings.appendLog("info", opts.logMessage);
      }
    };

  const applyToolCapabilities: ProviderQualityActions["applyToolCapabilities"] =
    async (next, opts) => {
      const nextState = await applyToolCapabilitiesState({
        projectStorage: bindings.projectStorage,
        extensionToolGroups: bindings.getExtensionToolGroups(),
        next,
      });
      applyPersistedToolingState(bindings, nextState);
      await postPersistedToolingState(bindings, nextState);

      if (opts?.logMessage) {
        bindings.appendLog("info", opts.logMessage);
      }
    };

  const applyToolToggles: ProviderQualityActions["applyToolToggles"] = async (
    next,
    opts,
  ) => {
    bindings.setToolToggles(
      applyToolTogglesState({
        projectStorage: bindings.projectStorage,
        next,
      }),
    );
    await bindings.postMessage({
      type: "tool-toggles-updated",
      payload: next,
    });

    if (opts?.logMessage) {
      bindings.appendLog("info", opts.logMessage);
    }
  };

  const applyExtensionToolToggles: ProviderQualityActions["applyExtensionToolToggles"] =
    async (next, opts) => {
      const nextExtensionToolToggles = applyExtensionToolTogglesState({
        projectStorage: bindings.projectStorage,
        extensionToolGroups: bindings.getExtensionToolGroups(),
        next,
      });
      bindings.setExtensionToolToggles(nextExtensionToolToggles);
      await bindings.postMessage({
        type: "extension-tool-toggles-updated",
        payload: nextExtensionToolToggles,
      });

      if (opts?.logMessage) {
        bindings.appendLog("info", opts.logMessage);
      }
    };

  const readProviderQualityPreferencesFromVsCodeSettings = (): ReturnType<
    ProviderQualityActions["readQualityPreferencesFromVsCodeSettings"]
  > =>
    readQualityPreferencesFromVsCodeSettings(bindings.getQualityPreferences());

  return {
    readQualityPreferencesFromVsCodeSettings:
      readProviderQualityPreferencesFromVsCodeSettings,
    syncQualityPreferencesToVsCodeSettings: async () => {
      await syncQualityPreferencesToVsCodeSettings(
        bindings.getQualityPreferences(),
      );
    },
    handleVsCodeQualitySettingsChange: async () => {
      const current = bindings.getQualityPreferences();
      const next = readProviderQualityPreferencesFromVsCodeSettings();
      if (
        next.reviewEnabled === current.reviewEnabled &&
        next.validateEnabled === current.validateEnabled &&
        next.fullAccessEnabled === current.fullAccessEnabled
      ) {
        return;
      }

      await applyQualityPreferences(next, {
        syncVsCodeSettings: false,
        logMessage: `Quality preferences updated from VS Code settings: review=${String(next.reviewEnabled)}, validate=${String(next.validateEnabled)}, fullAccess=${String(next.fullAccessEnabled)}.`,
      });
    },
    toggleReviewPreference: async () => {
      const current = bindings.getQualityPreferences();
      await applyQualityPreferences(
        Object.freeze({
          ...current,
          reviewEnabled: !current.reviewEnabled,
        }),
        {
          syncVsCodeSettings: true,
          logMessage: `Review ${current.reviewEnabled ? "disabled" : "enabled"} from the Command Palette.`,
        },
      );
    },
    toggleValidationPreference: async () => {
      const current = bindings.getQualityPreferences();
      await applyQualityPreferences(
        Object.freeze({
          ...current,
          validateEnabled: !current.validateEnabled,
        }),
        {
          syncVsCodeSettings: true,
          logMessage: `Validation ${current.validateEnabled ? "disabled" : "enabled"} from the Command Palette.`,
        },
      );
    },
    applyQualityPreferences,
    applyToolCapabilities,
    applyToolToggles,
    applyExtensionToolToggles,
  };
}
