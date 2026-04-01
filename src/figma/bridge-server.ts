/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Lightweight local HTTP bridge that accepts Figma imports from the companion plugin and forwards them into Galaxy storage.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FIGMA_BRIDGE_HOST, FIGMA_BRIDGE_PORT } from '../shared/constants';
import type { FigmaBridgeImportHandler, FigmaBridgeServer, FigmaImportRequest } from '../shared/figma';

/**
 * Sends one JSON response with the standard bridge CORS headers.
 *
 * @param response Node HTTP response object.
 * @param statusCode HTTP status code to send.
 * @param payload JSON payload body.
 */
function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Checks whether a value is a non-null object.
 *
 * @param value Unknown value to test.
 * @returns `true` when the value is object-like.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates whether an unknown payload matches the expected Figma import request shape.
 *
 * @param value Unknown JSON payload.
 * @returns `true` when the payload looks like a supported Figma import request.
 */
function isFigmaImportRequest(value: unknown): value is FigmaImportRequest {
  if (!isObject(value) || value.source !== 'figma-plugin' || !isObject(value.document)) {
    return false;
  }

  const document = value.document as Record<string, unknown>;
  return document.source === 'figma' && document.version === 1 && Array.isArray(document.selection);
}

/**
 * Starts the local Figma bridge server used by the Galaxy companion plugin.
 *
 * @param opts Import callback invoked when a valid payload is received.
 * @returns Running bridge server handle.
 */
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
