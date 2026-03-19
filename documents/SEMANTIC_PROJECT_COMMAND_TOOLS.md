# Semantic Project Command Tools

This document describes the recommended design for adding semantic command tools on top of the current `run_project_command(...)` tool.

## Goal

The current `run_project_command(command, cwd?, maxChars?)` tool is flexible, but it pushes too much command selection logic into the AI Agent.

The semantic tool layer solves that by letting the agent express intent instead of raw shell text.

The practical performance goal is also important:

- `run_lint()` and `run_static_check()` should be designed so they can run in parallel when both are requested
- `run_test()` and `run_build()` should remain sequential by default

This reduces AI waiting time for common static checks without introducing the higher risk of parallel build/test side effects.

Recommended semantic tools:

- `run_lint(path?)`
- `run_static_check(path?)`
- `run_test(path?)`
- `run_build(path?)`

These tools should not replace `run_project_command(...)`.
They should sit above it as a safer, more structured interface.

## Design Principle

The AI Agent should decide intent, not invent shell commands.

Bad model:

- agent reads project files
- agent guesses `npm run lint` or `cargo check`
- host executes the guessed command

Preferred model:

- agent calls `run_lint()`
- host/runtime resolves the best concrete command for the current project
- host executes the resolved command

This keeps command resolution deterministic, auditable, and easier to secure.

## Why Not Hardcode By Framework

Hardcoding one command per framework or language does not scale.

Examples:

- Node projects may use `npm`, `pnpm`, `yarn`, `bun`, `turbo`, or `nx`
- Python projects may use `pytest`, `tox`, `nox`, `ruff`, `mypy`, `pyright`, `poetry`, or `uv`
- Java projects may use Maven or Gradle
- monorepos may have multiple apps/packages with different commands

Because of that, semantic tools must use resolution by evidence, not rigid framework mapping.

## Resolution Strategy

Each semantic tool should resolve a command using a multi-layer strategy.

### Layer 1: Project-declared commands

Highest confidence. Prefer these first.

Examples:

- `package.json` scripts
- `Makefile`
- `Justfile`
- `Taskfile.yml`
- `tox.ini`
- `noxfile.py`
- Gradle tasks
- Maven goals
- Cargo defaults

If the project already declares a command for the requested intent, use it.

### Layer 2: Ecosystem-aware defaults

Only use these when confidence is high enough.

Examples:

- Rust:
  - `run_static_check()` -> `cargo check`
  - `run_test()` -> `cargo test`
  - `run_build()` -> `cargo build`
- Go:
  - `run_test()` -> `go test ./...`
  - `run_build()` -> `go build ./...`
- Node:
  - prefer package scripts over defaults
- Python:
  - only use `pytest`, `ruff`, `mypy`, or `pyright` if project evidence says they exist

### Layer 3: Fail clearly when confidence is low

If runtime cannot resolve a command safely, it should not guess aggressively.

Return a clear error such as:

`No lint command could be resolved for this project.`

At that point the AI Agent can:

- ask the user for the preferred command
- fall back to `run_project_command(...)`

## Runtime Shape

Recommended semantic tool signatures:

- `run_lint(path?)`
- `run_static_check(path?)`
- `run_test(path?)`
- `run_build(path?)`

Suggested behavior:

1. resolve target project from `path?` or workspace root
2. inspect project metadata
3. resolve best command for the requested intent
4. run the resolved command
5. return:
   - resolved command text
   - cwd
   - category
   - exit code
   - duration
   - output

## Suggested Command Categories

The current runtime already reasons about command categories such as:

- `lint`
- `typecheck`
- `test`
- `build`
- `format-check`

For semantic command tools, the naming should shift from `typecheck` to `static-check`.

Why:

- not every language has an explicit type system like TypeScript or Rust
- many ecosystems use static analysis that is broader than type checking

Recommended user-facing categories:

- `lint`
- `static-check`
- `test`
- `build`

Internally, the resolver may still map `static-check` to:

- `tsc --noEmit`
- `cargo check`
- `mypy`
- `pyright`
- `dart analyze`
- `dotnet build`

depending on ecosystem.

## Parallelism Policy

Semantic tools make parallel execution easier to reason about, but parallelism still must be selective.

Recommended policy:

- allow parallel:
  - `run_lint`
  - `run_static_check`
- do not parallel by default:
  - `run_test`
  - `run_build`
  - install/setup commands
  - unknown custom commands
  - multiple commands that write artifacts in the same project

Recommended conservative policy:

- maximum concurrency: `2`
- `run_lint()` and `run_static_check()` may run together
- `run_test()` runs alone
- `run_build()` runs alone

### Why This Policy

`lint` and `static-check` are the main candidates for parallel execution because:

- they are usually read-heavy and low-risk
- they are often the first quality gates the AI wants after edits
- they can take long enough to noticeably slow down the agent if forced to run one after the other

`test` and `build` stay sequential because:

- they more often write artifacts, caches, snapshots, or coverage
- they consume more CPU and memory
- they are more likely to interfere with each other in a shared workspace

So the intended runtime behavior is:

- if the agent wants `lint` and `static-check`, run them concurrently when possible
- if the agent wants `test` or `build`, run them one at a time

## Quality Flow When Validation Is Enabled

When test or validation quality is enabled, the intended near-final execution flow should be:

1. run `request_code_review()` first when review quality is enabled
2. then run `run_lint()` and `run_static_check()` in parallel when both can be resolved safely
3. then run `run_test()` if the project and task require real test execution
4. use `validate_code(path)` only as a final safety net for changed files, or when project-level static checking is missing or insufficient

Important clarification:

- `validate_code(path)` is not the same thing as `run_test()`
- `validate_code(path)` should not always run in every successful project-validation flow
- `validate_code(path)` remains a lightweight per-file fallback and end-of-task safety layer

This keeps the validation pipeline fast for common cases, while still preserving a last-mile check for changed files when broader project checks do not fully cover them.

## Approval Model

Semantic tools should still respect the same approval model as `run_project_command(...)`.

However, approval UX can be clearer:

- title: `Run lint`
- message: `AI Agent wants to run the project lint command.`
- details:
  - resolved command
  - cwd
  - why it was chosen

This is easier for the user to trust than a raw custom shell command.

## Interaction With AI Agent

The AI Agent should be instructed as follows:

- prefer semantic tools when the goal is lint/static-check/test/build
- use `run_project_command(...)` only for custom project actions that do not fit the semantic tools
- do not guess shell commands when a semantic tool exists
- when review quality is enabled, prefer `request_code_review()` before test execution
- when validation quality is enabled, prefer:
  - `request_code_review()` first when enabled
  - `run_lint()` + `run_static_check()` after review
  - `run_test()` after that when needed
  - `validate_code(path)` only as a final safety net, not as a mandatory replacement for project-level checks

This reduces command hallucination and improves consistency across languages.

## Recommended Implementation Order

1. Add resolver API:
   - `resolveSemanticProjectCommand(intent, path?)`
2. Add 4 semantic tools:
   - `run_lint`
   - `run_static_check`
   - `run_test`
   - `run_build`
3. Reuse existing command execution UI and shell streaming
4. Add command confidence/failure reasons
5. Add selective parallel policy
6. Keep `run_project_command(...)` as fallback

## Summary

The correct design is not:

- one fixed command per framework

The correct design is:

- semantic tools for intent
- runtime resolution by project evidence
- cautious ecosystem defaults
- explicit fallback when confidence is low
- review before test execution when review quality is enabled
- parallel `lint + static-check` to reduce AI waiting time
- sequential `test + build` for safer execution
- `validate_code(path)` as a final per-file safety net instead of an always-on mandatory last step
- raw `run_project_command(...)` retained for custom actions
