import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadServerConfig, type ServerConfig } from './config.ts';
import { SqliteSyncRepository } from './sqlite-repo.ts';
import {
  EntitlementRequiredError,
  InMemorySyncRepository,
  type EntitlementRecord,
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

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...API_CORS_HEADERS,
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

interface StripeWebhookPayload {
  type?: string;
  userId?: string;
  priceTier?: 'yearly' | 'lifetime';
  periodEndMs?: number | null;
}

interface RevenueCatWebhookPayload {
  type?: string;
  appUserId?: string;
  productId?: string;
  expirationAtMs?: number | null;
}

function normalizeWebhookPayload(
  provider: 'stripe' | 'revenuecat',
  raw: StripeWebhookPayload | RevenueCatWebhookPayload,
): EntitlementRecord {
  if (provider === 'stripe') {
    const event = raw as StripeWebhookPayload;
    const userId = event.userId?.trim();
    if (!userId) {
      throw new Error('Missing userId in Stripe webhook');
    }
    if (event.type === 'customer.subscription.deleted') {
      return { userId, plan: 'free', expiresAtMs: null, source: 'stripe' };
    }
    if (event.type === 'checkout.session.completed') {
      if (event.priceTier === 'lifetime') {
        return { userId, plan: 'pro_lifetime', expiresAtMs: null, source: 'stripe' };
      }
      return {
        userId,
        plan: 'pro_yearly',
        expiresAtMs: event.periodEndMs ?? null,
        source: 'stripe',
      };
    }
    throw new Error(`Unsupported Stripe event type: ${event.type ?? 'unknown'}`);
  }

  const event = raw as RevenueCatWebhookPayload;
  const userId = event.appUserId?.trim();
  if (!userId) {
    throw new Error('Missing appUserId in RevenueCat webhook');
  }
  if (event.type === 'EXPIRATION') {
    return { userId, plan: 'free', expiresAtMs: null, source: 'revenuecat' };
  }
  if (event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL') {
    const isLifetime = (event.productId ?? '').toLowerCase().includes('lifetime');
    return {
      userId,
      plan: isLifetime ? 'pro_lifetime' : 'pro_yearly',
      expiresAtMs: isLifetime ? null : (event.expirationAtMs ?? null),
      source: 'revenuecat',
    };
  }
  throw new Error(`Unsupported RevenueCat event type: ${event.type ?? 'unknown'}`);
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

    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      res.writeHead(204, API_CORS_HEADERS);
      res.end();
      return;
    }

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

    if (method === 'DELETE' && pathname === '/api/v1/sync') {
      try {
        const body = await readJsonBody<{ userId?: string; syncKey?: string }>(req);
        const callerUserId = body.userId?.trim() || '';
        const callerKey = body.syncKey?.trim() || callerUserId;
        if (!callerKey) {
          sendJson(res, 400, { error: 'MISSING_WORKSPACE_KEY' });
          return;
        }
        const deletedLists = (await repo.deleteWorkspace?.(callerKey, callerUserId)) ?? 0;
        sendJson(res, 200, { ok: true, deletedLists });
      } catch (err) {
        sendJson(res, 400, {
          error: 'INVALID_DELETE_REQUEST',
          message: err instanceof Error ? err.message : 'Bad request',
        });
      }
      return;
    }

    const webhookMatch = pathname.match(/^\/api\/v1\/cloud\/webhooks\/(stripe|revenuecat)$/);
    if (config.cloudExtensionEnabled && method === 'POST' && webhookMatch) {
      if (
        config.cloudWebhookSecret &&
        req.headers.authorization !== `Bearer ${config.cloudWebhookSecret}`
      ) {
        sendJson(res, 401, { error: 'UNAUTHORIZED_WEBHOOK' });
        return;
      }
      try {
        const provider = webhookMatch[1] as 'stripe' | 'revenuecat';
        const body = await readJsonBody<StripeWebhookPayload | RevenueCatWebhookPayload>(req);
        const entitlement = normalizeWebhookPayload(provider, body);
        repo.upsertEntitlement?.(entitlement);
        sendJson(res, 200, { ok: true, entitlement });
      } catch (err) {
        sendJson(res, 400, {
          error: 'INVALID_WEBHOOK_PAYLOAD',
          message: err instanceof Error ? err.message : 'Invalid webhook payload',
        });
      }
      return;
    }

    const inviteApiMatch = pathname.match(/^\/api\/v1\/invites\/([^/]+?)(?:\/join)?$/);
    if (inviteApiMatch && (method === 'POST' || method === 'GET')) {
      const token = decodeURIComponent(inviteApiMatch[1]);
      const list = await repo.resolveInviteToken?.(token);
      if (!list) {
        sendJson(res, 404, { error: 'INVITE_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, { list });
      return;
    }

    const joinPageMatch = pathname.match(/^\/join\/([^/]+)$/);
    if (joinPageMatch && method === 'GET') {
      const token = decodeURIComponent(joinPageMatch[1]);
      res.writeHead(302, {
        Location: `${config.publicBaseUrl}/?join=${encodeURIComponent(token)}`,
      });
      res.end();
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const normalizedPath = pathname === '/' || pathname === '/index.html' ? '/index.html' : pathname;
      const safeRelPath = path.posix.normalize(normalizedPath).replace(/^\/+/, '');
      const targetFile = path.resolve(distDir, safeRelPath);
      const isInsideDist =
        targetFile === distDir || targetFile.startsWith(`${distDir}${path.sep}`);

      if (
        isInsideDist &&
        fs.existsSync(targetFile) &&
        fs.statSync(targetFile).isFile()
      ) {
        const ext = path.extname(targetFile);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const isMutableEntry =
          ext === '.html' || path.basename(targetFile) === 'sw.js' || ext === '.webmanifest';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': isMutableEntry ? 'no-cache' : 'public, max-age=3600',
        });
        if (method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(targetFile).pipe(res);
        }
        return;
      }

      if (path.extname(pathname) !== '') {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }

      const notFoundHtml = [
        '<!doctype html>',
        '<html lang="de">',
        '<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />',
        '<title>404 — Plinglist</title><link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
        '<link rel="stylesheet" href="/styles.css" /></head>',
        '<body><main class="main-view">',
        '<h1>404 — Seite nicht gefunden</h1>',
        '<p class="empty-state">Dieser Pfad existiert auf Plinglist nicht.</p>',
        '<p><a href="/" class="btn-primary btn-compact">Zurück zu Plinglist</a></p>',
        '</main></body></html>',
      ].join('');
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(notFoundHtml);
      }
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadServerConfig();
  let repo!: SqliteSyncRepository;
  repo = new SqliteSyncRepository(
    config.sqlitePath,
    config.cloudExtensionEnabled && config.cloudEnforceEntitlements
      ? (callerKey) => repo.hasActiveEntitlement(callerKey)
      : undefined,
  );
  const server = createServerApp(config, repo);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `plinglist-app listening on http://0.0.0.0:${config.port} (sqlite=${config.sqlitePath})`,
    );
  });
}
