import crypto from 'node:crypto';
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

const SECURITY_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://stats.goork.de; connect-src 'self' https: http:; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderDynamicIndexHtml(
  rawHtml: string,
  requestUrl: URL,
  config: ServerConfig,
  repo: SyncRepository,
): Promise<{ html: string; hasSensitiveQuery: boolean }> {
  const joinToken = requestUrl.searchParams.get('join')?.trim() || '';
  const pairKey = requestUrl.searchParams.get('pair')?.trim() || '';
  const hasSensitiveQuery = Boolean(joinToken || pairKey);

  let title = 'Plinglist — Pling. Done.';
  let description =
    'Pling. Done. – Die einfache To-Do- & Einkaufsliste, die bleibt. Sofort lokal speichern, offline nutzen und ohne Account per Link synchronisieren.';
  let ogUrl = `${config.publicBaseUrl}/`;
  const ogImage = `${config.publicBaseUrl}/og-image.png`;

  if (joinToken) {
    let listTitle = '';
    try {
      const sharedList = await repo.resolveInviteToken?.(joinToken);
      listTitle = sharedList?.title?.trim() || '';
    } catch {
      listTitle = '';
    }
    title = listTitle
      ? `Einladung zur Liste „${listTitle}“ — Plinglist`
      : 'Geteilte Liste — Plinglist';
    description =
      'Pling. Done. – Gemeinsame To-Do- & Einkaufsliste öffnen (direkt in der Plinglist App oder im Browser, ohne Konto).';
    ogUrl = `${config.publicBaseUrl}/?join=${encodeURIComponent(joinToken)}`;
  } else if (pairKey) {
    title = 'Gerät mit Plinglist koppeln — Pling. Done.';
    description =
      'Öffne diesen Link auf deinem Smartphone, Tablet oder Computer, um deine Plinglist-Aufgaben über deinen privaten Sync-Key zu koppeln.';
    ogUrl = `${config.publicBaseUrl}/?pair=${encodeURIComponent(pairKey)}`;
  }

  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeUrl = escapeHtml(ogUrl);
  const safeImg = escapeHtml(ogImage);

  let html = rawHtml
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${safeDesc}" />`)
    .replace(/<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${safeTitle}" />`)
    .replace(
      /<meta\s+property="og:description"[^>]*>/i,
      `<meta property="og:description" content="${safeDesc}" />`,
    )
    .replace(/<meta\s+property="og:url"[^>]*>/i, `<meta property="og:url" content="${safeUrl}" />`)
    .replace(/<meta\s+property="og:image"[^>]*>/i, `<meta property="og:image" content="${safeImg}" />`)
    .replace(/<meta\s+name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${safeTitle}" />`)
    .replace(
      /<meta\s+name="twitter:description"[^>]*>/i,
      `<meta name="twitter:description" content="${safeDesc}" />`,
    )
    .replace(/<meta\s+name="twitter:image"[^>]*>/i, `<meta name="twitter:image" content="${safeImg}" />`);

  if (hasSensitiveQuery && !html.includes('name="robots"')) {
    html = html.replace('</head>', '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
  }

  return { html, hasSensitiveQuery };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...API_CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function isValidBearerSecret(
  authHeader: string | undefined,
  expectedSecret: string | undefined,
): boolean {
  const expected = expectedSecret?.trim();
  if (!expected || !authHeader) {
    return false;
  }
  const actualBuf = Buffer.from(authHeader, 'utf8');
  const expectedBuf = Buffer.from(`Bearer ${expected}`, 'utf8');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSyncRequest(raw: unknown): SyncRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Sync request body must be a JSON object');
  }
  if (typeof raw.userId !== 'string' || !raw.userId.trim() || raw.userId.length > 128) {
    throw new Error('userId must be a non-empty string');
  }
  if (raw.syncKey !== undefined && (typeof raw.syncKey !== 'string' || raw.syncKey.length > 256)) {
    throw new Error('syncKey must be a string');
  }
  if (raw.sinceHlc !== undefined && raw.sinceHlc !== null && typeof raw.sinceHlc !== 'string') {
    throw new Error('sinceHlc must be a string or null');
  }
  if (raw.inviteTokens !== undefined) {
    if (!isPlainObject(raw.inviteTokens)) {
      throw new Error('inviteTokens must be an object');
    }
    const entries = Object.entries(raw.inviteTokens);
    if (entries.length > 500) {
      throw new Error('Too many inviteTokens');
    }
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw new Error('inviteTokens entries must be strings');
      }
    }
  }
  if (!Array.isArray(raw.listIds) || raw.listIds.length > 1000) {
    throw new Error('listIds must be an array');
  }
  for (const id of raw.listIds) {
    if (typeof id !== 'string' || id.length > 256) {
      throw new Error('listIds elements must be strings');
    }
  }
  if (raw.clientLists !== undefined) {
    if (!Array.isArray(raw.clientLists) || raw.clientLists.length > 1000) {
      throw new Error('clientLists must be an array');
    }
    for (const list of raw.clientLists) {
      if (!isPlainObject(list) || typeof list.id !== 'string' || typeof list.hlc !== 'string') {
        throw new Error('clientLists entries must have string id and hlc');
      }
    }
  }
  if (!Array.isArray(raw.clientTasks) || raw.clientTasks.length > 5000) {
    throw new Error('clientTasks must be an array');
  }
  for (const task of raw.clientTasks) {
    if (
      !isPlainObject(task) ||
      typeof task.id !== 'string' ||
      typeof task.listId !== 'string' ||
      typeof task.hlc !== 'string'
    ) {
      throw new Error('clientTasks entries must have string id, listId, and hlc');
    }
  }
  return raw as unknown as SyncRequest;
}

function createFixedWindowRateLimiter(windowMs: number, maxRequests: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now = Date.now()): boolean => {
    if (buckets.size > 10_000) {
      for (const [k, entry] of buckets.entries()) {
        if (entry.resetAt <= now) {
          buckets.delete(k);
        }
      }
    }
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= maxRequests) {
      return false;
    }
    existing.count += 1;
    return true;
  };
}

function getClientIp(req: IncomingMessage): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
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
  const syncRateLimiter = createFixedWindowRateLimiter(60_000, 240);
  const inviteRateLimiter = createFixedWindowRateLimiter(60_000, 60);

  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    const clientIp = getClientIp(req);

    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      res.writeHead(204, { ...SECURITY_HEADERS, ...API_CORS_HEADERS });
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
      if (!syncRateLimiter(clientIp)) {
        sendJson(res, 429, { error: 'RATE_LIMIT_EXCEEDED' });
        return;
      }
      try {
        const rawBody = await readJsonBody<unknown>(req);
        const body = validateSyncRequest(rawBody);
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
      if (!syncRateLimiter(clientIp)) {
        sendJson(res, 429, { error: 'RATE_LIMIT_EXCEEDED' });
        return;
      }
      try {
        const body = await readJsonBody<unknown>(req);
        if (
          !isPlainObject(body) ||
          (body.userId !== undefined && typeof body.userId !== 'string') ||
          (body.syncKey !== undefined && typeof body.syncKey !== 'string')
        ) {
          sendJson(res, 400, { error: 'INVALID_DELETE_REQUEST' });
          return;
        }
        const callerUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const callerKey =
          (typeof body.syncKey === 'string' ? body.syncKey.trim() : '') || callerUserId;
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
      if (!isValidBearerSecret(req.headers.authorization, config.cloudWebhookSecret)) {
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
      if (!inviteRateLimiter(clientIp)) {
        sendJson(res, 429, { error: 'RATE_LIMIT_EXCEEDED' });
        return;
      }
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
        ...SECURITY_HEADERS,
        Location: `${config.publicBaseUrl}/?join=${encodeURIComponent(token)}`,
      });
      res.end();
      return;
    }

    if (method === 'GET' && pathname === '/.well-known/apple-app-site-association') {
      sendJson(res, 200, {
        applinks: {
          details: [
            {
              appIDs: [`${config.appleTeamId}.${config.appBundleId}`],
              components: [
                { '/': '/join/*' },
                { '/': '/', '?': { join: '?*' } },
                { '/': '/', '?': { pair: '?*' } },
              ],
            },
          ],
        },
      });
      return;
    }

    if (method === 'GET' && pathname === '/.well-known/assetlinks.json') {
      sendJson(res, 200, [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: config.appBundleId,
            sha256_cert_fingerprints: config.androidCertSha256Fingerprints,
          },
        },
      ]);
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
        if (normalizedPath === '/index.html' && method === 'GET') {
          const rawHtml = fs.readFileSync(targetFile, 'utf8');
          const { html, hasSensitiveQuery } = await renderDynamicIndexHtml(
            rawHtml,
            requestUrl,
            config,
            repo,
          );
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': contentType,
            'Cache-Control': hasSensitiveQuery ? 'no-cache, no-store' : 'no-cache',
            ...(hasSensitiveQuery ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
          });
          res.end(html);
          return;
        }
        const isMutableEntry =
          ext === '.html' ||
          ext === '.js' ||
          ext === '.css' ||
          path.basename(targetFile) === 'sw.js' ||
          ext === '.webmanifest';
        res.writeHead(200, {
          ...SECURITY_HEADERS,
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
        ...SECURITY_HEADERS,
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
