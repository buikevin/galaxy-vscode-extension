import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

import {
  recordCodeEdit,
  listCodeEditsByTurn,
  markCodeEditReverted,
} from "../context/rag-metadata/code-edits";
import {
  recordFileRead,
  listFileReadsByTurn,
  listRecentlyReadFiles,
} from "../context/rag-metadata/file-reads";

const EXTENSION_ID = "kevinbui.galaxy-code-vscode";

const EXPECTED_COMMANDS = [
  "galaxy-code.openChat",
  "galaxy-code.openChatTab",
  "galaxy-code.clearHistory",
  "galaxy-code.openConfig",
  "galaxy-code.switchAgent",
  "galaxy-code.openLogs",
];

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "galaxy-e2e-"));
  return dir;
}

suite("Galaxy Code E2E — activation + ledger", () => {
  let workspacePath = "";

  suiteSetup(async () => {
    workspacePath = createTempWorkspace();
  });

  suiteTeardown(() => {
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("extension is present and activates", async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, "extension failed to activate");
  });

  test("registers expected commands", async function () {
    this.timeout(15_000);
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `missing command: ${cmd}`);
    }
  });

  test("code_edits ledger persists records and supports revert", () => {
    const turnId = `turn-${Date.now()}-edits`;
    const workspaceId = "ws-e2e";
    const filePath = path.join(workspacePath, "sample.ts");

    const firstId = recordCodeEdit(workspacePath, {
      workspaceId,
      turnId,
      toolName: "write_file",
      filePath,
      rangeStartLine: 1,
      rangeEndLine: 10,
      beforeContent: "old",
      afterContent: "new",
    });
    const secondId = recordCodeEdit(workspacePath, {
      workspaceId,
      turnId,
      toolName: "edit_file",
      filePath,
      rangeStartLine: 11,
      rangeEndLine: 12,
      beforeContent: "new",
      afterContent: "newer",
    });
    assert.ok(firstId < secondId, "ids must ascend");

    const records = listCodeEditsByTurn(workspacePath, turnId);
    assert.strictEqual(records.length, 2, "expected two edits for turn");
    assert.strictEqual(records[0]?.id, firstId);
    assert.strictEqual(records[1]?.id, secondId);

    markCodeEditReverted(workspacePath, secondId);
    const after = listCodeEditsByTurn(workspacePath, turnId);
    const revertedRow = after.find((row) => row.id === secondId);
    assert.ok(revertedRow?.revertedAt, "revertedAt should be set");
  });

  test("file_reads trail records reads and dedupes recent files", () => {
    const turnId = `turn-${Date.now()}-reads`;
    const workspaceId = "ws-e2e";
    const a = path.join(workspacePath, "a.ts");
    const b = path.join(workspacePath, "b.ts");

    recordFileRead(workspacePath, {
      workspaceId,
      turnId,
      filePath: a,
      readMode: "file_lines",
      offset: 0,
      limit: 50,
      mtimeMs: Date.now(),
      sizeBytes: 100,
      cached: false,
    });
    recordFileRead(workspacePath, {
      workspaceId,
      turnId,
      filePath: b,
      readMode: "file_lines",
      offset: 0,
      limit: 50,
      mtimeMs: Date.now(),
      sizeBytes: 200,
      cached: true,
    });
    recordFileRead(workspacePath, {
      workspaceId,
      turnId,
      filePath: a,
      readMode: "file_lines",
      offset: 50,
      limit: 50,
      mtimeMs: Date.now(),
      sizeBytes: 100,
      cached: false,
    });

    const reads = listFileReadsByTurn(workspacePath, turnId);
    assert.strictEqual(reads.length, 3, "all reads recorded");

    const recent = listRecentlyReadFiles(workspacePath, workspaceId, 10);
    const uniquePaths = new Set(recent);
    assert.strictEqual(
      uniquePaths.size,
      recent.length,
      "recent reads must be deduped",
    );
    assert.ok(recent.length <= 2, "expected at most 2 unique files");
  });
});
