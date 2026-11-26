import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HlcClock,
  compareHlc,
  computeNextDueDate,
  extractHashtags,
  filterPlannedTasks,
  filterTasksByQuery,
  formatHlc,
  getAllOpenTasks,
  getAssignedTasks,
  getDueReminderTasks,
  getListTasks,
  getMyDaySuggestions,
  getMyDayTasks,
  getPlannedTasks,
  getStarredTasks,
  importMicrosoftToDoCsv,
  importMicrosoftToDoJson,
  importWunderlistJson,
  isTaskOverdue,
  mergeListLww,
  mergeTaskLww,
  sortTasksForView,
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

test('importMicrosoftToDoCsv parses EN comma and DE semicolon CSV exports cleanly', () => {
  const hlc = formatHlc(4000, 0, 'csv');

  const enCsv = [
    'Subject,List Name,Status,Importance,Due Date,Notes',
    '"Buy ""fair"" coffee",Groceries,Not Started,High,2026-12-01,"Whole bean\nMedium roast"',
    'Archive taxes,Admin,Completed,Normal,2026-11-30,Done',
  ].join('\n');

  const enRes = importMicrosoftToDoCsv(enCsv, hlc);
  assert.equal(enRes.lists.length, 2);
  assert.equal(enRes.tasks.length, 2);
  assert.equal(enRes.tasks[0].title, 'Buy "fair" coffee');
  assert.equal(enRes.tasks[0].starred, true);
  assert.equal(enRes.tasks[0].dueDate, '2026-12-01');
  assert.equal(enRes.tasks[0].note, 'Whole bean\nMedium roast');
  assert.equal(enRes.tasks[1].completed, true);

  const deCsv = `\uFEFFBetreff;Liste;Erledigt;Priorität;Fälligkeitsdatum;Notizen\nSteuererklärung;Finanzen;ja;hoch;15.05.2027;Elster prüfen`;
  const deRes = importMicrosoftToDoCsv(deCsv, hlc);
  assert.equal(deRes.lists[0].title, 'Finanzen');
  assert.equal(deRes.tasks[0].completed, true);
  assert.equal(deRes.tasks[0].starred, true);
  assert.equal(deRes.tasks[0].dueDate, '2027-05-15');
  assert.equal(deRes.tasks[0].note, 'Elster prüfen');
});

test('getDueReminderTasks filters active uncompleted due reminders and respects firedKeys', () => {
  const nowMs = Date.parse('2026-11-24T10:30:00.000Z');
  const dueTask = makeTask({
    id: 't-due',
    reminderAt: '2026-11-24T10:25:00.000Z',
  });
  const futureTask = makeTask({
    id: 't-future',
    reminderAt: '2026-11-24T11:00:00.000Z',
  });
  const completedTask = makeTask({
    id: 't-done',
    completed: true,
    reminderAt: '2026-11-24T09:00:00.000Z',
  });
  const deletedTask = makeTask({
    id: 't-deleted',
    deletedAt: '2026-11-24T09:05:00.000Z',
    reminderAt: '2026-11-24T09:00:00.000Z',
  });

  const tasks = [dueTask, futureTask, completedTask, deletedTask];
  const due = getDueReminderTasks(tasks, nowMs);
  assert.deepEqual(
    due.map((t) => t.id),
    ['t-due'],
  );

  const firedKeys = new Set([`${dueTask.id}:${dueTask.reminderAt}`]);
  assert.deepEqual(getDueReminderTasks(tasks, nowMs, firedKeys), []);
});

test('getMyDayTasks includeDueToday, getAllOpenTasks, and sortTasksForView work cleanly', () => {
  const dueTodayTask = makeTask({ id: 't-due-today', dueDate: '2026-11-24', starred: false });
  const starredLater = makeTask({ id: 't-starred', dueDate: '2026-11-28', starred: true });
  const doneStarred = makeTask({ id: 't-done-star', completed: true, starred: true });
  const deletedTask = makeTask({ id: 't-del', deletedAt: '2026-11-24T08:00:00Z' });
  const tasks = [dueTodayTask, starredLater, doneStarred, deletedTask];

  assert.deepEqual(
    getMyDayTasks(tasks, '2026-11-24', true).map((t) => t.id),
    ['t-due-today'],
  );
  assert.deepEqual(
    getMyDaySuggestions(tasks, '2026-11-24', true).map((t) => t.id),
    [],
  );
  assert.deepEqual(
    getAllOpenTasks(tasks).map((t) => t.id),
    ['t-due-today', 't-starred'],
  );
  assert.deepEqual(
    sortTasksForView([dueTodayTask, starredLater], true).map((t) => t.id),
    ['t-starred', 't-due-today'],
  );
  assert.deepEqual(
    sortTasksForView([dueTodayTask, starredLater], false).map((t) => t.id),
    ['t-due-today', 't-starred'],
  );
});

test('filterTasksByQuery matches title, note, and step titles case-insensitively', () => {
  const t1 = makeTask({
    id: 't1',
    title: 'Kaffeebohnen kaufen',
    note: 'Rösterei um die Ecke',
    steps: [{ id: 's1', title: 'Espresso-Mahlgrad prüfen', completed: false, position: 0 }],
  });
  const t2 = makeTask({
    id: 't2',
    title: 'Steuererklärung',
    note: 'Belege sortieren',
    steps: [],
  });
  const tasks = [t1, t2];

  assert.deepEqual(filterTasksByQuery(tasks, '').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(filterTasksByQuery(tasks, '  ').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(filterTasksByQuery(tasks, 'KAFFEE').map((t) => t.id), ['t1']);
  assert.deepEqual(filterTasksByQuery(tasks, 'rösterei').map((t) => t.id), ['t1']);
  assert.deepEqual(filterTasksByQuery(tasks, 'MAHLGRAD').map((t) => t.id), ['t1']);
  assert.deepEqual(filterTasksByQuery(tasks, 'belege').map((t) => t.id), ['t2']);
  assert.deepEqual(filterTasksByQuery(tasks, 'unbekannt'), []);
});

test('planned filters, overdue detection, hashtags, assignees, sort modes, and Wunderlist folders work cleanly', () => {
  const today = '2026-11-26';
  const overdue = makeTask({ id: 't-over', dueDate: '2026-11-24', title: 'Steuern #finanzen', assignee: 'Daniel' });
  const dueToday = makeTask({ id: 't-today', dueDate: '2026-11-26', title: 'Brot @Daniel #einkauf', starred: true });
  const dueTomorrow = makeTask({ id: 't-tmr', dueDate: '2026-11-27', title: 'Alpha Task' });
  const dueWeek = makeTask({ id: 't-week', dueDate: '2026-12-01', title: 'Beta Task' });
  const dueLater = makeTask({ id: 't-later', dueDate: '2026-12-20', title: 'Urlaub planen' });
  const tasks = [overdue, dueToday, dueTomorrow, dueWeek, dueLater];

  assert.equal(isTaskOverdue(overdue, today), true);
  assert.equal(isTaskOverdue(dueToday, today), false);

  assert.deepEqual(filterPlannedTasks(tasks, 'all', today).map((t) => t.id), [
    't-over',
    't-today',
    't-tmr',
    't-week',
    't-later',
  ]);
  assert.deepEqual(filterPlannedTasks(tasks, 'overdue', today).map((t) => t.id), ['t-over']);
  assert.deepEqual(filterPlannedTasks(tasks, 'today', today).map((t) => t.id), ['t-today']);
  assert.deepEqual(filterPlannedTasks(tasks, 'tomorrow', today).map((t) => t.id), ['t-tmr']);
  assert.deepEqual(filterPlannedTasks(tasks, 'this-week', today).map((t) => t.id), [
    't-today',
    't-tmr',
    't-week',
  ]);
  assert.deepEqual(filterPlannedTasks(tasks, 'later', today).map((t) => t.id), ['t-later']);

  assert.deepEqual(extractHashtags('Steuern #finanzen #Einkauf #finanzen'), ['#finanzen', '#Einkauf']);
  assert.deepEqual(getAssignedTasks(tasks, 'daniel').map((t) => t.id), ['t-over', 't-today']);

  assert.deepEqual(sortTasksForView(tasks, false, 'title').map((t) => t.id), [
    't-tmr',
    't-week',
    't-today',
    't-over',
    't-later',
  ]);
  assert.deepEqual(sortTasksForView([overdue, dueToday], false, 'starred').map((t) => t.id), [
    't-today',
    't-over',
  ]);

  const wlWithFolders = importWunderlistJson(
    JSON.stringify({
      data: {
        folders: [{ id: 1, title: 'Workshops', list_ids: [10] }],
        lists: [{ id: 10, title: 'Workshop Q3' }],
        tasks: [],
      },
    }),
    formatHlc(5000, 0, 'wl'),
  );
  assert.equal(wlWithFolders.lists[0].folder, 'Workshops');
});
