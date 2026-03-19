import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FigmaImportRequest } from './design-types';

export const FIGMA_BRIDGE_HOST = '127.0.0.1';
export const FIGMA_BRIDGE_PORT = 47123;

export type FigmaBridgeImportHandler = (payload: FigmaImportRequest) => Promise<Readonly<{
  importId: string;
  storedAt: string;
  summary: string;
}>>;

export type FigmaBridgeServer = Readonly<{
  host: string;
  port: number;
  stop(): Promise<void>;
}>;

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(payload));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFigmaImportRequest(value: unknown): value is FigmaImportRequest {
  if (!isObject(value) || value.source !== 'figma-plugin' || !isObject(value.document)) {
    return false;
  }

  const document = value.document as Record<string, unknown>;
  return document.source === 'figma' && document.version === 1 && Array.isArray(document.selection);
}

export async function startFigmaBridgeServer(opts: {
  onImport: FigmaBridgeImportHandler;
}): Promise<FigmaBridgeServer> {
  const server = http.createServer(async (request, response) => {
    const { method = 'GET', url = '/' } = request;

    if (method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    if (method === 'GET' && url === '/health') {
      sendJson(response, 200, {
        ok: true,
        app: 'galaxy-code-vscode',
        port: FIGMA_BRIDGE_PORT,
      });
      return;
    }

    if (method === 'POST' && url === '/figma/import') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      request.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const parsed = JSON.parse(raw) as unknown;
          if (!isFigmaImportRequest(parsed)) {
            sendJson(response, 400, {
              ok: false,
              error: 'Invalid Figma import payload.',
            });
            return;
          }

          const result = await opts.onImport(parsed);
          sendJson(response, 200, {
            ok: true,
            ...result,
          });
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'Not found',
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(FIGMA_BRIDGE_PORT, FIGMA_BRIDGE_HOST, () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  return Object.freeze({
    host: address?.address ?? FIGMA_BRIDGE_HOST,
    port: address?.port ?? FIGMA_BRIDGE_PORT,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  });
}
