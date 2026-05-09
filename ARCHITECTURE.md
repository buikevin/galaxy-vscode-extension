# Galaxy VS Code Extension Architecture

## Overview

Galaxy Code is structured as four primary layers:

1. VS Code shell and provider orchestration in `src/extension.ts` and `src/extension-host/*`
2. Webview UI in `webview/src/*`
3. Runtime execution, model drivers, review, and session tracking in `src/runtime/*`
4. Retrieval, storage, workflow graph, and prompt assembly in `src/context/*`

The current design is stronger than a typical single-file extension entrypoint. The host runtime has already been decomposed into action bundles, the webview is isolated, and workflow retrieval is treated as a first-class subsystem rather than incidental glue.

## Main Runtime Flow

1. VS Code activates `src/extension.ts`, which delegates setup into `src/extension-host/extension-lifecycle.ts`.
2. Activation creates one `GalaxyChatViewProvider`, registers commands, status items, preview helpers, and the sidebar view.
3. `src/extension-host/provider-bootstrap.ts` wires mutable provider state into specialized action bundles.
4. The React app in `webview/src/App.tsx` sends host messages back to the provider.
5. `src/extension-host/galaxy-chat-view-provider-runtime.ts` routes webview actions and chat-send messages.
6. `src/runtime/run-chat.ts` builds prompt context, streams the model response, executes tools, and records workspace effects.
7. `src/context/prompt-builder.ts` assembles task memory, workflow retrieval, semantic retrieval, syntax context, and manual reread guidance into the final prompt.
8. After write-producing turns, `src/extension-host/quality-gates.ts` runs validation first and review second.

## Strengths

- The entrypoint is thin. `src/extension.ts` is now a clean activation shim instead of a behavior hub.
- The host/webview boundary is explicit. `GalaxyChatViewProvider` owns state, while the React webview owns presentation and user interaction.
- Retrieval is treated as a system, not a helper. Task memory, workflow graph, syntax, semantic support, and tool evidence are all composed deliberately in `src/context/prompt-builder.ts`.
- Workflow graph persistence has a sensible source-of-truth split: SQLite is canonical, while Neo4j and Kuzu are derived projector/read backends.

## Review Findings

### 1. High: session tracking is global, not workspace- or provider-scoped

`src/runtime/session-tracker.ts` stores `sessionFiles` and `originalSnapshots` in module-level maps. Callers such as `src/extension-host/quality-gates.ts`, `src/extension-host/command-stream.ts`, and `src/runtime/run-chat.ts` read from `getSessionFiles()` without passing any workspace or provider identifier.

That creates hidden coupling across the runtime:

- quality gates decide what to validate from global state rather than explicit turn state
- review and command-stream reporting depend on the same singleton tracker
- revert/diff summaries are also built from the same global store

This works as long as the extension behaves like a single active session in a single workspace, but it is a real architectural risk for:

- overlapping turns
- multiple live chat surfaces
- no-folder fallback mixed with a later real workspace
- future multi-root or per-project isolation work

Suggested direction: replace the module-level tracker with a provider- or workspace-scoped session tracker object and thread it through runtime callbacks the same way `HistoryManager` is already threaded.

### 2. Medium: host session sync still assumes the first workspace folder is the workspace

`src/extension-host/session-sync.ts` resolves both workspace name and workspace root from `vscode.workspace.workspaceFolders?.[0]`. That is a concrete single-root assumption in the host shell even though other parts of the system already talk about active project paths and scoped project resolution.

This can lead to subtle mismatches:

- file pickers and preview helpers are anchored to the first folder
- storage fallback and webview labels are based on the first folder
- future multi-root routing will be forced to bypass or rewrite these helpers

Suggested direction: move from “first folder” semantics to an explicit provider workspace identity, or at minimum carry the active workspace folder URI through provider bootstrap and session-init.

### 3. Medium: `buildPromptContext` is still a policy, retrieval, and formatting hub

`src/context/prompt-builder.ts` does too much in one function:

- retrieval intent classification
- task memory reads
- workflow retrieval
- syntax retrieval
- semantic retrieval
- hybrid path selection
- manual reread planning
- retrieval stop-reason policy
- prompt message assembly

This is the current architectural hotspot. The problem is not just file size; it is that policy decisions and content generation are interleaved. A small change to retrieval strategy can silently affect prompt surface order, stop reasons, hybrid candidates, or reread planning in the same function.

Suggested direction: split this into a retrieval planning phase, a retrieval execution phase, and a prompt rendering phase with typed intermediate objects.

### 4. Medium: provider orchestration still relies on very wide mutable callback bags

`src/extension-host/provider-bootstrap.ts` wires the provider by passing large callback/property bags into builder functions. `src/extension-host/chat-send.ts` and related runtime helpers also accept large parameter objects with many state mutators and side-effect callbacks.

This is better than one monolithic class, but it still has a maintenance cost:

- action bundles are coupled through shared mutable provider fields
- invariants are implicit rather than encoded in smaller domain objects
- tracing a side effect often means following several callback layers

Suggested direction: group the callback bags into a few narrower services, such as session state, UI bridge, quality pipeline, and workspace tools, instead of continuing to expand a single provider wiring surface.

## Refactor Order

If the goal is to reduce architectural risk without destabilizing behavior, the highest-yield order is:

1. Scope session tracking per workspace/provider
2. Break `buildPromptContext` into planned stages with typed outputs
3. Narrow provider callback bags into explicit services
4. Remove first-folder assumptions from host session sync

## References

- `src/extension.ts`
- `src/extension-host/extension-lifecycle.ts`
- `src/extension-host/galaxy-chat-view-provider.ts`
- `src/extension-host/provider-bootstrap.ts`
- `src/extension-host/chat-send.ts`
- `src/extension-host/quality-gates.ts`
- `src/extension-host/session-sync.ts`
- `src/runtime/run-chat.ts`
- `src/runtime/session-tracker.ts`
- `src/context/prompt-builder.ts`
