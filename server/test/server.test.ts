import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHlc, type TaskItem } from '../../packages/core/src/index.ts';
import {
  EntitlementRequiredError,
  InMemorySyncRepository,
} from '../src/sync-engine.ts';

function makeTask(id: string, hlc: string, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    listId: 'list-shared',
    title: `Task ${id}`,
    completed: false,
    completedAt: null,
    starred: false,
    myDayDate: null,
    dueDate: null,
    reminderAt: null,
    recurrence: null,
    note: '',
    steps: [],
    createdAt: '2026-11-23T10:00:00Z',
    updatedAt: '2026-11-23T10:00:00Z',
    deletedAt: null,
    hlc,
    ...overrides,
  };
}

test('self-hosted sync engine merges deltas idempotently and filters by sinceHlc cursor', async () => {
  const repo = new InMemorySyncRepository();
  const h1 = formatHlc(1000, 0, 'dev-a');
  const h2 = formatHlc(2000, 0, 'dev-b');

  const firstPush = await repo.applyAndPullDeltas({
    userId: 'user-1',
    listIds: ['list-shared'],
    clientTasks: [makeTask('t1', h1)],
    sinceHlc: null,
  });

  assert.equal(firstPush.acceptedCount, 1);
  assert.equal(firstPush.serverTasks.length, 1);
  assert.equal(firstPush.cursorHlc, h1);

  const secondPush = await repo.applyAndPullDeltas({
    userId: 'user-2',
    listIds: ['list-shared'],
    clientTasks: [makeTask('t2', h2)],
    sinceHlc: h1,
  });

  assert.equal(secondPush.acceptedCount, 1);
  assert.deepEqual(
    secondPush.serverTasks.map((t) => t.id),
    ['t2'],
  );
  assert.equal(secondPush.cursorHlc, h2);
});

test('cloud entitlement guard blocks sync when user lacks Pro/Lifetime entitlement', async () => {
  const cloudRepo = new InMemorySyncRepository((userId) => userId === 'pro-user');

  await assert.rejects(
    () =>
      cloudRepo.applyAndPullDeltas({
        userId: 'free-user',
        listIds: ['list-shared'],
        clientTasks: [],
      }),
    EntitlementRequiredError,
  );

  const allowed = await cloudRepo.applyAndPullDeltas({
    userId: 'pro-user',
    listIds: ['list-shared'],
    clientTasks: [],
  });
  assert.equal(allowed.acceptedCount, 0);
});

import type { AddressInfo } from 'node:net';
import { loadServerConfig } from '../src/config.ts';
import { createServerApp } from '../src/index.ts';

test('HTTP server exposes GET /api/health and POST /api/v1/sync', async () => {
  const server = createServerApp(loadServerConfig({ PORT: '0' }), new InMemorySyncRepository());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { status: string; service: string };
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.service, 'plinglist-app');

    const h1 = formatHlc(5000, 0, 'http-client');
    const syncRes = await fetch(`${baseUrl}/api/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-http',
        listIds: ['list-shared'],
        clientTasks: [makeTask('t-http', h1)],
        sinceHlc: null,
      }),
    });
    assert.equal(syncRes.status, 200);
    const syncBody = (await syncRes.json()) as { acceptedCount: number; cursorHlc: string };
    assert.equal(syncBody.acceptedCount, 1);
    assert.equal(syncBody.cursorHlc, h1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskList } from '../../packages/core/src/index.ts';
import { SqliteSyncRepository } from '../src/sqlite-repo.ts';

function makeList(id: string, hlc: string, overrides: Partial<TaskList> = {}): TaskList {
  return {
    id,
    title: `List ${id}`,
    shared: false,
    inviteToken: null,
    createdAt: '2026-11-23T10:00:00Z',
    updatedAt: '2026-11-23T10:00:00Z',
    deletedAt: null,
    hlc,
    ...overrides,
  };
}

test('SqliteSyncRepository persists lists and tasks in WAL mode across reopen and resolves invites', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plinglist-sqlite-'));
  const dbPath = path.join(tmpDir, 'plinglist.db');
  const h1 = formatHlc(1000, 0, 'dev-a');
  const h2 = formatHlc(2000, 0, 'dev-b');

  try {
    const repo1 = new SqliteSyncRepository(dbPath);
    const sharedList = makeList('list-family', h1, {
      title: 'Familie',
      shared: true,
      inviteToken: 'inv-family-1',
    });
    const pushRes = await repo1.applyAndPullDeltas({
      userId: 'user-a',
      listIds: ['list-family'],
      clientLists: [sharedList],
      clientTasks: [makeTask('t-milk', h2, { listId: 'list-family', title: 'Milch' })],
      sinceHlc: null,
    });
    assert.equal(pushRes.acceptedCount, 2);
    repo1.close();

    const repo2 = new SqliteSyncRepository(dbPath);
    const resolved = await repo2.resolveInviteToken('inv-family-1');
    assert.ok(resolved);
    assert.equal(resolved.title, 'Familie');

    const pullRes = await repo2.applyAndPullDeltas({
      userId: 'user-b',
      inviteTokens: { 'list-family': 'inv-family-1' },
      listIds: ['list-family'],
      clientLists: [],
      clientTasks: [],
      sinceHlc: null,
    });
    assert.equal(pullRes.serverLists?.length, 1);
    assert.equal(pullRes.serverTasks.length, 1);
    assert.equal(pullRes.serverTasks[0].title, 'Milch');
    repo2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP server handles CORS OPTIONS preflight, invite join API, and /join/:token redirect', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const h1 = formatHlc(3000, 0, 'dev-a');
  await repo.applyAndPullDeltas({
    userId: 'user-a',
    listIds: ['list-shared'],
    clientLists: [
      makeList('list-shared', h1, {
        title: 'Einkauf',
        shared: true,
        inviteToken: 'inv-abc',
      }),
    ],
    clientTasks: [],
  });

  const server = createServerApp(
    loadServerConfig({ PORT: '0', PUBLIC_BASE_URL: 'https://plinglist.app' }),
    repo,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const optRes = await fetch(`${baseUrl}/api/v1/sync`, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');

    const joinRes = await fetch(`${baseUrl}/api/v1/invites/inv-abc/join`, { method: 'POST' });
    assert.equal(joinRes.status, 200);
    const joinBody = (await joinRes.json()) as { list: TaskList };
    assert.equal(joinBody.list.id, 'list-shared');

    const missingRes = await fetch(`${baseUrl}/api/v1/invites/unknown/join`, { method: 'POST' });
    assert.equal(missingRes.status, 404);

    const redirectRes = await fetch(`${baseUrl}/join/inv-abc`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get('location'), 'https://plinglist.app/?join=inv-abc');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('zero-auth capability isolation blocks cross-workspace access while allowing syncKey pairing and inviteToken guests', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const h1 = formatHlc(6000, 0, 'owner-1');
  const h2 = formatHlc(7000, 0, 'attacker');

  try {
    await repo.applyAndPullDeltas({
      userId: 'u-alice',
      syncKey: 'pling-alice-key-1111',
      listIds: ['list-private', 'list-shared'],
      clientLists: [
        makeList('list-private', h1, { title: 'Alice Private' }),
        makeList('list-shared', h1, {
          title: 'Shared Groceries',
          shared: true,
          inviteToken: 'inv-groceries-99',
        }),
      ],
      clientTasks: [
        makeTask('t-secret', h1, { listId: 'list-private', title: 'Secret Note' }),
        makeTask('t-oat', h1, { listId: 'list-shared', title: 'Oat Milk' }),
      ],
    });

    // Unauthorized caller guessing the same listId cannot overwrite or pull Alice's private list
    const intruderRes = await repo.applyAndPullDeltas({
      userId: 'u-bob',
      syncKey: 'pling-bob-key-2222',
      listIds: ['list-private'],
      clientLists: [makeList('list-private', h2, { title: 'Hijacked' })],
      clientTasks: [makeTask('t-secret', h2, { listId: 'list-private', title: 'Hijacked Task' })],
    });
    assert.equal(intruderRes.acceptedCount, 0);
    assert.equal(intruderRes.serverLists?.length, 0);
    assert.equal(intruderRes.serverTasks.length, 0);

    // Alice's second device using the same syncKey pulls all owned lists & tasks automatically
    const aliceSecondDevice = await repo.applyAndPullDeltas({
      userId: 'u-alice-phone',
      syncKey: 'pling-alice-key-1111',
      listIds: [],
      clientLists: [],
      clientTasks: [],
    });
    assert.equal(aliceSecondDevice.serverLists?.length, 2);
    assert.equal(aliceSecondDevice.serverTasks.length, 2);
    assert.equal(
      aliceSecondDevice.serverLists?.find((l) => l.id === 'list-private')?.title,
      'Alice Private',
    );

    // Guest with valid inviteToken can sync the shared list without knowing Alice's syncKey
    const guestRes = await repo.applyAndPullDeltas({
      userId: 'u-guest',
      syncKey: 'pling-guest-key-3333',
      inviteTokens: { 'list-shared': 'inv-groceries-99' },
      listIds: ['list-shared'],
      clientLists: [],
      clientTasks: [
        makeTask('t-oat', h2, {
          listId: 'list-shared',
          title: 'Oat Milk',
          completed: true,
        }),
      ],
    });
    assert.equal(guestRes.acceptedCount, 1);
    assert.equal(guestRes.serverTasks.find((t) => t.id === 't-oat')?.completed, true);
  } finally {
    repo.close();
  }
});

test('cloud webhook activates Stripe/RevenueCat entitlement in SQLite and unblocks enforced sync', async () => {
  let repo!: SqliteSyncRepository;
  repo = new SqliteSyncRepository(':memory:', (callerKey) => repo.hasActiveEntitlement(callerKey));
  const server = createServerApp(
    loadServerConfig({
      PORT: '0',
      CLOUD_EXTENSION_ENABLED: 'true',
      CLOUD_ENFORCE_ENTITLEMENTS: 'true',
      CLOUD_WEBHOOK_SECRET: 'sec-123',
    }),
    repo,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const h1 = formatHlc(8000, 0, 'pro-dev');

    const blockedRes = await fetch(`${baseUrl}/api/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'u-pro',
        syncKey: 'pling-pro-key-4444',
        listIds: ['list-shared'],
        clientTasks: [makeTask('t-pro', h1)],
      }),
    });
    assert.equal(blockedRes.status, 403);
    const blockedBody = (await blockedRes.json()) as { error: string };
    assert.equal(blockedBody.error, 'PRO_ENTITLEMENT_REQUIRED');

    const unauthorizedHook = await fetch(`${baseUrl}/api/v1/cloud/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        userId: 'pling-pro-key-4444',
        priceTier: 'lifetime',
      }),
    });
    assert.equal(unauthorizedHook.status, 401);

    const webhookRes = await fetch(`${baseUrl}/api/v1/cloud/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec-123' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        userId: 'pling-pro-key-4444',
        priceTier: 'lifetime',
      }),
    });
    assert.equal(webhookRes.status, 200);
    const webhookBody = (await webhookRes.json()) as {
      ok: boolean;
      entitlement: { plan: string; userId: string };
    };
    assert.equal(webhookBody.ok, true);
    assert.equal(webhookBody.entitlement.plan, 'pro_lifetime');

    const allowedRes = await fetch(`${baseUrl}/api/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'u-pro',
        syncKey: 'pling-pro-key-4444',
        listIds: ['list-shared'],
        clientTasks: [makeTask('t-pro', h1)],
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = (await allowedRes.json()) as { acceptedCount: number };
    assert.equal(allowedBody.acceptedCount, 1);

    const rcRes = await fetch(`${baseUrl}/api/v1/cloud/webhooks/revenuecat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec-123' },
      body: JSON.stringify({
        type: 'EXPIRATION',
        appUserId: 'pling-pro-key-4444',
        productId: 'plinglist_pro_yearly',
      }),
    });
    assert.equal(rcRes.status, 200);
    assert.equal(repo.hasActiveEntitlement('pling-pro-key-4444'), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('server upgrades legacy userId ownership to syncKey and advances watermark HLC for older offline tasks', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const hOld = formatHlc(5000, 0, 'dev-a');
  const hNew = formatHlc(9000, 0, 'dev-b');

  try {
    // 1. Legacy v0.1.1 upload without syncKey (stored under userId 'usr-legacy-1')
    await repo.applyAndPullDeltas({
      userId: 'usr-legacy-1',
      listIds: ['list-legacy'],
      clientLists: [makeList('list-legacy', hOld, { title: 'Legacy Inbox' })],
      clientTasks: [],
    });

    // 2. Device B pairs with syncKey 'pling-upgraded-1111' and syncs newer record at hNew
    const devBFirst = await repo.applyAndPullDeltas({
      userId: 'usr-dev-b',
      syncKey: 'pling-upgraded-1111',
      listIds: ['list-b'],
      clientLists: [makeList('list-b', hNew, { title: 'Device B List' })],
      clientTasks: [],
    });
    assert.ok(devBFirst.cursorHlc);

    // 3. Legacy device upgrades to syncKey 'pling-upgraded-1111' while still sending userId 'usr-legacy-1'
    //    and pushes an offline/older task with hOld < hNew
    const devAUpgrade = await repo.applyAndPullDeltas({
      userId: 'usr-legacy-1',
      syncKey: 'pling-upgraded-1111',
      listIds: ['list-legacy'],
      clientLists: [makeList('list-legacy', hOld, { title: 'Legacy Inbox' })],
      clientTasks: [makeTask('t-offline-old', hOld, { listId: 'list-legacy', title: 'Offline Task' })],
    });
    assert.equal(devAUpgrade.acceptedCount, 2);

    // 4. Device B pulls with its previous cursorHlc (hNew) and MUST receive the older offline task & upgraded list
    const devBSecond = await repo.applyAndPullDeltas({
      userId: 'usr-dev-b',
      syncKey: 'pling-upgraded-1111',
      listIds: ['list-b'],
      clientLists: [],
      clientTasks: [],
      sinceHlc: devBFirst.cursorHlc,
    });
    assert.ok(devBSecond.serverLists?.some((l) => l.id === 'list-legacy'));
    assert.ok(devBSecond.serverTasks.some((t) => t.id === 't-offline-old'));
  } finally {
    repo.close();
  }
});
