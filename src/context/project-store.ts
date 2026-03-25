import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getConfigDir } from '../config/manager';

export type ProjectMeta = Readonly<{
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectDirName: string;
  createdAt: number;
  lastOpenedAt: number;
  storageVersion: number;
}>;

export type ProjectStorageInfo = Readonly<{
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectDirName: string;
  projectDirPath: string;
  localGalaxyDirPath: string;
  localSettingsPath: string;
  projectMetaPath: string;
  debugLogPath: string;
  sessionMemoryPath: string;
  uiTranscriptPath: string;
  actionApprovalsPath: string;
  projectCommandsPath: string;
  toolEvidencePath: string;
  telemetryPath: string;
  telemetrySummaryPath: string;
  commandContextPath: string;
  syntaxIndexPath: string;
  semanticIndexPath: string;
  ragMetadataDbPath: string;
  figmaImportsPath: string;
  figmaAssetsDirPath: string;
  attachmentsDirPath: string;
  attachmentsIndexPath: string;
  attachmentsFilesDirPath: string;
  attachmentsImagesDirPath: string;
  attachmentsFigmaDirPath: string;
}>;

const STORAGE_VERSION = 1;

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
}

function getProjectsDir(): string {
  return path.join(getConfigDir(), 'projects');
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function createWorkspaceId(workspacePath: string): string {
  return createHash('sha1').update(path.resolve(workspacePath)).digest('hex');
}

export function getProjectStorageInfo(workspacePath: string): ProjectStorageInfo {
  const resolvedPath = path.resolve(workspacePath);
  const workspaceId = createWorkspaceId(resolvedPath);
  const workspaceName = path.basename(resolvedPath);
  const parentName = path.basename(path.dirname(resolvedPath));
  const projectDirName = `${sanitizeSegment(parentName)}-(${sanitizeSegment(workspaceName)})-${workspaceId.slice(0, 8)}`;
  const projectDirPath = path.join(getProjectsDir(), projectDirName);
  const localGalaxyDirPath = path.join(resolvedPath, '.galaxy');
  const localSettingsPath = path.join(localGalaxyDirPath, 'setting.local.json');

  return Object.freeze({
    workspaceId,
    workspaceName,
    workspacePath: resolvedPath,
    projectDirName,
    projectDirPath,
    localGalaxyDirPath,
    localSettingsPath,
    projectMetaPath: path.join(projectDirPath, 'project.json'),
    debugLogPath: path.join(projectDirPath, 'debug.log'),
    sessionMemoryPath: path.join(projectDirPath, 'session-memory.json'),
    uiTranscriptPath: path.join(projectDirPath, 'ui-transcript.jsonl'),
    actionApprovalsPath: localSettingsPath,
    projectCommandsPath: path.join(projectDirPath, 'project-commands.json'),
    toolEvidencePath: path.join(projectDirPath, 'tool-evidence.jsonl'),
    telemetryPath: path.join(projectDirPath, 'telemetry.jsonl'),
    telemetrySummaryPath: path.join(projectDirPath, 'telemetry-summary.json'),
    commandContextPath: path.join(projectDirPath, 'context.json'),
    syntaxIndexPath: path.join(projectDirPath, 'syntax-index.json'),
    semanticIndexPath: path.join(projectDirPath, 'semantic-index.json'),
    ragMetadataDbPath: path.join(projectDirPath, 'rag-metadata.sqlite'),
    figmaImportsPath: path.join(projectDirPath, 'figma-imports.jsonl'),
    figmaAssetsDirPath: path.join(projectDirPath, 'figma-assets'),
    attachmentsDirPath: path.join(localGalaxyDirPath, 'attachments'),
    attachmentsIndexPath: path.join(localGalaxyDirPath, 'attachments', 'index.json'),
    attachmentsFilesDirPath: path.join(localGalaxyDirPath, 'attachments', 'files'),
    attachmentsImagesDirPath: path.join(localGalaxyDirPath, 'attachments', 'images'),
    attachmentsFigmaDirPath: path.join(localGalaxyDirPath, 'attachments', 'figma'),
  });
}

export function ensureProjectStorage(info: ProjectStorageInfo): void {
  ensureDir(getProjectsDir());
  ensureDir(info.projectDirPath);
  ensureDir(info.localGalaxyDirPath);
  ensureDir(info.figmaAssetsDirPath);
  ensureDir(info.attachmentsDirPath);
  ensureDir(info.attachmentsFilesDirPath);
  ensureDir(info.attachmentsImagesDirPath);
  ensureDir(info.attachmentsFigmaDirPath);
  if (!fs.existsSync(info.uiTranscriptPath)) {
    fs.writeFileSync(info.uiTranscriptPath, '', 'utf-8');
  }
  if (!fs.existsSync(info.debugLogPath)) {
    fs.writeFileSync(info.debugLogPath, '', 'utf-8');
  }
  if (!fs.existsSync(info.figmaImportsPath)) {
    fs.writeFileSync(info.figmaImportsPath, '', 'utf-8');
  }
  if (!fs.existsSync(info.attachmentsIndexPath)) {
    fs.writeFileSync(info.attachmentsIndexPath, '[]', 'utf-8');
  }
  if (!fs.existsSync(info.localSettingsPath)) {
    fs.writeFileSync(
      info.localSettingsPath,
      JSON.stringify(
        {
          permissions: {
            allow: [],
            deny: [],
            ask: [],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
}

export function loadProjectMeta(info: ProjectStorageInfo): ProjectMeta | null {
  ensureProjectStorage(info);
  if (!fs.existsSync(info.projectMetaPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(info.projectMetaPath, 'utf-8');
    return JSON.parse(raw) as ProjectMeta;
  } catch {
    return null;
  }
}

export function saveProjectMeta(info: ProjectStorageInfo, previous?: ProjectMeta | null): ProjectMeta {
  ensureProjectStorage(info);
  const now = Date.now();
  const meta: ProjectMeta = Object.freeze({
    workspaceId: info.workspaceId,
    workspaceName: info.workspaceName,
    workspacePath: info.workspacePath,
    projectDirName: info.projectDirName,
    createdAt: previous?.createdAt ?? now,
    lastOpenedAt: now,
    storageVersion: STORAGE_VERSION,
  });

  fs.writeFileSync(info.projectMetaPath, JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}
