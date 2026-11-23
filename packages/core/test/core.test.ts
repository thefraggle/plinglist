import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HlcClock,
  compareHlc,
  computeNextDueDate,
  formatHlc,
  getListTasks,
  getMyDaySuggestions,
  getMyDayTasks,
  getPlannedTasks,
  getStarredTasks,
  importMicrosoftToDoJson,
  importWunderlistJson,
  mergeListLww,
  mergeTaskLww,
  type TaskItem,
  type TaskList,
} from '../src/index.ts';

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    listId: 'list-1',
    title: 'Hafermilch kaufen',
    completed: false,
    completedAt: null,
    starred: false,
    myDayDate: null,
    dueDate: null,
    reminderAt: null,
    recurrence: null,
    note: '',
    steps: [],
    createdAt: '2026-11-22T10:00:00Z',
    updatedAt: '2026-11-22T10:00:00Z',
    deletedAt: null,
    hlc: formatHlc(1000, 0, 'dev-a'),
    ...overrides,
  };
}

test('HlcClock stays strictly monotonic even with backwards wall clock', () => {
  const clock = new HlcClock('dev-a', 5000);
  const t1 = clock.now(5000);
  const t2 = clock.now(4000);
  const t3 = clock.receive(formatHlc(6000, 3, 'dev-b'), 4500);

  assert.equal(compareHlc(t1, t2), -1);
  assert.equal(compareHlc(t2, t3), -1);
});

test('mergeTaskLww combines offline completion and concurrent note edit without data loss', () => {
  const hlcBase = formatHlc(1000, 0, 'dev-a');
  const hlcComplete = formatHlc(2000, 0, 'dev-a');
  const hlcNote = formatHlc(2500, 0, 'dev-b');

  const local = makeTask({
    completed: true,
    completedAt: '2026-11-23T12:00:00Z',
    hlc: hlcComplete,
    fieldHlcs: {
      title: hlcBase,
      completed: hlcComplete,
      completedAt: hlcComplete,
      note: hlcBase,
    },
  });

  const incoming = makeTask({
    completed: false,
    completedAt: null,
    note: 'Bio Barista Edition',
    hlc: hlcNote,
    fieldHlcs: {
      title: hlcBase,
      completed: hlcBase,
      completedAt: hlcBase,
      note: hlcNote,
    },
  });

  const merged = mergeTaskLww(local, incoming);
  assert.equal(merged.completed, true);
  assert.equal(merged.completedAt, '2026-11-23T12:00:00Z');
  assert.equal(merged.note, 'Bio Barista Edition');
});

test('My Day resets at midnight and surfaces previous/overdue items in smart suggestions', () => {
  const yesterdayTask = makeTask({ id: 't-yesterday', myDayDate: '2026-11-22' });
  const todayTask = makeTask({ id: 't-today', myDayDate: '2026-11-23' });
  const overdueTask = makeTask({ id: 't-overdue', dueDate: '2026-11-21', starred: true });
  const completedTask = makeTask({ id: 't-done', dueDate: '2026-11-23', completed: true });

  const tasks = [yesterdayTask, todayTask, overdueTask, completedTask];

  assert.deepEqual(
    getMyDayTasks(tasks, '2026-11-23').map((t) => t.id),
    ['t-today'],
  );
  assert.deepEqual(
    getMyDaySuggestions(tasks, '2026-11-23').map((t) => t.id),
    ['t-yesterday', 't-overdue'],
  );
  assert.deepEqual(
    getStarredTasks(tasks).map((t) => t.id),
    ['t-overdue'],
  );
  assert.deepEqual(
    getPlannedTasks(tasks).map((t) => t.id),
    ['t-overdue'],
  );
  assert.equal(getListTasks(tasks, 'list-1').length, 4);
});

test('1-click importers preserve lists, steps, starred status, due dates, and notes', () => {
  const hlc = formatHlc(3000, 0, 'import');

  const wlJson = JSON.stringify({
    data: {
      lists: [{ id: 10, title: 'Einkauf' }],
      tasks: [
        {
          id: 99,
          list_id: 10,
          title: 'Kaffeebohnen',
          starred: true,
          due_date: '2026-11-25',
          recurrence_type: 'week',
        },
      ],
      subtasks: [{ id: 1, task_id: 99, title: 'Ganze Bohne', completed: false }],
      notes: [{ task_id: 99, content: 'Rösterei um die Ecke' }],
    },
  });

  const wlImported = importWunderlistJson(wlJson, hlc);
  assert.equal(wlImported.lists[0].title, 'Einkauf');
  assert.equal(wlImported.tasks[0].starred, true);
  assert.equal(wlImported.tasks[0].dueDate, '2026-11-25');
  assert.equal(wlImported.tasks[0].recurrence, 'weekly');
  assert.equal(wlImported.tasks[0].note, 'Rösterei um die Ecke');
  assert.equal(wlImported.tasks[0].steps[0].title, 'Ganze Bohne');

  const msJson = JSON.stringify({
    lists: [
      {
        id: 'abc',
        displayName: 'Haushalt',
        tasks: [
          {
            id: 't1',
            title: 'Zählerstand ablesen',
            status: 'notStarted',
            importance: 'high',
            dueDateTime: { dateTime: '2026-11-30T00:00:00' },
            body: { content: 'Strom & Gas' },
            checklistItems: [{ id: 'c1', displayName: 'Foto machen', isChecked: true }],
          },
        ],
      },
    ],
  });

  const msImported = importMicrosoftToDoJson(msJson, hlc);
  assert.equal(msImported.lists[0].title, 'Haushalt');
  assert.equal(msImported.tasks[0].starred, true);
  assert.equal(msImported.tasks[0].dueDate, '2026-11-30');
  assert.equal(msImported.tasks[0].note, 'Strom & Gas');
  assert.equal(msImported.tasks[0].steps[0].completed, true);
});

test('computeNextDueDate advances daily, weekly, weekdays, monthly and yearly cleanly', () => {
  assert.equal(computeNextDueDate('2026-11-23', 'daily'), '2026-11-24');
  assert.equal(computeNextDueDate('2026-11-23', 'weekly'), '2026-11-30');
  // 2026-11-27 is Friday -> next weekday is Monday 2026-11-30
  assert.equal(computeNextDueDate('2026-11-27', 'weekdays'), '2026-11-30');
  assert.equal(computeNextDueDate('2026-11-23', 'monthly'), '2026-12-23');
  assert.equal(computeNextDueDate('2026-11-23', 'yearly'), '2027-11-23');
});

test('mergeListLww selects newer HLC state while preserving earliest createdAt', () => {
  const local: TaskList = {
    id: 'list-1',
    title: 'Einkauf',
    shared: false,
    inviteToken: null,
    createdAt: '2026-11-22T09:00:00Z',
    updatedAt: '2026-11-22T09:00:00Z',
    deletedAt: null,
    hlc: formatHlc(1000, 0, 'dev-a'),
  };
  const incoming: TaskList = {
    id: 'list-1',
    title: 'Wocheneinkauf',
    shared: true,
    inviteToken: 'inv-123',
    createdAt: '2026-11-23T10:00:00Z',
    updatedAt: '2026-11-23T10:00:00Z',
    deletedAt: null,
    hlc: formatHlc(2000, 0, 'dev-b'),
  };

  const merged = mergeListLww(local, incoming);
  assert.equal(merged.title, 'Wocheneinkauf');
  assert.equal(merged.shared, true);
  assert.equal(merged.inviteToken, 'inv-123');
  assert.equal(merged.createdAt, '2026-11-22T09:00:00Z');
  assert.equal(merged.updatedAt, '2026-11-23T10:00:00Z');
});
