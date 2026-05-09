# Workflow Graph Trace RAG Benchmark

- Workspace: `/Users/buitronghieu/Desktop/Project/galaxy/galaxy-vscode-extension`
- Generated at: 2026-04-23T03:33:30.922Z
- Chroma mode: disabled-for-benchmark

## Coverage

- Semantic chunks embedded: 142/142
- Task memory entries: 0
- Task memory embeddings: 0
- Workflow nodes: 1064
- Workflow edges: 2280
- Workflow maps: 12
- Workflow trace summaries: 12
- Workflow artifact embeddings: 24
- Neo4j projection nodes: 1088
- Neo4j projection relationships: 2280
- Neo4j projection plan: schema=3, merge=4, cleanup=3

## Representative Flow Queries

- `Trace the galaxy vscode extension workflow graph retrieval and quality gate flow.`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=3, promptTokens=879, evidence=0, syntax=5
- `Which files and services are involved when the extension builds prompt context and workflow retrieval?`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=10, promptTokens=710, evidence=0, syntax=5
- `Explain the documentation generation and validation flow without rereading the whole workspace.`: workflowBlock=true, semanticBlock=true, rereadGuard=true, workflowPaths=6, promptTokens=703, evidence=0, syntax=5

## Local Retrieval Benchmarks

- `Trace the galaxy vscode extension workflow graph retrieval and quality gate flow.`: intent=feature_flow, mode=lexical, nodes=3, maps=3, traces=3, subgraphNodes=2, taskMemory=0, candidatePaths=3, kuzuQuery=aligned, kuzuSubgraph=aligned, neo4jQuery=unavailable, neo4jSubgraph=unavailable
- `Which files and services are involved when the extension builds prompt context and workflow retrieval?`: intent=feature_flow, mode=lexical, nodes=3, maps=0, traces=0, subgraphNodes=24, taskMemory=0, candidatePaths=26, kuzuQuery=aligned, kuzuSubgraph=aligned, neo4jQuery=unavailable, neo4jSubgraph=unavailable
- `Explain the documentation generation and validation flow without rereading the whole workspace.`: intent=feature_flow, mode=lexical, nodes=3, maps=3, traces=3, subgraphNodes=4, taskMemory=0, candidatePaths=5, kuzuQuery=aligned, kuzuSubgraph=aligned, neo4jQuery=unavailable, neo4jSubgraph=unavailable

## Interpretation

- This benchmark measures current retrieval coverage on the real workspace snapshot stored in `.galaxy/projects`.
- It helps verify whether workflow graph retrieval is present before a model needs to reread raw files.
- The local retrieval benchmark section mirrors the headless benchmark contract used by galaxy-code and can compare local results against embedded Kuzu or Neo4j read paths when those projector backends are available.
- It does not claim that edit-heavy or document-heavy tasks can avoid all rereads, because exact file-state validation is still required for safe range edits.
