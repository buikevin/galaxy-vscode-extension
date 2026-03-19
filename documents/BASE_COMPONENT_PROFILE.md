# Base Component Profile

This document describes the preferred way to help the Main AI Agent generate UI code that matches the real component system used by the project.

## Goal

When the project already uses a component system such as:

- Galaxy Design
- shadcn/ui
- Ant Design
- MUI
- Chakra UI
- custom Radix wrappers

the AI Agent should detect that and implement UI in the same style instead of inventing a new component layer.

## Preferred Design

The preferred first step is:

1. detect the base component system in the host/runtime
2. inject that profile into turn context
3. let the Main AI Agent implement directly against the detected component system

This is better than relying only on a sub-agent because it reduces guessing earlier in the flow.

## Why Not Start With A Dedicated Adaptation Sub-Agent

A dedicated adaptation sub-agent may still be useful later, but it should not be the first layer.

Reasons:

- if the system has not detected the project component stack, the sub-agent still has to guess
- extra handoff between agents increases complexity and failure modes
- many UI tasks can be solved correctly if the Main AI Agent simply receives the right project component profile up front

So the recommended order is:

- detect component stack first
- add sub-agent adaptation only if needed later

## Detection Sources

The host should detect the base component profile from project evidence such as:

- `package.json` dependencies and devDependencies
- `components.json`
- `components/ui` or `src/components/ui`
- imports already used in workspace files
- framework-specific config conventions

## Initial Detection Rules

### Galaxy Design

High-confidence signals:

- `components.json` exists and points to Galaxy Design style/registry
- `galaxy-design` package or registry evidence exists

### shadcn/ui

High or medium confidence signals:

- `components.json` exists
- `components/ui` or `src/components/ui` exists
- `@radix-ui/*` dependencies exist
- `class-variance-authority` exists

### Ant Design

High-confidence signal:

- `antd` dependency exists

### MUI

High-confidence signal:

- `@mui/material` dependency exists

### Chakra UI

High-confidence signal:

- `@chakra-ui/react` dependency exists

### custom Radix wrappers

Signals:

- `@radix-ui/*` dependencies exist
- local UI wrapper directory exists

## Context Contract

The Main AI Agent should receive a short context block like:

```text
Base component profile:
- library: shadcn-ui
- confidence: high
- evidence: Found components.json
- evidence: Found components/ui directory
- evidence: Found @radix-ui dependencies
- guidance: Prefer project-local base components from components/ui or src/components/ui.
- guidance: Compose UI from existing shadcn-style primitives before using raw HTML.
- guidance: Match existing Tailwind and variant patterns already used by the project.
```

## Future Extension

If this context-first approach is not enough, a later phase can add a dedicated sub-agent whose job is:

- inspect the generated UI implementation
- convert or adapt it to the project base component system
- return the adapted structure to the Main AI Agent

That sub-agent should only be added after component profile detection is already stable.
