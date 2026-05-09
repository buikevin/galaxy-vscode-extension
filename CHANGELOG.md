# Changelog

## [0.1.64] - 2026-05-07

### Cross-platform document vision (zero install)

- Document image extraction is now **fully cross-platform** (Windows, Linux, macOS) with zero native binary requirements:
  - **Office (DOCX / XLSX / PPTX)**: replaced `unzip` CLI with **JSZip** (pure JS). Works out of the box on every OS.
  - **PDF**: kept `pdftoppm` (Poppler) as the fast path when available; new pure-JS fallback uses **pdfjs-dist** (legacy build) + **pngjs** to extract embedded image XObjects, no native deps required.
  - All extraction is async and lazily imports the pure-JS libs only when actually needed.
- Adds dependencies: `jszip`, `pdfjs-dist`, `pngjs`.
- Backward-compatible API surface: `extractDocumentImages` and `extractDocumentImagesFromBuffer` are now `Promise<string[]>`; the only call site (`createDraftLocalAttachment`) was already async.

## [0.1.63] - 2026-05-07

### Hybrid document vision

- New attachment pipeline now extracts visuals from non-image documents:
  - **PDF**: renders up to 10 pages to PNG via `pdftoppm` (Poppler) at 150 DPI when available; gracefully no-ops if the binary is missing.
  - **DOCX / XLSX / PPTX**: extracts up to 20 embedded `*/media/*` files (PNG/JPEG/GIF/WEBP) using `unzip`.
- Extracted PNG/JPEG paths are persisted under `<projectDir>/attachments/images/<attachmentId>/` and surfaced via `AttachmentRecord.extractedImagePaths`, so multimodal models like `qwen3.5:397b-cloud` receive them as `images: [...]` on the user `RuntimeMessage`.
- Backward compatible: pre-existing image / Figma / preview branches in `buildAttachmentImagePaths` are unchanged.

## [0.1.62] - 2026-05-07

### Default model swap

- `CODER_SUB_AGENT_MODEL` and `REVIEWER_MODEL` switched from `qwen3-coder-next:cloud` to `qwen3.5:397b-cloud` (Qwen 3.5, multimodal: text + image, tools, thinking, 256K context). Manual driver fallback aligned. Mirrors the same change in `galaxy-code` for cross-project parity.

## [0.1.61] - 2026-05-07

### Workflow graph long-term memory

- New `workflow_file_index` SQLite table provides per-file content-hash cache for incremental workflow graph extraction.
- `extractWorkflowForFile` + `noteFileTouchedForGraph` keep the workflow graph warm via a debounced touch queue (500ms / batch 25 / single in-flight per workspace) wired into 7 read tools and all write tools in `runtime/run-chat.ts`.
- New `bootstrapWorkflowGraph` runs once at activation (non-blocking via `setTimeout`) using the previous session's `read_cache` / `file_reads` ledgers plus a depth-limited entry-point scan (max 50 files, skips `node_modules/dist/build/.git/...`).
- `export_workflow_drawio_diagram` and `export_workflow_mermaid_diagram` now call `ensureGraphForScope` before resolving the view; an empty graph returns `ToolResult{success:false, error:<hint>}` instead of throwing, telling the agent which file/route to read first.
- `buildWorkflowRetrievalBlock` no longer gates on `isFlowQuery` — every prompt queries the workflow graph; cold paths drain the touch queue (`flushWorkflowTouchQueue`) instead of full re-extracting the workspace.
- `isFlowQuery` is preserved for `classifyRetrievalIntent` / block ordering.

## [0.1.10-alpha]

- Initial project release.
