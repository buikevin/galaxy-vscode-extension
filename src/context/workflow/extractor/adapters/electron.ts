/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Electron workflow extractor adapter that links renderer IPC calls to main-process IPC handlers.
 */

import type { SymbolUnit, WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowFrameworkEdgeOptions } from '../../entities/adapters';
import { buildTypeScriptWorkflowExtractionContext } from '../generic-facts';

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
 * Extracts Electron IPC channel names invoked from a symbol unit body.
 *
 * @param unit Workflow symbol unit whose callable nodes may contain IPC invocations.
 * @returns Sorted IPC channel names invoked from the unit.
 */
function extractInvokedElectronChannels(unit: SymbolUnit): readonly string[] {
  const channels = new Set<string>();
  unit.callableNodes.forEach((node) => {
    const text = node.getText();
    const invokePattern = /\bipcRenderer\.(?:invoke|send)\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of text.matchAll(invokePattern)) {
      const channelName = match[1];
      if (channelName) {
        channels.add(channelName);
      }
    }
  });
  return Object.freeze([...channels.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Extracts Electron IPC channels handled by a symbol unit body.
 *
 * @param unit Workflow symbol unit whose callable nodes may contain IPC handlers.
 * @returns Sorted IPC channel names handled by the unit.
 */
function extractHandledElectronChannels(unit: SymbolUnit): readonly string[] {
  const channels = new Set<string>();
  unit.callableNodes.forEach((node) => {
    const text = node.getText();
    const handlerPattern = /\bipcMain\.(?:handle|on)\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of text.matchAll(handlerPattern)) {
      const channelName = match[1];
      if (channelName) {
        channels.add(channelName);
      }
    }
  });
  return Object.freeze([...channels.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Creates a workflow node for an Electron IPC endpoint.
 *
 * @param channelName IPC channel name.
 * @param sourceUnit Symbol unit that owns the handler.
 * @returns Frozen workflow node record for the IPC endpoint.
 */
function createElectronIpcNode(channelName: string, sourceUnit: SymbolUnit): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:electron:${sanitizeIdentifier(channelName)}`,
    nodeType: 'rpc_endpoint',
    label: channelName,
    filePath: sourceUnit.relativePath,
    symbolName: channelName,
    description: `Electron IPC channel ${channelName}`,
    descriptionSource: 'electron',
    confidence: 0.88,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'electron_ipc_channel',
    }),
    sourceHash: sourceUnit.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a workflow edge record for Electron IPC relations.
 *
 * @param opts Edge creation options shared across framework adapters.
 * @returns Frozen workflow edge record.
 */
function createElectronEdge(opts: WorkflowFrameworkEdgeOptions): WorkflowEdgeRecord {
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
 * Extracts Electron renderer-to-main IPC workflow edges.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Electron IPC usage.
 */
async function extractElectronWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const channelNodes = new Map<string, WorkflowNodeRecord>();

  context.parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      extractHandledElectronChannels(unit).forEach((channelName) => {
        const channelNode = createElectronIpcNode(channelName, unit);
        channelNodes.set(channelName, channelNode);
        nodes.set(channelNode.id, channelNode);

        edges.set(
          `routes:${channelNode.id}:${unit.id}`,
          createElectronEdge({
            fromNodeId: channelNode.id,
            toNodeId: unit.id,
            edgeType: 'routes_to',
            label: channelName,
            relativePath: unit.relativePath,
            sourceHash: unit.sourceHash,
            provenanceKind: 'electron_ipc_handler_binding',
            confidence: 0.86,
          }),
        );
      });
    });
  });

  context.parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      extractInvokedElectronChannels(unit).forEach((channelName) => {
        const channelNode = channelNodes.get(channelName);
        if (!channelNode) {
          return;
        }
        edges.set(
          `invoke:${unit.id}:${channelNode.id}:${channelName}`,
          createElectronEdge({
            fromNodeId: unit.id,
            toNodeId: channelNode.id,
            edgeType: 'invokes_rpc',
            label: channelName,
            relativePath: unit.relativePath,
            sourceHash: unit.sourceHash,
            provenanceKind: 'electron_ipc_invoke',
            confidence: 0.84,
          }),
        );
      });
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Electron IPC extraction.
 */
export const electronWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'electron',
  label: 'Electron',
  extract: extractElectronWorkflowGraph,
});
