import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SERVER_URL,
  OFFICIAL_APP_ORIGIN,
  UMAMI_APP_WEBSITE_ID,
  detectNativeOsInfo,
  extractInviteTokenFromInput,
  extractSyncKeyFromInput,
  getDefaultServerUrl,
  getShareBaseOrigin,
  isNativeShellOrigin,
  isOfficialCloudOrigin,
  normalizeServerUrl,
} from '../src/config.ts';
import { TRANSLATIONS, t } from '../src/i18n.ts';
import { CHIME_MASTER_GAIN, resolveCompletionSoundSource } from '../src/audio.ts';
import { PlinglistStore, SharedListLimitError, generateSyncKey, type StorageLike } from '../src/store.ts';

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
  assert.equal(t('de', 'toast.plingDone'), 'Pling. Done.');
  assert.equal(t('en', 'toast.plingDone'), 'Pling. Done.');
  assert.equal(
    t('de', 'task.emptyView'),
    'Pling. Done. — Alles erledigt. Bereit für neue Aufgaben.',
  );
  assert.equal(
    t('en', 'task.emptyView'),
    'Pling. Done. — Nothing open here. Ready when you are.',
  );
  assert.match(t('de', 'legal.copyrightBody'), /Microsoft Corporation/i);
  assert.match(t('en', 'legal.copyrightBody'), /Microsoft Corporation/i);
  assert.match(t('de', 'legal.priv2Body'), /Apple.*Google|Push-Server/i);
  assert.match(t('en', 'legal.priv2Body'), /Apple.*Google|push server/i);
  assert.match(t('de', 'legal.priv3Body'), /30-Tage|30 Tage|Snapshots/i);
  assert.match(t('en', 'legal.priv3Body'), /30-day|snapshots/i);
  assert.match(t('de', 'help.step1Body'), /Geplant.*Mir zugewiesen/i);
  assert.match(t('en', 'help.step1Body'), /Planned.*Assigned to me/i);
  assert.match(t('de', 'help.step2Body'), /@Name/i);
  assert.match(t('en', 'help.step2Body'), /@name/i);
  assert.match(t('de', 'help.step4Body'), /7 Tage/i);
  assert.match(t('en', 'help.step4Body'), /7 days/i);
  assert.match(t('de', 'help.step4Body'), /outlook\.live\.com.*account\.microsoft\.com\/privacy/i);
  assert.match(t('en', 'help.step4Body'), /outlook\.live\.com.*account\.microsoft\.com\/privacy/i);
  assert.match(t('de', 'importer.description'), /outlook\.live\.com.*account\.microsoft\.com\/privacy/i);
  assert.match(t('en', 'importer.description'), /outlook\.live\.com.*account\.microsoft\.com\/privacy/i);
  assert.match(t('de', 'help.tipsBody'), /#tags.*Ordner/i);
  assert.match(t('en', 'help.tipsBody'), /#tags.*folders/i);
  assert.ok(t('de', 'search.toggle').length > 0);
  assert.ok(t('en', 'search.toggle').length > 0);
  assert.ok(t('de', 'search.createFromQuery').includes('{query}'));
  assert.ok(t('en', 'search.createFromQuery').includes('{query}'));
  assert.match(t('de', 'settings.telemetryHint'), /App-Starts.*Funktionsaufrufe.*Sync-Keys/i);
  assert.match(t('en', 'settings.telemetryHint'), /app starts.*feature actions.*Sync Keys/i);
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
  assert.equal(CHIME_MASTER_GAIN, 0.5);
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
  assert.equal(store.isSystemTasksList('list-tasks'), true);
  assert.equal(store.isSystemTasksList(defaultTasksId), true);
  assert.throws(() => store.renameList(defaultTasksId, 'Andere Inbox'));
  assert.throws(() => store.deleteList(defaultTasksId));
  assert.throws(() => store.shareList(defaultTasksId));

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
    store.addTask({ title: 'Hotel buchen', listId: list.id });
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), null);

    const { inviteUrl, list: shared } = store.shareList(list.id, 'https://plinglist.app');
    const token = shared.inviteToken!;
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), inviteUrl);
    assert.equal((await store.syncWithServer()).synced, true);
    assert.ok(await repo.resolveInviteToken(token));

    const guestStore = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      serverUrl,
    });
    await guestStore.joinSharedListByToken(token);
    assert.equal(
      guestStore.getActiveLists().some((l) => l.id === list.id),
      true,
    );
    assert.ok(guestStore.tasks.some((t) => t.title === 'Hotel buchen' && t.listId === list.id));

    // Actively shared list cannot be deleted until unshared
    assert.throws(() => store.deleteList(list.id));

    const unshared = store.unshareList(list.id);
    assert.equal(unshared.shared, false);
    assert.equal(unshared.inviteToken, null);
    assert.equal(store.getInviteUrl(list.id, 'https://plinglist.app'), null);

    assert.equal((await store.syncWithServer()).synced, true);
    assert.equal(await repo.resolveInviteToken(token), null);

    // Guest loses the revoked shared list and its tasks upon next sync
    const guestSync = await guestStore.syncWithServer();
    assert.equal(guestSync.revokedLists, 1);
    assert.equal(
      guestStore.lists.some((l) => l.id === list.id),
      false,
    );
    assert.equal(
      guestStore.tasks.some((t) => t.listId === list.id),
      false,
    );

    store.deleteList(list.id);
    assert.equal(
      store.getActiveLists().some((item) => item.id === list.id),
      false,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('pairing consolidates legacy list-tasks/list-groceries without duplicates and syncs older tasks', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    // Simulate Browser A having legacy v0.1.1 localStorage with older timestamps & list-tasks/list-groceries IDs
    const legacyStorage = createMemoryStorage();
    legacyStorage.setItem(
      'plinglist.local.v1',
      JSON.stringify({
        version: 1,
        userId: 'usr-legacy-a',
        syncKey: 'pling-main-1111',
        cursorHlc: null,
        locale: 'de',
        serverUrl,
        soundEnabled: true,
        lists: [
          {
            id: 'list-tasks',
            title: 'Aufgaben',
            shared: true,
            inviteToken: 'inv-old',
            createdAt: '2026-11-23T08:00:00Z',
            updatedAt: '2026-11-23T08:00:00Z',
            deletedAt: null,
            hlc: '001795450000000:00000:web-local',
          },
          {
            id: 'list-groceries',
            title: 'Einkauf',
            shared: false,
            inviteToken: null,
            createdAt: '2026-11-23T08:00:00Z',
            updatedAt: '2026-11-23T08:00:00Z',
            deletedAt: null,
            hlc: '001795450000000:00000:web-local',
          },
        ],
        tasks: [
          {
            id: 'task-old-1',
            listId: 'list-tasks',
            title: 'Alter Task 1',
            completed: false,
            completedAt: null,
            starred: true,
            myDayDate: null,
            dueDate: null,
            reminderAt: null,
            recurrence: null,
            note: '',
            steps: [],
            createdAt: '2026-11-23T08:01:00Z',
            updatedAt: '2026-11-23T08:01:00Z',
            deletedAt: null,
            hlc: '001795450001000:00000:web-local',
          },
          {
            id: 'task-old-2',
            listId: 'list-tasks',
            title: 'Alter Task 2',
            completed: false,
            completedAt: null,
            starred: false,
            myDayDate: null,
            dueDate: '2026-11-25',
            reminderAt: null,
            recurrence: null,
            note: '',
            steps: [],
            createdAt: '2026-11-23T08:02:00Z',
            updatedAt: '2026-11-23T08:02:00Z',
            deletedAt: null,
            hlc: '001795450002000:00000:web-local',
          },
        ],
      }),
    );

    const browserA = new PlinglistStore({
      storage: legacyStorage,
      locale: 'de',
      serverUrl,
    });

    // Browser B (Incognito) opens with ?pair=pling-main-1111 and syncs BEFORE Browser A pushes
    const browserB = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      serverUrl,
      syncKey: 'pling-main-1111',
    });
    assert.equal((await browserB.syncWithServer()).synced, true);

    // Browser A syncs (pushes consolidated tasks/lists and pulls any B state)
    assert.equal((await browserA.syncWithServer()).synced, true);
    // Browser B syncs again and must pull Browser A's older tasks cleanly without duplicating default lists
    assert.equal((await browserB.syncWithServer()).synced, true);

    assert.equal(browserA.getActiveLists().length, 2);
    assert.equal(browserB.getActiveLists().length, 2);
    assert.equal(browserB.tasks.length, 2);
    assert.ok(browserB.tasks.some((t) => t.title === 'Alter Task 1' && t.starred));
    assert.ok(browserB.tasks.some((t) => t.title === 'Alter Task 2' && t.dueDate === '2026-11-25'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('PlinglistStore persists preferences, controls addTask insertion order, and excludes system list in getCustomLists', () => {
  const storage = createMemoryStorage();
  const store = new PlinglistStore({ storage, locale: 'de' });
  const defaultId = store.getDefaultTasksListId();

  assert.equal(
    store.getCustomLists().some((l) => l.id === defaultId),
    false,
  );
  assert.equal(store.getCustomLists().length, 1);

  store.addTask({ title: 'First', listId: defaultId });
  store.addTask({ title: 'SecondTop', listId: defaultId });
  assert.deepEqual(
    store.tasks.map((t) => t.title),
    ['SecondTop', 'First'],
  );

  store.setPreferences({ addNewTasksOnTop: false, showAllSmartList: true });
  store.addTask({ title: 'ThirdBottom', listId: defaultId });
  assert.deepEqual(
    store.tasks.map((t) => t.title),
    ['SecondTop', 'First', 'ThirdBottom'],
  );

  const reloaded = new PlinglistStore({ storage });
  assert.equal(reloaded.preferences.addNewTasksOnTop, false);
  assert.equal(reloaded.preferences.showAllSmartList, true);
  assert.equal(reloaded.preferences.moveStarredToTop, true);
});

test('PlinglistStore supports list folders, list duplication, clearing completed tasks, assignees, and task drag reordering', () => {
  const store = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de' });
  const workList = store.addList('Work / Q3 Workshop');
  assert.equal(workList.folder, 'Work');
  assert.equal(workList.title, 'Q3 Workshop');
  assert.deepEqual(store.getListFolders(), ['Work']);

  const wt1 = store.addTask({ title: 'Book venue #events', listId: workList.id, assignee: '@Daniel' });
  const wt2 = store.addTask({ title: 'Send invites', listId: workList.id });
  store.toggleTaskCompleted(wt1.id, '2026-11-26');
  const dup = store.duplicateList(workList.id, 'Q4 Workshop');
  assert.equal(dup.folder, 'Work');
  const dupTasks = store.tasks.filter((t) => t.listId === dup.id && t.deletedAt === null);
  assert.equal(dupTasks.length, 2);
  assert.equal(dupTasks.every((t) => !t.completed), true);
  assert.ok(dupTasks.some((t) => t.assignee === 'Daniel'));

  const clearedCount = store.clearCompletedTasks(workList.id);
  assert.equal(clearedCount, 1);
  assert.equal(store.getDeletedTasks().some((t) => t.id === wt1.id), true);

  assert.equal(
    store.moveTaskOrder(dupTasks[1].id, dupTasks[0].id, [dupTasks[0].id, dupTasks[1].id]),
    true,
  );
  assert.equal(dupTasks[1].position, 0);
  assert.equal(dupTasks[0].position, 1);
  assert.ok(wt2.id);

  const slashList = store.addList('OPM / Credera', null);
  assert.equal(slashList.title, 'OPM / Credera');
  assert.equal(slashList.folder, null);

  const extraList = store.addList('Private', null);
  const defaultTasksId = store.getDefaultTasksListId();
  assert.equal(store.moveListOrder(slashList.id, defaultTasksId), false);
  assert.equal(store.moveListOrder(defaultTasksId, slashList.id), false);
  assert.equal(store.moveListOrder(extraList.id, slashList.id), true);

  const customOrder = store.getCustomLists().map((l) => l.id);
  assert.ok(customOrder.indexOf(extraList.id) < customOrder.indexOf(slashList.id));

  assert.equal(store.setListFolder(slashList.id, 'Clients')?.folder, 'Clients');
  assert.equal(store.setListFolder(slashList.id, null)?.folder, null);
  assert.equal(store.setListFolder(defaultTasksId, 'Work'), null);

  // Touch/button list reordering within siblings
  assert.equal(store.nudgeListOrder(slashList.id, 'up'), true);
  assert.equal(store.nudgeListOrder(defaultTasksId, 'up'), false);

  // Free tier allows sharing 1 own list with readOnly option
  const roStore = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de' });
  const freeRoList = roStore.addList('Nur Lesen', null);
  const { inviteUrl: freeRoUrl } = roStore.shareList(freeRoList.id, 'https://plinglist.app', {
    readOnly: true,
  });
  assert.match(freeRoUrl, /\?join=inv-ro-/);

  // purgeExpiredTrash persists scrubbed state when items expire
  const trashStorage = createMemoryStorage();
  const trashStore = new PlinglistStore({ storage: trashStorage, locale: 'de' });
  const tempList = trashStore.addList('Alt', null);
  const oldTask = trashStore.addTask({ title: 'Veraltet', listId: tempList.id });
  trashStore.deleteTask(oldTask.id);
  const futureMs = Date.now() + 8 * 86_400_000;
  assert.equal(trashStore.purgeExpiredTrash(futureMs), 1);
  const reloadedTrash = new PlinglistStore({ storage: trashStorage, locale: 'de' });
  assert.equal(reloadedTrash.tasks.find((t) => t.id === oldTask.id)?.title, '');
});

test('PlinglistStore auto-migrates legacy api.plinglist.app serverUrl to same-origin in web context', () => {
  const storage = createMemoryStorage();
  storage.setItem(
    'plinglist.local.v1',
    JSON.stringify({
      version: 1,
      locale: 'de',
      serverUrl: DEFAULT_SERVER_URL,
      soundEnabled: true,
      lists: [
        {
          id: 'list-tasks-abc',
          title: 'Aufgaben',
          shared: false,
          inviteToken: null,
          createdAt: '2026-11-23T08:00:00Z',
          updatedAt: '2026-11-23T08:00:00Z',
          deletedAt: null,
          hlc: '001795450000000:00000:web-local',
        },
      ],
      tasks: [],
    }),
  );

  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: { location?: { origin?: string } } }).window = {
    location: { origin: 'https://plinglist.app' },
  };
  try {
    const store = new PlinglistStore({ storage });
    assert.equal(store.serverUrl, 'https://plinglist.app');
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }

  const rootDir = path.resolve(import.meta.dirname, '..', '..');
  const html = fs.readFileSync(path.join(rootDir, 'app', 'index.html'), 'utf8');
  assert.match(html, /data-settings-tab="general"/);
  assert.match(html, /data-settings-tab="lists"/);
  assert.match(html, /data-settings-tab="sync"/);
  assert.match(html, /id="settingsSyncKeyInput"[^>]*readonly/);
  assert.match(html, /id="editSettingsSyncKeyBtn"/);
  assert.match(html, /id="helpDialog"/);
  assert.match(html, /id="legalDialog"/);
  assert.match(html, /data-legal-tab="imprint"/);
  assert.match(html, /data-legal-tab="privacy"/);
  assert.match(html, /id="openImprintBtn"/);
  assert.match(html, /id="openPrivacyBtn"/);
  assert.match(html, /id="settingsTelemetryCheckbox"/);
  assert.match(html, /id="settingsTelemetryHint"/);
  assert.match(html, /id="settingsSyncEnabledCheckbox"/);
  assert.match(html, /id="deleteWorkspaceBtn"/);
  assert.match(html, /id="toggleSearchBtn"/);
  assert.match(html, /id="searchRow"[^>]*hidden/);
  assert.match(html, /id="taskSearchInput"/);
  assert.match(html, /class="quick-add-plus-icon"/);
  assert.match(html, /id="emptySearchRescueRow"/);
  assert.match(html, /id="createFromSearchBtn"/);
  assert.match(html, /id="detailListSelect"/);
  assert.match(html, /id="joinSharedListForm"/);
  assert.match(html, /id="joinSharedListInput"/);
  assert.match(html, /id="joinSharedListBtn"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /role="tabpanel"/);
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
  ) as { version: string };
  assert.ok(t('de', 'settings.aboutFooter').includes(`v${pkg.version}`));
  assert.equal(UMAMI_APP_WEBSITE_ID, '6d1cc9ed-af01-4760-8f34-6e2c20a80f72');
});

test('telemetry is configurable on official cloud origin (plinglist.app) and permanently disabled on self-hosted origins', () => {
  assert.equal(isOfficialCloudOrigin('https://plinglist.app'), true);
  assert.equal(isOfficialCloudOrigin('https://www.plinglist.app'), true);
  assert.equal(isOfficialCloudOrigin('http://localhost:3001'), false);
  assert.equal(isOfficialCloudOrigin('https://todo.example.com'), false);

  const prevWindow = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: { location?: { origin?: string } } }).window = {
      location: { origin: 'https://todo.example.com' },
    };
    const selfHosted = new PlinglistStore({ storage: createMemoryStorage() });
    assert.equal(selfHosted.isTelemetrySupported(), false);
    assert.equal(selfHosted.isTelemetryActive(), false);
    selfHosted.setPreferences({ telemetryEnabled: true });
    assert.equal(selfHosted.preferences.telemetryEnabled, false);
    assert.equal(selfHosted.isTelemetryActive(), false);

    (globalThis as { window?: { location?: { origin?: string } } }).window = {
      location: { origin: 'https://plinglist.app' },
    };
    const officialCloud = new PlinglistStore({ storage: createMemoryStorage() });
    assert.equal(officialCloud.isTelemetrySupported(), true);
    assert.equal(officialCloud.isTelemetryActive(), true);
    officialCloud.setPreferences({ telemetryEnabled: false });
    assert.equal(officialCloud.preferences.telemetryEnabled, false);
    assert.equal(officialCloud.preferences.telemetryOptedOut, true);
    assert.equal(officialCloud.isTelemetryActive(), false);

    // Native Capacitor shells support telemetry when connected to official cloud, unless explicitly opted out
    for (const nativeOrigin of ['https://localhost', 'capacitor://localhost']) {
      (globalThis as { window?: { location?: { origin?: string } } }).window = {
        location: { origin: nativeOrigin },
      };
      const nativeStorage = createMemoryStorage();
      const nativeOfficial = new PlinglistStore({ storage: nativeStorage });
      assert.equal(nativeOfficial.isTelemetrySupported(), true);
      assert.equal(nativeOfficial.isTelemetryActive(), true);

      nativeOfficial.setPreferences({ telemetryEnabled: false });
      assert.equal(nativeOfficial.isTelemetryActive(), false);
      const nativeOptedOutReloaded = new PlinglistStore({ storage: nativeStorage });
      assert.equal(nativeOptedOutReloaded.isTelemetryActive(), false);

      // Simulate legacy native install that had telemetryEnabled=false without telemetryOptedOut flag
      const legacyStorage = createMemoryStorage();
      legacyStorage.setItem(
        'plinglist.local.v1',
        JSON.stringify({
          version: 1,
          locale: 'de',
          serverUrl: 'https://api.plinglist.app',
          soundEnabled: true,
          preferences: { telemetryEnabled: false },
          lists: [],
          tasks: [],
        }),
      );
      const migratedNative = new PlinglistStore({ storage: legacyStorage });
      assert.equal(migratedNative.isTelemetrySupported(), true);
      assert.equal(migratedNative.isTelemetryActive(), true);

      // Native shell pointing to custom self-hosted server disables telemetry
      const nativeSelfHosted = new PlinglistStore({
        storage: createMemoryStorage(),
        serverUrl: 'https://my-selfhosted.example.com',
      });
      assert.equal(nativeSelfHosted.isTelemetrySupported(), false);
      assert.equal(nativeSelfHosted.isTelemetryActive(), false);
    }
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
});

test('7-day trash retains deleted tasks/lists for recovery, scrubs on permanent delete or 7-day expiry, syncEnabled disables network sync, and deleteCloudAndResetLocal wipes state', async () => {
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

    const list = store.addList('Sensibel');
    const task = store.addTask({
      title: 'Arzttermin vereinbaren',
      listId: list.id,
      dueDate: '2026-12-01',
      note: 'Versichertenkarte mitnehmen',
    });
    store.addTaskStep(task.id, 'Praxis anrufen');

    assert.equal((await store.syncWithServer()).synced, true);

    // Soft delete preserves content in 7-day trash and can be restored cleanly
    store.deleteTask(task.id);
    const softDeletedTask = store.tasks.find((t) => t.id === task.id)!;
    assert.ok(softDeletedTask.deletedAt);
    assert.equal(softDeletedTask.title, 'Arzttermin vereinbaren');
    assert.equal(store.getDeletedTasks().length, 1);

    const restored = store.restoreTask(task.id);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.title, 'Arzttermin vereinbaren');
    assert.equal(store.getDeletedTasks().length, 0);

    // Permanently deleting scrubs personal data from tombstones immediately
    store.deleteTask(task.id);
    store.permanentlyDeleteTask(task.id);
    const scrubbedTask = store.tasks.find((t) => t.id === task.id)!;
    assert.ok(scrubbedTask.deletedAt);
    assert.equal(scrubbedTask.title, '');
    assert.equal(scrubbedTask.note, '');
    assert.deepEqual(scrubbedTask.steps, []);
    assert.equal(scrubbedTask.dueDate, null);

    // Deleting a list keeps it in 7-day trash; emptyTrash scrubs; expired items (>7 days) auto-scrub
    const tempTask = store.addTask({ title: 'Liste retten', listId: list.id });
    store.deleteList(list.id);
    assert.equal(store.getDeletedLists().length, 1);
    store.restoreList(list.id);
    assert.equal(store.getActiveLists().some((l) => l.id === list.id), true);
    assert.equal(store.tasks.find((t) => t.id === tempTask.id)?.deletedAt, null);

    store.deleteList(list.id);
    const oldDeletedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const deletedListRef = store.lists.find((l) => l.id === list.id)!;
    deletedListRef.deletedAt = oldDeletedAt;
    const oldTask = store.tasks.find((t) => t.id === tempTask.id)!;
    oldTask.deletedAt = oldDeletedAt;
    assert.equal(store.getDeletedLists().length, 0);
    const purged = store.purgeExpiredTrash();
    assert.equal(purged, 2);
    assert.equal(deletedListRef.title, '');
    assert.equal(oldTask.title, '');

    // Delta push only sends changed items after first sync
    let capturedBody: { clientLists: unknown[]; clientTasks: unknown[] } | null = null;
    const spyFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/v1/sync') && init?.method === 'POST' && init.body) {
        capturedBody = JSON.parse(String(init.body)) as {
          clientLists: unknown[];
          clientTasks: unknown[];
        };
      }
      return fetch(input, init);
    };

    assert.equal((await store.syncWithServer(spyFetch)).synced, true);
    assert.ok((capturedBody?.clientTasks.length ?? 0) >= 1);

    // Second consecutive poll with no mutations pushes 0 items
    capturedBody = null;
    assert.equal((await store.syncWithServer(spyFetch)).synced, true);
    assert.equal(capturedBody?.clientLists.length, 0);
    assert.equal(capturedBody?.clientTasks.length, 0);

    // syncEnabled = false prevents network sync completely
    store.setPreferences({ syncEnabled: false });
    const skipped = await store.syncWithServer(spyFetch);
    assert.equal(skipped.synced, false);

    // deleteCloudAndResetLocal removes remote workspace and resets local store
    const prevKey = store.syncKey;
    const deleted = await store.deleteCloudAndResetLocal();
    assert.equal(deleted, true);
    assert.notEqual(store.syncKey, prevKey);
    assert.equal(store.tasks.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('high-entropy syncKey/inviteToken, isolated workspace imports, and localStorage quota error resilience', async () => {
  const key = generateSyncKey();
  assert.match(key, /^pling-[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}$/);

  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    const store1 = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      serverUrl,
    });
    const list1 = store1.addList('Shared Project');
    const { list: shared } = store1.shareList(list1.id);
    assert.match(shared.inviteToken ?? '', /^inv-[a-z0-9]{24,}$/);

    const store2 = new PlinglistStore({
      storage: createMemoryStorage(),
      locale: 'de',
      serverUrl,
    });

    const csv = 'Betreff;Liste;Erledigt;Priorität\nSteuererklärung;Finanzen;nein;hoch';
    const res1 = store1.importJson(csv);
    const res2 = store2.importJson(csv);
    assert.equal(res1.importedLists, 1);
    assert.equal(res1.importedTasks, 1);
    assert.equal(res2.importedLists, 1);
    assert.equal(res2.importedTasks, 1);

    const list1Imported = store1.lists.find((l) => l.title === 'Finanzen')!;
    const list2Imported = store2.lists.find((l) => l.title === 'Finanzen')!;
    assert.notEqual(list1Imported.id, list2Imported.id);
    assert.notEqual(store1.tasks[0].id, store2.tasks[0].id);

    // Re-importing same CSV within the same workspace remains idempotent
    const reimport = store1.importJson(csv);
    assert.equal(reimport.importedLists, 0);
    assert.equal(reimport.importedTasks, 0);

    // Both workspaces sync independently to the same server without colliding
    assert.equal((await store1.syncWithServer()).synced, true);
    assert.equal((await store2.syncWithServer()).synced, true);

    // QuotaExceededError resilience
    const failingStorage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        const err = new Error('Storage quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      },
    };
    const resilientStore = new PlinglistStore({ storage: failingStorage, locale: 'de' });
    assert.equal(resilientStore.lastStorageError, 'Storage quota exceeded');

    const t = resilientStore.addTask({
      title: 'Offline trotz vollem Speicher',
      listId: resilientStore.getDefaultTasksListId(),
    });
    assert.equal(resilientStore.tasks.length, 1);
    assert.equal(resilientStore.lastStorageError, 'Storage quota exceeded');

    const { completedTask } = resilientStore.toggleTaskCompleted(t.id, '2026-11-24');
    assert.equal(completedTask.completed, true);
    assert.equal(resilientStore.lastStorageError, 'Storage quota exceeded');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('native shell origin helpers, share base origin, and ?pair= / ?join= input extraction work for iOS, macOS & Android', async () => {
  assert.equal(isNativeShellOrigin('capacitor://localhost'), true);
  assert.equal(isNativeShellOrigin('tauri://localhost'), true);
  assert.equal(isNativeShellOrigin('http://localhost'), true);
  assert.equal(isNativeShellOrigin('https://localhost'), true);
  assert.equal(isNativeShellOrigin('https://tauri.localhost'), true);
  assert.equal(isNativeShellOrigin(undefined), true);
  assert.equal(isNativeShellOrigin('https://plinglist.app'), false);
  assert.equal(isNativeShellOrigin('http://localhost:3001'), false);

  assert.equal(getDefaultServerUrl('https://localhost'), DEFAULT_SERVER_URL);
  assert.equal(
    getShareBaseOrigin('https://localhost', DEFAULT_SERVER_URL),
    OFFICIAL_APP_ORIGIN,
  );
  assert.equal(
    getShareBaseOrigin('capacitor://localhost', DEFAULT_SERVER_URL),
    OFFICIAL_APP_ORIGIN,
  );
  assert.equal(
    getShareBaseOrigin('tauri://localhost', OFFICIAL_APP_ORIGIN),
    OFFICIAL_APP_ORIGIN,
  );
  assert.equal(
    getShareBaseOrigin('capacitor://localhost', 'https://todo.example.com'),
    'https://todo.example.com',
  );
  assert.equal(
    getShareBaseOrigin('https://plinglist.app/', DEFAULT_SERVER_URL),
    'https://plinglist.app',
  );
  assert.equal(
    getShareBaseOrigin('http://localhost:3001/', 'http://localhost:3001'),
    'http://localhost:3001',
  );

  assert.equal(
    extractSyncKeyFromInput('https://plinglist.app/?pair=pling-111111-222222-333333-444444'),
    'pling-111111-222222-333333-444444',
  );
  assert.equal(
    extractSyncKeyFromInput('tps://plinglist.app/?pair=pling-5946-9a16-59e8'),
    'pling-5946-9a16-59e8',
  );
  assert.equal(
    extractSyncKeyFromInput('plinglist.app/?pair=pling-5946-9a16-59e8'),
    'pling-5946-9a16-59e8',
  );
  assert.equal(
    extractSyncKeyFromInput('?pair=pling-5946-9a16-59e8'),
    'pling-5946-9a16-59e8',
  );
  assert.equal(
    extractSyncKeyFromInput('Plinglist Sync: https://plinglist.app/?pair=pling-5946-9a16-59e8'),
    'pling-5946-9a16-59e8',
  );
  assert.equal(
    extractSyncKeyFromInput('plinglist://pair?key=pling-111111-222222-333333-444444'),
    'pling-111111-222222-333333-444444',
  );
  assert.equal(
    extractSyncKeyFromInput('  pling-111111-222222-333333-444444  '),
    'pling-111111-222222-333333-444444',
  );

  assert.equal(
    extractInviteTokenFromInput('https://plinglist.app/?join=inv-abc123'),
    'inv-abc123',
  );
  assert.equal(
    extractInviteTokenFromInput('plinglist.app/?join=inv-44f28593'),
    'inv-44f28593',
  );
  assert.equal(
    extractInviteTokenFromInput('plinglist.app/join/inv-ro-44f28593'),
    'inv-ro-44f28593',
  );
  assert.equal(
    extractInviteTokenFromInput('Join list: https://plinglist.app/?join=inv-44f28593'),
    'inv-44f28593',
  );
  assert.equal(
    extractInviteTokenFromInput('https://api.plinglist.app/join/inv-abc123'),
    'inv-abc123',
  );
  assert.equal(
    extractInviteTokenFromInput('plinglist://join?token=inv-abc123'),
    'inv-abc123',
  );
  assert.equal(extractInviteTokenFromInput('  inv-abc123  '), 'inv-abc123');

  assert.deepEqual(
    detectNativeOsInfo(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      0,
      'ios',
    ),
    { osName: 'macOS', osVersion: '10.15.7' },
  );
  assert.deepEqual(
    detectNativeOsInfo(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      5,
      'ios',
    ),
    { osName: 'iPadOS', osVersion: 'unknown' },
  );
  assert.deepEqual(
    detectNativeOsInfo(
      'Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15',
      5,
      'ios',
    ),
    { osName: 'iPadOS', osVersion: '18.2' },
  );
  assert.deepEqual(
    detectNativeOsInfo(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
      5,
      'ios',
    ),
    { osName: 'iOS', osVersion: '18.7' },
  );
  assert.deepEqual(
    detectNativeOsInfo(
      'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36',
      5,
      'android',
    ),
    { osName: 'Android', osVersion: '16' },
  );

  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    const owner = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const sharedList = owner.addList('Native Mac List');
    const { list } = owner.shareList(sharedList.id, OFFICIAL_APP_ORIGIN);
    await owner.syncWithServer();

    const mobile = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    mobile.setSyncKey(`https://plinglist.app/?pair=${owner.syncKey}`);
    assert.equal(mobile.syncKey, owner.syncKey);

    const guest = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const joined = await guest.joinSharedListByToken(
      `https://plinglist.app/?join=${list.inviteToken}`,
    );
    assert.equal(joined.id, sharedList.id);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('PlinglistStore self-heals legacy persisted full-URL syncKey on load and resets cursorHlc', () => {
  const storage = createMemoryStorage();
  storage.setItem(
    'plinglist.local.v1',
    JSON.stringify({
      version: 1,
      userId: 'usr-legacy-mac',
      syncKey: 'https://plinglist.app/?pair=pling-5946-9a16-59e8',
      cursorHlc: '001795679586611:00001:server',
      locale: 'de',
      serverUrl: DEFAULT_SERVER_URL,
      soundEnabled: true,
      lists: [
        {
          id: 'list-tasks',
          title: 'Aufgaben',
          shared: false,
          inviteToken: null,
          createdAt: '2026-11-24T09:00:00.000Z',
          updatedAt: '2026-11-24T09:00:00.000Z',
          deletedAt: null,
          hlc: '001795679586611:00000:mac',
        },
      ],
      tasks: [],
    }),
  );

  const healed = new PlinglistStore({ storage, locale: 'de' });
  assert.equal(healed.syncKey, 'pling-5946-9a16-59e8');
  assert.equal(healed.cursorHlc, null);
  const persisted = JSON.parse(storage.getItem('plinglist.local.v1') ?? '{}') as {
    syncKey?: string;
    cursorHlc?: string | null;
  };
  assert.equal(persisted.syncKey, 'pling-5946-9a16-59e8');
  assert.equal(persisted.cursorHlc, null);
});

test('setSyncKey via pairing URL cleanly replaces existing throwaway session with web session', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    // Web session creates custom list, tasks, and shares groceries
    const webApp = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    const webCustom = webApp.addList('Büro');
    webApp.addTask({ listId: webApp.getDefaultTasksListId(), title: 'Web Task 1', starred: true });
    webApp.addTask({ listId: webCustom.id, title: 'Steuerbelege sortieren' });
    await webApp.syncWithServer();

    // Android app already opened earlier and created local test tasks on its own initial syncKey
    const androidApp = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    const localThrowawayList = androidApp.addList('Lokaler Test');
    androidApp.addTask({ listId: localThrowawayList.id, title: 'Alter lokaler Task' });
    androidApp.addTask({ listId: androidApp.getDefaultTasksListId(), title: 'Throwaway Default Task' });
    await androidApp.syncWithServer();

    // Tapping webApp's ?pair= link adopts webApp's workspace completely
    androidApp.setSyncKey(webApp.getPairingUrl(OFFICIAL_APP_ORIGIN));
    const syncRes = await androidApp.syncWithServer();
    assert.equal(syncRes.synced, true);
    assert.equal(androidApp.syncKey, webApp.syncKey);

    assert.equal(androidApp.tasks.some((t) => t.title === 'Alter lokaler Task'), false);
    assert.equal(androidApp.tasks.some((t) => t.title === 'Throwaway Default Task'), false);
    assert.equal(androidApp.getActiveLists().some((l) => l.title === 'Lokaler Test'), false);

    assert.ok(androidApp.getActiveLists().some((l) => l.title === 'Büro'));
    assert.ok(androidApp.tasks.some((t) => t.title === 'Web Task 1' && t.starred));
    assert.ok(androidApp.tasks.some((t) => t.title === 'Steuerbelege sortieren'));

    // Also forceReset=true replaces state even when initial key matched target key
    androidApp.addTask({ listId: androidApp.getDefaultTasksListId(), title: 'Temp Crash Task' });
    androidApp.setSyncKey(webApp.syncKey, { forceReset: true });
    assert.equal(androidApp.tasks.some((t) => t.title === 'Temp Crash Task'), false);
    await androidApp.syncWithServer();
    assert.ok(androidApp.tasks.some((t) => t.title === 'Web Task 1'));

    // Pairing a 3rd device (macOS) automatically replaces the oldest slot without failing
    const macApp = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    macApp.setSyncKey(webApp.getPairingUrl(OFFICIAL_APP_ORIGIN));
    const macSync = await macApp.syncWithServer();
    assert.equal(macSync.synced, true);
    assert.equal(macApp.lastSyncErrorCode, null);
    assert.ok(macApp.tasks.some((t) => t.title === 'Web Task 1'));
    assert.ok(macApp.tasks.some((t) => t.title === 'Steuerbelege sortieren'));

    // Evicted webApp automatically rotates back in on restart/next sync without DEVICE_LIMIT_REACHED
    const evictedRestartSync = await webApp.syncWithServer();
    assert.equal(evictedRestartSync.synced, true);
    assert.equal(webApp.lastSyncErrorCode, null);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('syncWithServer does not skip tasks created while an earlier sync request is in flight', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;
    const store = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    store.addTask({ listId: store.getDefaultTasksListId(), title: 'Erster Task' });

    const delayedFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      // Create a second task locally while sync #1 response is still returning
      if (store.tasks.length === 1) {
        store.addTask({ listId: store.getDefaultTasksListId(), title: 'Während Sync erstellt' });
      }
      return res;
    };

    assert.equal((await store.syncWithServer(delayedFetch)).synced, true);
    assert.equal((await store.syncWithServer()).synced, true);

    const peer = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    peer.setSyncKey(store.syncKey);
    await peer.syncWithServer();
    assert.ok(peer.tasks.some((t) => t.title === 'Erster Task'));
    assert.ok(peer.tasks.some((t) => t.title === 'Während Sync erstellt'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('two-window pairing flow syncs second window tasks back to window 1 live and after reload', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    // Window 1 starts, creates "test", and syncs
    const window1Storage = createMemoryStorage();
    const window1 = new PlinglistStore({ storage: window1Storage, locale: 'en', serverUrl });
    window1.addTask({ listId: window1.getDefaultTasksListId(), title: 'test' });
    assert.equal((await window1.syncWithServer()).synced, true);
    const snapshotBeforeSecondTask = window1Storage.getItem('plinglist.local.v1')!;
    const pairUrl = window1.getPairingUrl(OFFICIAL_APP_ORIGIN);

    // Window 2 opens as a fresh session with ?pair=, adopts the workspace, pulls "test", adds "zwei", and syncs
    const window2 = new PlinglistStore({ storage: createMemoryStorage(), locale: 'de', serverUrl });
    window2.setSyncKey(pairUrl, { forceReset: true });
    assert.equal((await window2.syncWithServer()).synced, true);
    assert.ok(window2.tasks.some((t) => t.title === 'test'));
    assert.equal(window2.getDefaultTasksListId(), window1.getDefaultTasksListId());

    window2.addTask({ listId: window2.getDefaultTasksListId(), title: 'zwei' });
    assert.equal((await window2.syncWithServer()).synced, true);

    // Live sync in Window 1 pulls "zwei"
    const liveSync = await window1.syncWithServer();
    assert.equal(liveSync.synced, true);
    assert.ok(window1.tasks.some((t) => t.title === 'zwei'));

    // Checking off "zwei" in Window 2 reports pulledTasks > 0 in Window 1 without requiring reload
    const zweiTask = window2.tasks.find((t) => t.title === 'zwei')!;
    window2.toggleTaskCompleted(zweiTask.id, '2026-11-25');
    assert.equal((await window2.syncWithServer()).synced, true);

    const completionSync = await window1.syncWithServer();
    assert.equal(completionSync.synced, true);
    assert.ok(completionSync.pulledTasks >= 1);
    assert.equal(window1.tasks.find((t) => t.id === zweiTask.id)?.completed, true);

    // Reloaded Window 1 (cursorHlc persisted before "zwei", lastPushedHlc null) also pulls "zwei"
    const window1ReloadedStorage = createMemoryStorage();
    window1ReloadedStorage.setItem('plinglist.local.v1', snapshotBeforeSecondTask);

    const window1Reloaded = new PlinglistStore({
      storage: window1ReloadedStorage,
      locale: 'en',
      serverUrl,
    });
    assert.equal(window1Reloaded.tasks.some((t) => t.title === 'zwei'), false);
    const reloadSync = await window1Reloaded.syncWithServer();
    assert.equal(reloadSync.synced, true);
    assert.ok(window1Reloaded.tasks.some((t) => t.title === 'zwei'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('free tier enforces 1 own shared list while allowing unlimited foreign joined lists and ?pair= membership restore', async () => {
  const repo = new SqliteSyncRepository(':memory:');
  const server = createServerApp(loadServerConfig({ PORT: '0' }), repo);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    // Two external owners each share a list
    const alice = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const aliceList = alice.addList('Alice WG');
    const { list: aliceShared } = alice.shareList(aliceList.id);
    alice.addTask({ title: 'Putzplan', listId: aliceShared.id });
    await alice.syncWithServer();

    const bob = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const bobList = bob.addList('Bob Verein');
    const { list: bobShared } = bob.shareList(bobList.id);
    bob.addTask({ title: 'Getränke', listId: bobShared.id });
    await bob.syncWithServer();

    // Free user can share 1 own list, cannot share a 2nd own list, and can join unlimited foreign lists
    const freeUser = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const own1 = freeUser.addList('Eigene Shared 1');
    const own2 = freeUser.addList('Eigene Shared 2');
    freeUser.shareList(own1.id);
    assert.equal(freeUser.canShareAnotherOwnedList(own2.id), false);
    assert.throws(() => freeUser.shareList(own2.id), SharedListLimitError);

    // Unsharing own1 frees the slot for own2
    freeUser.unshareList(own1.id);
    assert.equal(freeUser.canShareAnotherOwnedList(own2.id), true);
    freeUser.shareList(own2.id);
    assert.equal((await freeUser.syncWithServer()).synced, true);

    // Free user joins BOTH foreign lists without hitting any limit
    await freeUser.joinSharedListByToken(aliceShared.inviteToken!);
    await freeUser.joinSharedListByToken(bobShared.inviteToken!);
    assert.ok(freeUser.getActiveLists().some((l) => l.id === aliceShared.id));
    assert.ok(freeUser.getActiveLists().some((l) => l.id === bobShared.id));

    // Reinstalling app and pairing via ?pair= automatically restores owned lists AND joined foreign lists
    const reinstalled = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    reinstalled.setSyncKey(freeUser.syncKey, { forceReset: true });
    const restoreSync = await reinstalled.syncWithServer(undefined, { replaceOldestDevice: true });
    assert.equal(restoreSync.synced, true);
    assert.ok(reinstalled.getActiveLists().some((l) => l.id === own2.id));
    assert.ok(reinstalled.getActiveLists().some((l) => l.id === aliceShared.id));
    assert.ok(reinstalled.getActiveLists().some((l) => l.id === bobShared.id));
    assert.ok(reinstalled.tasks.some((t) => t.title === 'Putzplan'));
    assert.ok(reinstalled.tasks.some((t) => t.title === 'Getränke'));

    // Upgrading freeUser to Pro allows sharing unlimited own lists (and read-only links)
    repo.upsertEntitlement({
      userId: freeUser.syncKey,
      plan: 'pro_yearly',
      expiresAtMs: Date.now() + 86_400_000,
      source: 'stripe',
    });
    assert.equal((await freeUser.syncWithServer()).synced, true);
    assert.equal(freeUser.isPro(), true);
    const { inviteUrl: roUrl } = freeUser.shareList(own1.id, 'https://plinglist.app', {
      readOnly: true,
    });
    assert.match(roUrl, /\?join=inv-ro-/);
    assert.equal((await freeUser.syncWithServer()).synced, true);

    // Viewer joining via readonly link cannot mutate locally or on server,
    // and moving a foreign list locally keeps its HLC untouched so owner order is preserved
    const viewer = new PlinglistStore({ storage: createMemoryStorage(), serverUrl });
    const joinedRo = await viewer.joinSharedListByToken(roUrl);
    assert.equal(joinedRo.accessRole, 'viewer');
    assert.throws(() => viewer.addTask({ title: 'Hack', listId: joinedRo.id }));
    const foreignOrderList = viewer.addList('Eigene Liste', null);
    const hlcBeforeMove = joinedRo.hlc;
    assert.equal(viewer.moveListOrder(joinedRo.id, foreignOrderList.id), true);
    assert.equal(viewer.lists.find((l) => l.id === joinedRo.id)?.hlc, hlcBeforeMove);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    repo.close();
  }
});

test('Android, iOS, and web theming preserve status bar contrast and safe-area backdrops', () => {
  const indexHtml = fs.readFileSync(path.resolve('app/index.html'), 'utf8');
  assert.match(
    indexHtml,
    /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*light\)"\s+content="#f2f5f4"\s*\/>/i,
  );
  assert.match(
    indexHtml,
    /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*dark\)"\s+content="#131615"\s*\/>/i,
  );

  const manifest = JSON.parse(fs.readFileSync(path.resolve('app/manifest.webmanifest'), 'utf8')) as {
    theme_color?: string;
    background_color?: string;
  };
  assert.equal(manifest.theme_color, '#f2f5f4');
  assert.equal(manifest.background_color, '#f2f5f4');

  const capConfig = JSON.parse(fs.readFileSync(path.resolve('capacitor.config.json'), 'utf8')) as {
    ios?: { backgroundColor?: string };
    android?: { backgroundColor?: string };
  };
  assert.equal(capConfig.ios?.backgroundColor, '#f2f5f4');
  assert.equal(capConfig.android?.backgroundColor, '#f2f5f4');

  const stylesCss = fs.readFileSync(path.resolve('app/styles.css'), 'utf8');
  assert.match(
    stylesCss,
    /body::before\s*\{[^}]*height:\s*env\(safe-area-inset-top,\s*0px\)[^}]*background-color:\s*var\(--bg-canvas\)/s,
  );

  const androidWorkflow = fs.readFileSync(
    path.resolve('.github/workflows/build-android.yml'),
    'utf8',
  );
  assert.match(androidWorkflow, /setAppearanceLightStatusBars\(!isNight\)/);
  assert.match(androidWorkflow, /setAppearanceLightNavigationBars\(!isNight\)/);
  assert.match(androidWorkflow, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(androidWorkflow, /values\/styles\.xml/);
  assert.match(androidWorkflow, /values-night\/styles\.xml/);
  assert.match(androidWorkflow, /android:windowLightStatusBar">true/);
  assert.match(androidWorkflow, /android:windowLightStatusBar">false/);
  assert.doesNotMatch(androidWorkflow, /@drawable\/splash/);
  assert.doesNotMatch(androidWorkflow, /Theme\.SplashScreen/);
  assert.match(androidWorkflow, /<style name="AppTheme\.NoActionBarLaunch" parent="AppTheme\.NoActionBar"\s*\/>/);
  assert.match(androidWorkflow, /android:colorBackground">#FFFFFF/);
  assert.match(androidWorkflow, /android:colorBackground">#1C201F/);
  assert.match(androidWorkflow, /android:textColorPrimary">#171B1A/);
  assert.match(androidWorkflow, /android:textColorPrimary">#F2F4F3/);
  assert.match(androidWorkflow, /setTheme\(R\.style\.AppTheme_NoActionBar\)/);
  assert.match(androidWorkflow, /splash\.png/);
  assert.doesNotMatch(androidWorkflow, /npm install --no-save[^\n]*@capacitor\/local-notifications/);
  assert.match(androidWorkflow, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(androidWorkflow, /android\.permission\.RECEIVE_BOOT_COMPLETED/);
  assert.doesNotMatch(androidWorkflow, /USE_EXACT_ALARM|SCHEDULE_EXACT_ALARM/);
  assert.match(androidWorkflow, /sync_store_listings:/);
  assert.match(androidWorkflow, /SYNC_STORE_LISTINGS:/);

  const iosWorkflow = fs.readFileSync(
    path.resolve('.github/workflows/build-ios-macos.yml'),
    'utf8',
  );
  assert.match(iosWorkflow, /UIViewControllerBasedStatusBarAppearance/);
  assert.match(iosWorkflow, /applyNativeThemeAppearance/);
  assert.match(iosWorkflow, /window\?\.tintColor\s*=\s*brandColor/);
  assert.match(iosWorkflow, /LaunchScreen\.storyboard/);
  assert.match(iosWorkflow, /Splash\.imageset/);
  assert.match(iosWorkflow, /242\.0\s*\/\s*255\.0/);
  assert.match(iosWorkflow, /19\.0\s*\/\s*255\.0/);
  assert.match(iosWorkflow, /PRODUCT_NAME = Plinglist;/);
  assert.match(iosWorkflow, /INFOPLIST_KEY_CFBundleDisplayName = Plinglist;/);
  assert.match(iosWorkflow, /INFOPLIST_KEY_CFBundleName = Plinglist;/);
  assert.match(iosWorkflow, /targetEnvironment\(macCatalyst\)/);
  assert.match(iosWorkflow, /isiOSAppOnMac/);
  assert.match(iosWorkflow, /pageZoom = 1\.15/);
  assert.doesNotMatch(iosWorkflow, /npm install --no-save[^\n]*@capacitor\/local-notifications/);

  assert.match(stylesCss, /\.nav-item\s*\{[^}]*font-size:\s*0\.98rem;/s);
  assert.match(stylesCss, /\.nav-label\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(stylesCss, /\.main-view\s*\{[^}]*min-width:\s*0;/s);
  assert.match(stylesCss, /\.view-header\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(stylesCss, /\.header-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(stylesCss, /\.drag-handle\s*\{[^}]*touch-action:\s*none;/s);
  assert.match(stylesCss, /\.task-row\.is-draggable\s*\{[^}]*grid-template-columns:\s*auto auto 1fr auto;/s);
  assert.match(stylesCss, /\.task-title\s*\{[^}]*font-size:\s*1\.05rem;/s);
  assert.match(stylesCss, /\.task-meta\s*\{[^}]*font-size:\s*0\.85rem;/s);
  assert.doesNotMatch(
    stylesCss,
    /@media\s*\(min-width:\s*768px\)\s*\{\s*input\[type="text"\][^}]*font-size:\s*0\.94rem;/s,
  );
  assert.match(stylesCss, /select\s*\{[^}]*appearance:\s*none;/s);
  assert.match(stylesCss, /select\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml/s);
  assert.match(stylesCss, /select option\s*\{[^}]*background-color:\s*var\(--bg-surface\)[^}]*color:\s*var\(--text-primary\)/s);
  assert.match(stylesCss, /select:focus-visible[^{]*\{[^}]*outline-offset:\s*-1px;/s);

  const webAppTs = fs.readFileSync(path.resolve('app/src/web-app.ts'), 'utf8');
  assert.match(webAppTs, /plinglist\.firedReminders\.v1/);
  assert.match(webAppTs, /allowWhileIdle:\s*true/);
  assert.match(webAppTs, /showNotification\(/);
  assert.match(webAppTs, /createDragHandleElement/);
  assert.match(
    webAppTs,
    /function createTaskElement\([\s\S]*?const readOnly = store\.isReadOnlyList\(task\.listId\);\s*const today = getLocalIsoDate\(\);\s*const canDragTask = !isSuggestion && !readOnly && !task\.completed;/,
  );
});
