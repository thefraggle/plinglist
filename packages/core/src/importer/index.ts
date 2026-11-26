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
    folders?: Array<{
      id: string | number;
      title: string;
      list_ids?: Array<string | number>;
    }>;
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

  const folderByListId = new Map<string, string>();
  for (const folder of data.folders ?? []) {
    const folderTitle = folder.title?.trim();
    if (!folderTitle) continue;
    for (const lid of folder.list_ids ?? []) {
      folderByListId.set(String(lid), folderTitle);
    }
  }

  const lists: TaskList[] = (data.lists ?? []).map((list) => ({
    id: `wl-list-${String(list.id)}`,
    title: list.title,
    folder: folderByListId.get(String(list.id)) ?? null,
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

function normalizeCsvDate(raw: string | undefined): string | null {
  const clean = raw?.trim();
  if (!clean) return null;
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  const deMatch = clean.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (deMatch) {
    const day = deMatch[1].padStart(2, '0');
    const month = deMatch[2].padStart(2, '0');
    return `${deMatch[3]}-${month}-${day}`;
  }
  return null;
}

function detectCsvDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ',') commas += 1;
    else if (!inQuotes && ch === ';') semis += 1;
  }
  return semis > commas ? ';' : ',';
}

function parseCsvRows(raw: string, delimiter: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (raw[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function slugifyId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}

/**
 * Parses English or German Microsoft To Do / Outlook CSV exports (comma or semicolon delimited).
 */
export function importMicrosoftToDoCsv(rawCsv: string, nowHlc: HlcTimestamp): ImportResult {
  const cleaned = rawCsv.replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    throw new Error('Empty CSV export');
  }

  const delimiter = detectCsvDelimiter(cleaned);
  const rows = parseCsvRows(cleaned, delimiter);
  if (rows.length < 2) {
    throw new Error('CSV export must include a header row and at least one task row');
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const findCol = (candidates: readonly string[]): number =>
    headers.findIndex((h) => candidates.includes(h));

  const titleIdx = findCol(['title', 'subject', 'betreff', 'aufgabe', 'task']);
  if (titleIdx < 0) {
    throw new Error('CSV export is missing a title/subject column');
  }

  const listIdx = findCol(['list', 'list name', 'folder', 'categories', 'liste', 'kategorie']);
  const completedIdx = findCol(['status', 'completed', 'iscompleted', 'erledigt']);
  const starredIdx = findCol(['importance', 'priority', 'starred', 'priorität', 'wichtigkeit']);
  const dueDateIdx = findCol(['due date', 'duedate', 'duedatetime', 'fälligkeitsdatum', 'fällig am']);
  const noteIdx = findCol(['notes', 'body', 'description', 'notizen', 'beschreibung']);

  const nowIso = new Date().toISOString();
  const listsByTitle = new Map<string, TaskList>();
  const tasks: TaskItem[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const title = row[titleIdx]?.trim();
    if (!title) continue;

    const listTitle = (listIdx >= 0 ? row[listIdx]?.trim() : '') || 'Microsoft To Do Import';
    let list = listsByTitle.get(listTitle);
    if (!list) {
      list = {
        id: `csv-list-${slugifyId(listTitle)}`,
        title: listTitle,
        shared: false,
        inviteToken: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
        hlc: nowHlc,
      };
      listsByTitle.set(listTitle, list);
    }

    const completedVal = (completedIdx >= 0 ? row[completedIdx] : '')?.trim().toLowerCase() ?? '';
    const completed = ['completed', 'erledigt', 'abgeschlossen', 'true', '1', 'yes', 'ja'].includes(
      completedVal,
    );

    const starredVal = (starredIdx >= 0 ? row[starredIdx] : '')?.trim().toLowerCase() ?? '';
    const starred = ['high', 'hoch', 'important', 'wichtig', 'true', '1'].includes(starredVal);

    const dueDate = dueDateIdx >= 0 ? normalizeCsvDate(row[dueDateIdx]) : null;
    const note = noteIdx >= 0 ? (row[noteIdx] ?? '').trim() : '';

    tasks.push({
      id: `csv-task-${slugifyId(listTitle)}-${r}`,
      listId: list.id,
      title,
      completed,
      completedAt: completed ? nowIso : null,
      starred,
      myDayDate: null,
      dueDate,
      reminderAt: null,
      recurrence: null,
      note,
      steps: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: nowHlc,
    });
  }

  return {
    lists: Array.from(listsByTitle.values()),
    tasks,
  };
}
