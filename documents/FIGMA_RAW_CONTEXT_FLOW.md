# Figma Raw Context Flow

This document captures the intended Figma integration flow for `galaxy-vscode-extension` before implementation changes begin.

## Goal

The current Figma integration is too summary-oriented.

It stores the import, surfaces a Figma attachment in the UI, and injects only a short design summary into prompt context.

That is not enough for reliable UI implementation.

The new goal is:

- keep the current local bridge import flow
- keep the current `Design By Figma` attachment UX in the composer
- change the AI-facing context so the Main AI Agent receives:
  - raw Figma HTML
  - selected structured design metadata from the Figma payload
  - the user request
- explicitly exclude SVG payloads from prompt context to avoid token bloat

The practical objective is to give the Main AI Agent enough raw design structure to implement UI accurately, without flooding the prompt with oversized embedded assets.

## Correct Intended Workflow

The desired flow is:

1. Figma plugin sends a payload to the local bridge HTTP server in the VS Code extension.
2. The extension stores the import and copies a Figma import token to the clipboard.
3. The user pastes that token into the chat input.
4. The webview resolves the token and shows a `Design By Figma` attachment, including SVG preview when available.
5. When the user sends a message with that Figma attachment, the host builds AI context from:
   - raw Figma HTML
   - selected useful fields from the Figma payload
   - the user request
6. The Main AI Agent uses that raw Figma context to write code.

## Desired AI Context Contract

When a Figma design is attached, the host should inject a structured context block that contains:

- import id
- page name
- selection root name/type
- root size when available
- raw Figma HTML
- selected structured metadata from the payload

The host should not inject:

- raw SVG strings
- base64 image payloads
- redundant large asset blobs

## Actual Payload Groups

From the current real payload shape, the important top-level groups are:

- import record:
  - `importId`
  - `workspaceId`
  - `importedAt`
  - `source`
  - `summary`
- document:
  - `version`
  - `source`
  - `exportedAt`
  - `selection`
  - `assets`
  - `pageId`
  - `pageName`
- node fields inside `selection[*]`:
  - `id`
  - `name`
  - `type`
  - `visible`
  - `absoluteBoundingBox`
  - `layout`
  - `style`
  - `constraints`
  - `text`
  - `assetRef`
  - `children`

The real sample payload is very large, and the biggest source of bloat is the SVG asset under:

- `document.assets[*].contentBase64`

That content is useful for UI preview, but not for model prompt context.

## Fields To Keep For AI Agent

The following fields should be kept, either directly or after normalization, because they help the AI Agent implement UI:

### Import-level metadata

- `importId`
- `summary`
- `document.pageId`
- `document.pageName`
- `document.exportedAt`

### Selection tree

Keep `document.selection`, but serialize it into a prompt-safe structure.

For each node, keep:

- `name`
- `type`
- `visible`
- `absoluteBoundingBox`
  - `x`
  - `y`
  - `width`
  - `height`
- `layout`
  - `mode`
  - `wrap`
  - `gap`
  - `paddingTop`
  - `paddingRight`
  - `paddingBottom`
  - `paddingLeft`
  - `alignMain`
  - `alignCross`
  - `sizingHorizontal`
  - `sizingVertical`
- `style`
  - `opacity`
  - `radius`
  - `strokeWidth`
  - simplified `fills`
  - simplified `strokes`
  - simplified `effects`
- `constraints`
  - `horizontal`
  - `vertical`
- `text`
  - `characters`
  - `fontFamily`
  - `fontWeight`
  - `fontSize`
  - `lineHeight`
  - `letterSpacing`
  - `textAlignHorizontal`
  - `textAlignVertical`
- `children`

### Optional semantic fields

If present in future payloads, these are also useful:

- `component.componentName`
- `component.variantProperties`
- lightweight `assetRef` markers when they help indicate that a visual asset exists

## Fields To Remove Before Sending To AI Agent

The following fields should be excluded from prompt context because they add a lot of token cost while giving little value for implementation:

- `document.assets`
- every `contentBase64`
- raw SVG markup
- PNG/base64 preview payloads
- `boundVariables`
- low-value deep vector internals used only to draw decorations
- repeated wrapper groups around SVG/vector content
- internal IDs when they are not needed for reasoning

### Specific exclusion rule for this payload family

In real payloads like the current sample, the serializer should aggressively avoid pushing the full subtree for:

- `*.svg fill`
- `*.svg`
- deep `group -> group -> group -> vector` chains

Those branches are usually decorative assets and are not useful as prompt input at full fidelity.

## Why Exclude SVG

SVG content from Figma payloads is often very large.

Problems caused by including raw SVG in prompt context:

- wastes prompt budget
- can cause token spikes or overflow
- drowns out the more important layout/text/style structure
- often provides little extra value because the agent mainly needs structure and styling intent, not the full vector path payload

So the rule is:

- UI preview may still use SVG
- local attachment files may still store SVG
- prompt context must exclude SVG

## What Raw SVG Is Still Used For

Raw SVG is still useful, but only outside the prompt path.

It should be used for:

- rendering the `Design By Figma` attachment preview in the UI
- preserving a visual snapshot of the imported design for the user
- optionally storing a local attachment artifact for inspection

It should not be used for:

- direct prompt injection into the Main AI Agent
- large inline model context blocks

## Attachment File Behavior

When the user sends a request with `Design By Figma` attached, the system should create a Figma SVG file inside:

- `<workspace>/.galaxy/attachments/images`

This file exists for attachment/preview purposes, not for prompt injection.

Intended behavior:

1. user pastes the Figma token
2. composer resolves it into `Design By Figma`
3. when the user sends the request, the host persists the Figma preview SVG into:
   - `<workspace>/.galaxy/attachments/images`
4. the UI can use that file for preview or attachment display
5. the Main AI Agent still receives only filtered Figma context, not the SVG payload itself

So the storage path and the prompt path are intentionally different concerns:

- storage/preview path -> may contain SVG
- AI prompt path -> must exclude SVG

## What "Raw Figma HTML" Means

For this design, "raw Figma HTML" means an HTML-like structural representation derived from the imported Figma node tree.

It should preserve:

- hierarchy
- node names
- node types
- layout direction
- spacing
- padding
- sizing behavior
- text content
- key style hints
- component/variant hints when available

It should avoid:

- full binary/base64 assets
- giant inline SVG markup
- noisy low-value raw fields that do not help implementation

This representation does not need to be browser-perfect HTML.

It only needs to be a deterministic, readable structural format that gives the model a much stronger implementation reference than the current short summary.

## Recommended Context Shape

Suggested prompt block:

```text
Attached Figma design:

Import ID: figma-...
Page: Landing Page
Root: Hero Section (FRAME)
Root size: 1440x900

Raw Figma HTML:
<frame name="Hero Section" layout="vertical" width="1440" height="900">
  <frame name="Header" layout="horizontal" gap="24" padding="32 48 32 48">
    <text fontFamily="Inter" fontSize="16" fontWeight="500">Pricing</text>
    ...
  </frame>
  <frame name="Hero Content" layout="horizontal" gap="48">
    ...
  </frame>
</frame>

Structured design metadata:
- top-level nodes: 3
- total nodes: 42
- text styles: ...
- components: ...
- constraints: ...

Use this attached Figma structure as the design source of truth for implementation.
Do not expect SVG assets to be available in prompt context.
```

## Required UX Behavior

The existing composer UX should remain conceptually the same:

- user pastes Figma token
- composer resolves it
- UI shows `Design By Figma`
- preview remains available when possible

The important change is on the host-side context construction, not on the basic attach UX.

## Current Gap

Today, the system mainly injects a short summary note for attached Figma imports.

That is too weak because:

- it loses layout depth
- it loses text hierarchy
- it loses rich node structure
- it does not give the agent enough raw design data to map to code reliably

So the implementation must move from:

- summary-only prompt context

to:

- raw Figma structure + filtered metadata prompt context

## Proposed Implementation Plan

### 1. Keep import and attachment flow

Do not replace the current bridge and attachment flow:

- local bridge server stays
- import records stay
- clipboard token flow stays
- `Design By Figma` attachment chip stays

### 2. Add a Figma-to-HTML serializer

Add a serializer that converts the imported node tree into a readable HTML-like structure.

Possible output rules:

- `FRAME` -> `<frame ...>`
- `GROUP` -> `<group ...>`
- `TEXT` -> `<text ...>content</text>`
- component instance -> `<component ...>`
- image/vector placeholders -> lightweight tag without inline payload

The serializer should include only useful attributes.

### 3. Add prompt-safe Figma context builder

Replace the current lightweight summary builder with a richer context builder that returns:

- header fields
- raw Figma HTML
- filtered metadata

This builder must:

- omit `assets[].contentBase64`
- omit raw SVG content
- omit `boundVariables`
- collapse or skip decorative SVG/vector wrapper branches
- truncate safely if the document is too large
- keep the context deterministic and readable

### 4. Preserve preview behavior separately

Preview behavior may still use:

- PNG preview
- SVG preview

But that preview path must remain separate from the model prompt path.

### 5. Add size guards

Because raw Figma structure can still be large, the implementation should include limits such as:

- max serialized node count
- max raw HTML chars
- max metadata chars
- explicit truncation markers

This is necessary even after removing SVG.

## Recommended Data Split

### Safe for prompt context

- page name
- import id
- import summary
- selection roots
- node tree structure
- text content
- layout info
- sizing info
- style summaries
- component names / variants
- constraints

### Not safe for prompt context

- `assets[].contentBase64`
- inline SVG strings
- raw binary previews
- `boundVariables`
- decorative deep vector/group internals
- unnecessary duplicate fields

## Implementation Notes

The likely implementation surface is:

- `src/figma/design-store.ts`
  - replace or extend `buildAttachedFigmaContextNote(...)`
- possibly add a new helper file, for example:
  - `src/figma/prompt-serializer.ts`
- update `src/attachments/attachment-store.ts`
  - to ensure the Figma preview SVG is persisted under `<workspace>/.galaxy/attachments/images` when the user sends a request with `Design By Figma`
- keep `src/figma/bridge-server.ts`
  - for import transport
- keep `webview/src/App.tsx`
  - for token paste and attachment UX, unless small UI labeling changes are needed

## Final Intended Behavior

When a Figma attachment is present, the Main AI Agent should no longer receive only a short summary.

It should receive:

- user request
- raw Figma HTML
- filtered structured Figma metadata

It should not receive:

- SVG payloads
- heavy base64 assets

That is the target behavior to implement next.
