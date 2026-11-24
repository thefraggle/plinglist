import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SERVER_URL,
  getDefaultServerUrl,
  normalizeServerUrl,
} from '../src/config.ts';
import { TRANSLATIONS, t } from '../src/i18n.ts';
import { resolveCompletionSoundSource } from '../src/audio.ts';
import { PlinglistStore, type StorageLike } from '../src/store.ts';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test('i18n dictionaries have 100% key parity between en and de', () => {
  const enKeys = Object.keys(TRANSLATIONS.en).sort();
  const deKeys = Object.keys(TRANSLATIONS.de).sort();

  assert.deepEqual(deKeys, enKeys);
  assert.equal(t('de', 'nav.myDay'), 'Mein Tag');
  assert.equal(t('en', 'nav.myDay'), 'My Day');
});

test('normalizeServerUrl defaults to official API and validates self-hosted URLs', () => {
  assert.equal(normalizeServerUrl(), DEFAULT_SERVER_URL);
  assert.equal(normalizeServerUrl('  '), DEFAULT_SERVER_URL);
  assert.equal(
    normalizeServerUrl('https://todo.example.org///'),
    'https://todo.example.org',
  );
  assert.equal(
    normalizeServerUrl('http://localhost:3001/'),
    'http://localhost:3001',
  );
  assert.throws(() => normalizeServerUrl('ftp://invalid.example.com'));
  assert.throws(() => normalizeServerUrl('not-a-url'));
});

test('getDefaultServerUrl resolves same-origin HTTP(S) URLs and falls back for non-web origins', () => {
  assert.equal(getDefaultServerUrl('https://plinglist.app/'), 'https://plinglist.app');
  assert.equal(getDefaultServerUrl('http://localhost:3001'), 'http://localhost:3001');
  assert.equal(getDefaultServerUrl('capacitor://localhost'), DEFAULT_SERVER_URL);
  assert.equal(getDefaultServerUrl(undefined), DEFAULT_SERVER_URL);
});

test('public audio defaults to CC0 synth unless brand overlay is applied', () => {
  assert.equal(resolveCompletionSoundSource(false), 'cc0-synth');
  assert.equal(resolveCompletionSoundSource(true), 'brand-overlay');
});

test('PlinglistStore persists tasks, steps, and spawns next recurring occurrence on completion', () => {
  const storage = createMemoryStorage();
  const store = new PlinglistStore({ storage, locale: 'de' });

  const task = store.addTask({
    title: 'Müll rausbringen',
    listId: store.getDefaultTasksListId(),
    dueDate: '2026-11-23',
    recurrence: 'weekly',
    myDayDate: '2026-11-23',
  });
  store.addTaskStep(task.id, 'Gelber Sack');
  store.toggleTaskStep(task.id, task.steps[0].id);

  const { completedTask, nextRecurringTask } = store.toggleTaskCompleted(task.id, '2026-11-23');
  assert.equal(completedTask.completed, true);
  assert.ok(nextRecurringTask);
  assert.equal(nextRecurringTask.completed, false);
  assert.equal(nextRecurringTask.dueDate, '2026-11-30');

  const reloaded = new PlinglistStore({ storage });
  assert.equal(reloaded.tasks.length, 2);
  assert.equal(reloaded.tasks.find((item) => item.id === task.id)?.steps[0].completed, true);
});

test('PlinglistStore auto-detects Wunderlist & MS To Do JSON imports and generates list share links', () => {
  const storage = createMemoryStorage();
  const store = new PlinglistStore({ storage, locale: 'en' });

  const customList = store.addList('Family');
  const { inviteUrl, list } = store.shareList(customList.id);
  assert.equal(list.shared, true);
  assert.match(inviteUrl, /^https:\/\/api\.plinglist\.app\/join\/inv-/);

  const wlStats = store.importJson(
    JSON.stringify({
      data: {
        lists: [{ id: 1, title: 'Wunderlist Import' }],
        tasks: [{ id: 10, list_id: 1, title: 'Old task', starred: true }],
        subtasks: [],
        notes: [],
      },
    }),
  );
  assert.equal(wlStats.importedLists, 1);
  assert.equal(wlStats.importedTasks, 1);

  const msStats = store.importJson(
    JSON.stringify({
      lists: [
        {
          id: 'ms1',
          displayName: 'MS To Do Import',
          tasks: [{ id: 't1', title: 'Migrate before June 2027' }],
        },
      ],
    }),
  );
  assert.equal(msStats.importedLists, 1);
  assert.equal(msStats.importedTasks, 1);
});

import type { AddressInfo } from 'node:net';
import { loadServerConfig } from '../../server/src/config.ts';
import { createServerApp } from '../../server/src/index.ts';
import { SqliteSyncRepository } from '../../server/src/sqlite-repo.ts';

test('end-to-end shared list sync between two devices via SqliteSyncRepository HTTP API', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    const storeA = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      nodeId: 'device-a',
      serverUrl,
    });
    const familyList = storeA.addList('Familie');
    const { list: sharedList } = storeA.shareList(familyList.id);
    const breadTask = storeA.addTask({ title: 'Brot holen', listId: sharedList.id });

    const pushA = await storeA.syncWithServer();
    assert.equal(pushA.synced, true);

    const storeB = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      nodeId: 'device-b',
      serverUrl,
    });
    const joined = await storeB.joinSharedListByToken(sharedList.inviteToken!);
    assert.equal(joined.title, 'Familie');

    const pulledTask = storeB.tasks.find((item) => item.id === breadTask.id);
    assert.ok(pulledTask);
    assert.equal(pulledTask.title, 'Brot holen');

    storeB.toggleTaskCompleted(breadTask.id, '2026-11-23');
    const pushB = await storeB.syncWithServer();
    assert.equal(pushB.synced, true);

    const pullA = await storeA.syncWithServer();
    assert.equal(pullA.synced, true);
    assert.equal(storeA.tasks.find((item) => item.id === breadTask.id)?.completed, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('zero-auth syncKey pairs two devices without accounts and store imports CSV exports', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    const phone = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      nodeId: 'phone-1',
      serverUrl,
    });
    const csvStats = phone.importJson(
      'Betreff;Liste;Erledigt;Priorität\nReisepass erneuern;Reisen;nein;hoch',
    );
    assert.equal(csvStats.importedLists, 1);
    assert.equal(csvStats.importedTasks, 1);
    assert.equal((await phone.syncWithServer()).synced, true);

    const laptop = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      nodeId: 'laptop-1',
      serverUrl,
    });
    laptop.setSyncKey(phone.syncKey);
    const syncRes = await laptop.syncWithServer();
    assert.equal(syncRes.synced, true);
    assert.ok(laptop.lists.some((l) => l.title === 'Reisen'));
    assert.ok(laptop.tasks.some((t) => t.title === 'Reisepass erneuern' && t.starred));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('store generates direct app invite URLs (?join=) and self-pairing URLs (?pair=)', () => {
  const store = new PlinglistStore({
    storage: createMemoryStorage(),
    locale: 'de',
    syncKey: 'pling-test-pair-9999',
  });
  const list = store.addList('Reise');
  const { inviteUrl, list: shared } = store.shareList(list.id, 'https://plinglist.app');
  assert.equal(
    inviteUrl,
    `https://plinglist.app/?join=${encodeURIComponent(shared.inviteToken!)}`,
  );
  assert.equal(
    store.getPairingUrl('https://plinglist.app/'),
    'https://plinglist.app/?pair=pling-test-pair-9999',
  );
});

test('build-app produces every asset precached in sw.js', () => {
  const rootDir = path.resolve(import.meta.dirname, '..', '..');
  const buildScript = path.join(rootDir, 'scripts', 'build-app.mjs');
  execFileSync(process.execPath, [buildScript], { cwd: rootDir, stdio: 'pipe' });

  const swSource = fs.readFileSync(path.join(rootDir, 'app', 'sw.js'), 'utf8');
  const assetsMatch = swSource.match(/const ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(assetsMatch, 'Expected ASSETS array in app/sw.js');

  const assetEntries = Array.from(assetsMatch[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]);
  assert.ok(assetEntries.includes('./app/src/store.js'), 'sw.js must precache store.js');
  assert.ok(
    assetEntries.includes('./packages/core/src/index.js'),
    'sw.js must precache core index.js',
  );

  const distDir = path.join(rootDir, 'app', 'dist');
  for (const entry of assetEntries) {
    if (entry === './') continue;
    const relPath = entry.replace(/^\.\//, '');
    const absPath = path.join(distDir, relPath);
    assert.ok(fs.existsSync(absPath), `Missing built asset for sw.js precache: ${relPath}`);
  }
});

test('PlinglistStore renames and soft-deletes custom lists while protecting the default tasks system list', () => {
  const storage = createMemoryStorage();
  const store = new PlinglistStore({ storage, locale: 'de' });
  const initialLists = store.getActiveLists();
  assert.equal(initialLists.length, 2);

  const defaultTasksId = store.getDefaultTasksListId();
  assert.equal(store.isSystemTasksList(defaultTasksId), true);
  assert.throws(() => store.renameList(defaultTasksId, 'Andere Inbox'));
  assert.throws(() => store.deleteList(defaultTasksId));

  const custom = store.addList('Projekt X');
  assert.equal(store.isSystemTasksList(custom.id), false);
  const taskInCustom = store.addTask({ title: 'Spec lesen', listId: custom.id });

  const renamed = store.renameList(custom.id, '  Projekt Y  ');
  assert.equal(renamed.title, 'Projekt Y');
  assert.throws(() => store.renameList(custom.id, '   '));

  store.deleteList(custom.id);
  assert.equal(
    store.getActiveLists().some((l) => l.id === custom.id),
    false,
  );
  const deletedList = store.lists.find((l) => l.id === custom.id);
  assert.ok(deletedList?.deletedAt);
  const deletedTask = store.tasks.find((t) => t.id === taskInCustom.id);
  assert.ok(deletedTask?.deletedAt);

  // Seeded groceries list can be deleted, while default tasks list remains protected
  const groceriesList = store.getActiveLists().find((l) => l.id !== defaultTasksId)!;
  store.deleteList(groceriesList.id);
  assert.equal(store.getActiveLists().length, 1);
  assert.equal(store.getActiveLists()[0].id, defaultTasksId);
  assert.throws(() => store.deleteList(defaultTasksId));
});

test('PlinglistStore supports read-only getInviteUrl and unshareList with server token invalidation', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;
    const store = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      serverUrl,
    });

    const list = store.addList('Urlaub');
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), null);

    const { inviteUrl, list: shared } = store.shareList(list.id, 'https://plinglist.app');
    const token = shared.inviteToken!;
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), inviteUrl);
    assert.equal((await store.syncWithServer()).synced, true);
    assert.ok(await repo.resolveInviteToken(token));

    const unshared = store.unshareList(list.id);
    assert.equal(unshared.shared, false);
    assert.equal(unshared.inviteToken, null);
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), null);

    assert.equal((await store.syncWithServer()).synced, true);
    assert.equal(await repo.resolveInviteToken(token), null);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});
