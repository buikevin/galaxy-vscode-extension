# Workflow Graph Trace RAG Benchmark

- Workspace: `/Users/buitronghieu/Desktop/Project/galaxy`
- Generated at: 2026-04-01T17:17:25.996Z
- Chroma mode: disabled-for-benchmark

## Coverage

- Semantic chunks embedded: 516/516
- Task memory entries: 7
- Task memory embeddings: 7
- Workflow nodes: 269
- Workflow edges: 143
- Workflow maps: 11
- Workflow trace summaries: 11
- Workflow artifact embeddings: 22

## Representative Flow Queries

- `Trace the galaxy vscode extension workflow graph retrieval and quality gate flow.`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=3, promptTokens=771, evidence=3, syntax=5
- `Which files and services are involved when the extension builds prompt context and workflow retrieval?`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=3, promptTokens=616, evidence=3, syntax=5
- `Explain the documentation generation and validation flow without rereading the whole workspace.`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=5, promptTokens=388, evidence=3, syntax=5

## Interpretation

- This benchmark measures current retrieval coverage on the real workspace snapshot stored in `.galaxy/projects`.
- It helps verify whether workflow graph retrieval is present before a model needs to reread raw files.
- It does not claim that edit-heavy or document-heavy tasks can avoid all rereads, because exact file-state validation is still required for safe range edits.
