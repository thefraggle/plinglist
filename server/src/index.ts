import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadServerConfig, type ServerConfig } from './config.ts';
import {
  EntitlementRequiredError,
  InMemorySyncRepository,
  type SyncRepository,
  type SyncRequest,
} from './sync-engine.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > 2 * 1024 * 1024) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export function createServerApp(
  config: ServerConfig = loadServerConfig(),
  repo: SyncRepository = new InMemorySyncRepository(),
  distDir = path.resolve(import.meta.dirname, '..', '..', 'app', 'dist'),
): http.Server {
  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'plinglist-app',
        cloudExtensionEnabled: config.cloudExtensionEnabled,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/sync') {
      try {
        const body = await readJsonBody<SyncRequest>(req);
        const result = await repo.applyAndPullDeltas(body);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof EntitlementRequiredError) {
          sendJson(res, 403, { error: err.code, message: err.message });
          return;
        }
        sendJson(res, 400, {
          error: 'INVALID_SYNC_REQUEST',
          message: err instanceof Error ? err.message : 'Bad request',
        });
      }
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const normalizedPath = pathname === '/' ? '/index.html' : pathname;
      const safeRelPath = path.posix.normalize(normalizedPath).replace(/^\/+/, '');
      let targetFile = path.resolve(distDir, safeRelPath);

      if (!targetFile.startsWith(distDir) || !fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
        targetFile = path.join(distDir, 'index.html');
      }

      if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
        const ext = path.extname(targetFile);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        if (method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(targetFile).pipe(res);
        }
        return;
      }
    }

    sendJson(res, 404, { error: 'NOT_FOUND' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadServerConfig();
  const server = createServerApp(config);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`plinglist-app listening on http://0.0.0.0:${config.port}`);
  });
}
