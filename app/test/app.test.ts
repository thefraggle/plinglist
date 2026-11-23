import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from '../src/config.ts';
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

test('public audio defaults to CC0 synth unless brand overlay is applied', () => {
  assert.equal(resolveCompletionSoundSource(false), 'cc0-synth');
  assert.equal(resolveCompletionSoundSource(true), 'brand-overlay');
});

test('PlinglistStore persists tasks, steps, and spawns next recurring occurrence on completion', () => {
  const storage = createMemoryStorage();
  const store = new PlinglistStore({ storage, locale: 'de' });

  const task = store.addTask({
    title: 'Müll rausbringen',
    listId: 'list-tasks',
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
