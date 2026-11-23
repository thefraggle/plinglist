import type {
  HlcTimestamp,
  RecurrencePattern,
  TaskItem,
  TaskList,
  TaskStep,
} from '../types.ts';

export interface ImportResult {
  lists: TaskList[];
  tasks: TaskItem[];
}

interface WunderlistRaw {
  data?: {
    lists?: Array<{ id: string | number; title: string; created_at?: string }>;
    tasks?: Array<{
      id: string | number;
      list_id: string | number;
      title: string;
      completed?: boolean;
      completed_at?: string | null;
      starred?: boolean;
      due_date?: string | null;
      recurrence_type?: string | null;
      created_at?: string;
    }>;
    subtasks?: Array<{
      id: string | number;
      task_id: string | number;
      title: string;
      completed?: boolean;
    }>;
    notes?: Array<{
      task_id: string | number;
      content?: string;
    }>;
  };
}

interface MicrosoftToDoRaw {
  lists?: Array<{
    id: string;
    displayName: string;
    tasks?: Array<{
      id: string;
      title: string;
      status?: string;
      importance?: string;
      completedDateTime?: { dateTime?: string } | null;
      dueDateTime?: { dateTime?: string } | null;
      body?: { content?: string } | null;
      recurrence?: { pattern?: { type?: string } } | null;
      checklistItems?: Array<{
        id: string;
        displayName: string;
        isChecked?: boolean;
      }>;
      createdDateTime?: string;
    }>;
  }>;
}

function mapRecurrence(raw: string | null | undefined): RecurrencePattern | null {
  switch (raw?.toLowerCase()) {
    case 'day':
    case 'daily':
      return 'daily';
    case 'week':
    case 'weekly':
      return 'weekly';
    case 'weekdays':
      return 'weekdays';
    case 'month':
    case 'monthly':
      return 'monthly';
    case 'year':
    case 'yearly':
      return 'yearly';
    default:
      return null;
  }
}

function normalizeIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

export function importWunderlistJson(rawJson: string, nowHlc: HlcTimestamp): ImportResult {
  const parsed = JSON.parse(rawJson) as WunderlistRaw;
  const data = parsed.data ?? {};
  const nowIso = new Date().toISOString();

  const lists: TaskList[] = (data.lists ?? []).map((list) => ({
    id: `wl-list-${String(list.id)}`,
    title: list.title,
    shared: false,
    inviteToken: null,
    createdAt: list.created_at ?? nowIso,
    updatedAt: nowIso,
    deletedAt: null,
    hlc: nowHlc,
  }));

  const notesByTask = new Map<string, string>();
  for (const note of data.notes ?? []) {
    if (note.content) {
      notesByTask.set(String(note.task_id), note.content);
    }
  }

  const stepsByTask = new Map<string, TaskStep[]>();
  for (const sub of data.subtasks ?? []) {
    const key = String(sub.task_id);
    const existing = stepsByTask.get(key) ?? [];
    existing.push({
      id: `wl-step-${String(sub.id)}`,
      title: sub.title,
      completed: Boolean(sub.completed),
      position: existing.length,
    });
    stepsByTask.set(key, existing);
  }

  const tasks: TaskItem[] = (data.tasks ?? []).map((task) => {
    const key = String(task.id);
    return {
      id: `wl-task-${key}`,
      listId: `wl-list-${String(task.list_id)}`,
      title: task.title,
      completed: Boolean(task.completed),
      completedAt: task.completed_at ?? null,
      starred: Boolean(task.starred),
      myDayDate: null,
      dueDate: normalizeIsoDate(task.due_date),
      reminderAt: null,
      recurrence: mapRecurrence(task.recurrence_type),
      note: notesByTask.get(key) ?? '',
      steps: stepsByTask.get(key) ?? [],
      createdAt: task.created_at ?? nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: nowHlc,
    };
  });

  return { lists, tasks };
}

export function importMicrosoftToDoJson(rawJson: string, nowHlc: HlcTimestamp): ImportResult {
  const parsed = JSON.parse(rawJson) as MicrosoftToDoRaw;
  const nowIso = new Date().toISOString();

  const lists: TaskList[] = [];
  const tasks: TaskItem[] = [];

  for (const rawList of parsed.lists ?? []) {
    const listId = `ms-list-${rawList.id}`;
    lists.push({
      id: listId,
      title: rawList.displayName,
      shared: false,
      inviteToken: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: nowHlc,
    });

    for (const rawTask of rawList.tasks ?? []) {
      const completed = rawTask.status === 'completed';
      const steps: TaskStep[] = (rawTask.checklistItems ?? []).map((item, index) => ({
        id: `ms-step-${item.id}`,
        title: item.displayName,
        completed: Boolean(item.isChecked),
        position: index,
      }));

      tasks.push({
        id: `ms-task-${rawTask.id}`,
        listId,
        title: rawTask.title,
        completed,
        completedAt: rawTask.completedDateTime?.dateTime ?? null,
        starred: rawTask.importance === 'high',
        myDayDate: null,
        dueDate: normalizeIsoDate(rawTask.dueDateTime?.dateTime),
        reminderAt: null,
        recurrence: mapRecurrence(rawTask.recurrence?.pattern?.type),
        note: rawTask.body?.content ?? '',
        steps,
        createdAt: rawTask.createdDateTime ?? nowIso,
        updatedAt: nowIso,
        deletedAt: null,
        hlc: nowHlc,
      });
    }
  }

  return { lists, tasks };
}
