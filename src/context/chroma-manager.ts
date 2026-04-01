/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Local Chroma runtime manager for per-workspace vector storage.
 */

import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ChromaClient } from 'chromadb';
import type { ChromaState } from './entities/chroma';
import {
  CHROMA_HEALTH_TIMEOUT_MS,
  CHROMA_HOST,
  CHROMA_POLL_INTERVAL_MS,
  CHROMA_PORT_BASE,
  CHROMA_PORT_RANGE,
  CHROMA_PORT_SCAN_LIMIT,
  CHROMA_START_TIMEOUT_MS,
} from './entities/constants';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';
import type { ProjectStorageInfo } from './entities/project-store';

const startupByWorkspace = new Map<string, Promise<string | null>>();

/**
 * Derives a stable preferred port from the workspace id.
 *
 * @param workspaceId Stable workspace identifier.
 * @returns Preferred local Chroma port within the configured scan range.
 */
function getPreferredPort(workspaceId: string): number {
  const seed = Number.parseInt(workspaceId.slice(0, 8), 16);
  return CHROMA_PORT_BASE + (Number.isFinite(seed) ? seed % CHROMA_PORT_RANGE : 0);
}

/**
 * Builds the local Chroma URL for a given port.
 *
 * @param port Local TCP port.
 * @returns HTTP base URL used to reach the local Chroma instance.
 */
function getChromaUrl(port: number): string {
  return `http://${CHROMA_HOST}:${port}`;
}

/**
 * Creates a Chroma client using host/port/ssl fields instead of deprecated path mode.
 *
 * @param url Chroma base URL resolved for the current workspace.
 * @returns Ready-to-use Chroma client targeting the resolved endpoint.
 */
export function createChromaClient(url: string): ChromaClient {
  const parsedUrl = new URL(url);
  const port =
    parsedUrl.port.length > 0
      ? Number.parseInt(parsedUrl.port, 10)
      : parsedUrl.protocol === 'https:'
        ? 443
        : 80;

  return new ChromaClient({
    host: parsedUrl.hostname,
    port,
    ssl: parsedUrl.protocol === 'https:',
  });
}

/**
 * Reads previously persisted Chroma runtime state from disk.
 *
 * @param storage Workspace storage descriptor.
 * @returns Persisted Chroma state when available and valid.
 */
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

/**
 * Persists the current Chroma runtime state for later reuse.
 *
 * @param storage Workspace storage descriptor.
 * @param port Local Chroma port to persist.
 */
function writeState(storage: ProjectStorageInfo, port: number): void {
  const state: ChromaState = Object.freeze({
    port,
    url: getChromaUrl(port),
    updatedAt: Date.now(),
  });
  fs.writeFileSync(storage.chromaStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Checks whether a local port is already occupied.
 *
 * @param port Local TCP port to probe.
 * @returns `true` when the port is already in use.
 */
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

/**
 * Calls the Chroma heartbeat endpoint to verify server health.
 *
 * @param url Chroma base URL.
 * @returns `true` when the heartbeat responds successfully.
 */
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

/**
 * Waits until a just-started Chroma instance becomes healthy or times out.
 *
 * @param url Chroma base URL.
 * @returns `true` when the server becomes healthy before the deadline.
 */
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

/**
 * Finds the first available local port near the preferred Chroma port.
 *
 * @param preferredPort Workspace-preferred local port.
 * @returns Available local port or `null` when none is found in the scan window.
 */
async function findAvailablePort(preferredPort: number): Promise<number | null> {
  for (let step = 0; step < CHROMA_PORT_SCAN_LIMIT; step += 1) {
    const port = CHROMA_PORT_BASE + ((preferredPort - CHROMA_PORT_BASE + step) % CHROMA_PORT_RANGE);
    if (!(await isPortOccupied(port))) {
      return port;
    }
  }
  return null;
}

/**
 * Starts or reuses a managed local Chroma instance for a workspace.
 *
 * @param storage Workspace storage descriptor.
 * @returns Resolved local Chroma URL or `null` when startup fails.
 */
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

/**
 * Resolves the Chroma URL for a workspace, preferring explicit environment configuration.
 *
 * @param workspacePath Absolute workspace path.
 * @returns External or managed local Chroma URL, or `null` when unavailable.
 */
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
