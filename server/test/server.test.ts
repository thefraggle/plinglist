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
