import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ensureProjectStorage, getProjectStorageInfo, type ProjectStorageInfo } from './project-store';

type ChromaState = Readonly<{
  port: number;
  url: string;
  updatedAt: number;
}>;

const CHROMA_HOST = '127.0.0.1';
const CHROMA_PORT_BASE = 41000;
const CHROMA_PORT_RANGE = 20000;
const CHROMA_PORT_SCAN_LIMIT = 256;
const CHROMA_HEALTH_TIMEOUT_MS = 750;
const CHROMA_START_TIMEOUT_MS = 8000;
const CHROMA_POLL_INTERVAL_MS = 200;

const startupByWorkspace = new Map<string, Promise<string | null>>();

function getPreferredPort(workspaceId: string): number {
  const seed = Number.parseInt(workspaceId.slice(0, 8), 16);
  return CHROMA_PORT_BASE + (Number.isFinite(seed) ? seed % CHROMA_PORT_RANGE : 0);
}

function getChromaUrl(port: number): string {
  return `http://${CHROMA_HOST}:${port}`;
}

function readState(storage: ProjectStorageInfo): ChromaState | null {
  try {
    if (!fs.existsSync(storage.chromaStatePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(storage.chromaStatePath, 'utf-8')) as Partial<ChromaState>;
    return typeof raw.port === 'number' && typeof raw.url === 'string' && raw.url.length > 0
      ? Object.freeze({
          port: raw.port,
          url: raw.url,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
        })
      : null;
  } catch {
    return null;
  }
}

function writeState(storage: ProjectStorageInfo, port: number): void {
  const state: ChromaState = Object.freeze({
    port,
    url: getChromaUrl(port),
    updatedAt: Date.now(),
  });
  fs.writeFileSync(storage.chromaStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

async function isPortOccupied(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: CHROMA_HOST, port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(CHROMA_HEALTH_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish(false);
        return;
      }
      finish(true);
    });
  });
}

async function isChromaHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHROMA_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/api/v2/heartbeat`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealthy(url: string): Promise<boolean> {
  const deadline = Date.now() + CHROMA_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isChromaHealthy(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, CHROMA_POLL_INTERVAL_MS));
  }
  return false;
}

async function findAvailablePort(preferredPort: number): Promise<number | null> {
  for (let step = 0; step < CHROMA_PORT_SCAN_LIMIT; step += 1) {
    const port = CHROMA_PORT_BASE + ((preferredPort - CHROMA_PORT_BASE + step) % CHROMA_PORT_RANGE);
    if (!(await isPortOccupied(port))) {
      return port;
    }
  }
  return null;
}

async function startManagedChroma(storage: ProjectStorageInfo): Promise<string | null> {
  const preferredPort = getPreferredPort(storage.workspaceId);
  const state = readState(storage);
  if (state && (await isChromaHealthy(state.url))) {
    return state.url;
  }

  const port = await findAvailablePort(state?.port ?? preferredPort);
  if (port === null) {
    return null;
  }

  const logFd = fs.openSync(storage.chromaLogPath, 'a');
  try {
    const child = spawn(
      'chroma',
      ['run', '--path', storage.chromaDirPath, '--host', CHROMA_HOST, '--port', String(port)],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      },
    );
    child.unref();
    fs.closeSync(logFd);
  } catch {
    fs.closeSync(logFd);
    return null;
  }

  if (!(await waitForHealthy(getChromaUrl(port)))) {
    return null;
  }

  writeState(storage, port);
  return getChromaUrl(port);
}

export async function resolveChromaUrl(workspacePath: string): Promise<string | null> {
  const envUrl = process.env.GALAXY_CHROMA_URL?.trim() || process.env.CHROMA_URL?.trim();
  if (envUrl) {
    return envUrl;
  }

  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  const inFlight = startupByWorkspace.get(storage.workspaceId);
  if (inFlight) {
    return inFlight;
  }

  const startup = startManagedChroma(storage).finally(() => {
    startupByWorkspace.delete(storage.workspaceId);
  });
  startupByWorkspace.set(storage.workspaceId, startup);
  return startup;
}
