/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Tree providers used by the extension host to render context and changed files views.
 */

import * as vscode from "vscode";
import type {
  ChangedFileSummary as ChangedFileSummaryPayload,
  FileItem,
} from "../shared/protocol";
import {
  OPEN_CHANGED_FILE_DIFF_COMMAND_ID,
  OPEN_CONTEXT_FILE_COMMAND_ID,
} from "../shared/constants";
import { getChangedFileDescription, getRelativePathDescription } from "./utils";

/** Tree provider for selected context files. */
export class ContextFilesTreeProvider implements vscode.TreeDataProvider<FileItem> {
  private readonly didChangeTreeData = new vscode.EventEmitter<
    FileItem | FileItem[] | undefined | null | void
  >();
  private files: readonly FileItem[] = [];

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  /** Replace the currently rendered file list. */
  setFiles(files: readonly FileItem[]): void {
    this.files = [...files];
    this.didChangeTreeData.fire();
  }

  /** Return the first file for default focus behavior. */
  getFirstFile(): FileItem | undefined {
    return this.files[0];
  }

  /** Get children for VS Code tree rendering. */
  getChildren(element?: FileItem): FileItem[] {
    return element ? [] : [...this.files];
  }

  /** Context files are a flat list with no parent node. */
  getParent(_element: FileItem): undefined {
    return undefined;
  }

  /** Build one tree item for the file picker view. */
  getTreeItem(element: FileItem): vscode.TreeItem {
    const fileUri = vscode.Uri.file(element.path);
    const treeItem = new vscode.TreeItem(
      fileUri,
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.id = element.path;
    treeItem.description = getRelativePathDescription(element.label);
    treeItem.tooltip = element.label;
    treeItem.command = {
      command: OPEN_CONTEXT_FILE_COMMAND_ID,
      title: "Open Context File",
      arguments: [element.path],
    };
    treeItem.contextValue = "galaxy-code.context-file";
    treeItem.checkboxState = element.selected
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return treeItem;
  }
}

/** Tree provider for tracked changed files. */
export class ChangedFilesTreeProvider implements vscode.TreeDataProvider<ChangedFileSummaryPayload> {
  private readonly didChangeTreeData = new vscode.EventEmitter<
    | ChangedFileSummaryPayload
    | ChangedFileSummaryPayload[]
    | undefined
    | null
    | void
  >();
  private files: readonly ChangedFileSummaryPayload[] = [];

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  /** Replace the currently rendered changed-file list. */
  setFiles(files: readonly ChangedFileSummaryPayload[]): void {
    this.files = [...files];
    this.didChangeTreeData.fire();
  }

  /** Return the first changed file for default focus behavior. */
  getFirstFile(): ChangedFileSummaryPayload | undefined {
    return this.files[0];
  }

  /** Get children for VS Code tree rendering. */
  getChildren(
    element?: ChangedFileSummaryPayload,
  ): ChangedFileSummaryPayload[] {
    return element ? [] : [...this.files];
  }

  /** Changed files are a flat list with no parent node. */
  getParent(_element: ChangedFileSummaryPayload): undefined {
    return undefined;
  }

  /** Build one tree item for the changed-files view. */
  getTreeItem(element: ChangedFileSummaryPayload): vscode.TreeItem {
    const fileUri = vscode.Uri.file(element.filePath);
    const treeItem = new vscode.TreeItem(
      fileUri,
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.id = element.filePath;
    treeItem.description = getChangedFileDescription(element);
    treeItem.tooltip =
      `${element.label}${element.wasNew ? " (new)" : ""}\n` +
      `+${element.addedLines} / -${element.deletedLines}`;
    treeItem.command = {
      command: OPEN_CHANGED_FILE_DIFF_COMMAND_ID,
      title: "Open Changed File Diff",
      arguments: [element.filePath],
    };
    treeItem.contextValue = "galaxy-code.changed-file";
    return treeItem;
  }
}
