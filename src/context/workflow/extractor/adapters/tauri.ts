/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Tauri workflow extractor adapter that links frontend `invoke(...)` calls to Rust `#[command]` handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SymbolUnit, WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowFrameworkEdgeOptions } from '../../entities/adapters';
import { buildTypeScriptWorkflowExtractionContext } from '../generic-facts';
import { createSourceHash, scanWorkspaceSourceFilesBySuffixes } from '../files';

/**
 * Normalizes arbitrary text into a safe workflow identifier segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for workflow ids.
 */
function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

/**
 * Extracts `invoke("command")` names from a frontend symbol unit body.
 *
 * @param unit Workflow symbol unit whose callable nodes may contain Tauri invocations.
 * @returns Sorted command names invoked from the unit.
 */
function extractInvokedTauriCommands(unit: SymbolUnit): readonly string[] {
  const commands = new Set<string>();
  unit.callableNodes.forEach((node) => {
    const text = node.getText();
    const invokePattern = /\binvoke\s*\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of text.matchAll(invokePattern)) {
      const commandName = match[1];
      if (commandName) {
        commands.add(commandName);
      }
    }
  });
  return Object.freeze([...commands.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Creates a workflow node for a Rust Tauri command.
 *
 * @param relativePath Workspace-relative Rust file path.
 * @param commandName Parsed Rust command function name.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Frozen workflow node record for the command.
 */
function createTauriCommandNode(relativePath: string, commandName: string, sourceHash: string): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:tauri:${relativePath}:${sanitizeIdentifier(commandName)}`,
    nodeType: 'rpc_endpoint',
    label: commandName,
    filePath: relativePath,
    symbolName: commandName,
    description: `Tauri command ${commandName}`,
    descriptionSource: 'tauri',
    confidence: 0.88,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'tauri_command',
    }),
    sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a workflow edge record for Tauri frontend-to-command relations.
 *
 * @param opts Edge creation options shared across framework adapters.
 * @returns Frozen workflow edge record.
 */
function createTauriEdge(opts: WorkflowFrameworkEdgeOptions): WorkflowEdgeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:edge:${sanitizeIdentifier(`${opts.fromNodeId}:${opts.edgeType}:${opts.toNodeId}:${opts.label}`)}`,
    fromNodeId: opts.fromNodeId,
    toNodeId: opts.toNodeId,
    edgeType: opts.edgeType,
    label: opts.label,
    confidence: opts.confidence,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: opts.provenanceKind,
    }),
    supportingFilePath: opts.relativePath,
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Extracts Rust `#[command]` or `#[tauri::command]` handlers from `.rs` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Mapping from command names to workflow nodes.
 */
function extractRustTauriCommands(workspacePath: string): ReadonlyMap<string, WorkflowNodeRecord> {
  const rustFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.rs']);
  const nodes = new Map<string, WorkflowNodeRecord>();

  rustFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    const commandPattern = /#\s*\[\s*(?:tauri::)?command\s*\][\s\r\n]*(?:(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\()/g;

    for (const match of content.matchAll(commandPattern)) {
      const commandName = match[1];
      if (!commandName) {
        continue;
      }
      nodes.set(commandName, createTauriCommandNode(relativePath, commandName, sourceHash));
    }
  });

  return nodes;
}

/**
 * Extracts Tauri frontend-to-Rust command workflow edges.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from frontend invoke calls and Rust commands.
 */
async function extractTauriWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const rustCommandNodes = extractRustTauriCommands(workspacePath);
  if (rustCommandNodes.size === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>([...rustCommandNodes.entries()].map(([, node]) => [node.id, node]));
  const edges = new Map<string, WorkflowEdgeRecord>();

  context.parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      extractInvokedTauriCommands(unit).forEach((commandName) => {
        const commandNode = rustCommandNodes.get(commandName);
        if (!commandNode) {
          return;
        }
        const edge = createTauriEdge({
          fromNodeId: unit.id,
          toNodeId: commandNode.id,
          edgeType: 'invokes_rpc',
          label: commandName,
          relativePath: parsedFile.relativePath,
          sourceHash: parsedFile.sourceHash,
          provenanceKind: 'tauri_invoke_binding',
          confidence: 0.84,
        });
        edges.set(edge.id, edge);
      });
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Tauri frontend invoke bindings and Rust commands.
 */
export const tauriWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'tauri',
  label: 'Tauri',
  extract: extractTauriWorkflowGraph,
});
