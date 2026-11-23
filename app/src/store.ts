import {
  HlcClock,
  computeNextDueDate,
  importMicrosoftToDoJson,
  importWunderlistJson,
  mergeTaskLww,
  type RecurrencePattern,
  type TaskItem,
  type TaskList,
} from '../../packages/core/src/index.ts';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from './config.ts';
import type { SupportedLocale } from './i18n.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PersistedState {
  version: 1;
  locale: SupportedLocale;
  serverUrl: string;
  soundEnabled: boolean;
  lists: TaskList[];
  tasks: TaskItem[];
}

export interface AddTaskInput {
  title: string;
  listId: string;
  starred?: boolean;
  myDayDate?: string | null;
  dueDate?: string | null;
  recurrence?: RecurrencePattern | null;
  note?: string;
}

const STORAGE_KEY = 'plinglist.local.v1';

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getLocalIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Local-First synchronous store: all reads & mutations hit memory + local storage
 * immediately (< 16 ms) while tagging every change with monotonic HLC timestamps.
 */
export class PlinglistStore {
  private readonly storage: StorageLike | null;
  private readonly clock: HlcClock;
  lists: TaskList[] = [];
  tasks: TaskItem[] = [];
  locale: SupportedLocale = 'de';
  serverUrl: string = DEFAULT_SERVER_URL;
  soundEnabled = true;

  constructor(options?: {
    storage?: StorageLike | null;
    locale?: SupportedLocale;
    nodeId?: string;
  }) {
    this.storage = options?.storage ?? null;
    this.clock = new HlcClock(options?.nodeId ?? 'web-local');
    if (options?.locale) {
      this.locale = options.locale;
    }

    const loaded = this.load();
    if (!loaded) {
      this.seedDefaults();
      this.persist();
    }
  }

  private seedDefaults(): void {
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    this.lists = [
      {
        id: 'list-tasks',
        title: this.locale === 'de' ? 'Aufgaben' : 'Tasks',
        shared: false,
        inviteToken: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
        hlc,
      },
      {
        id: 'list-groceries',
        title: this.locale === 'de' ? 'Einkauf' : 'Groceries',
        shared: false,
        inviteToken: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
        hlc,
      },
    ];
  }

  private load(): boolean {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.lists) || !Array.isArray(parsed.tasks)) {
        return false;
      }
      this.locale = parsed.locale === 'en' ? 'en' : 'de';
      this.serverUrl = normalizeServerUrl(parsed.serverUrl);
      this.soundEnabled = parsed.soundEnabled !== false;
      this.lists = parsed.lists;
      this.tasks = parsed.tasks;
      for (const task of this.tasks) {
        this.clock.receive(task.hlc);
      }
      return this.lists.length > 0;
    } catch {
      return false;
    }
  }

  private persist(): void {
    if (!this.storage) return;
    const payload: PersistedState = {
      version: 1,
      locale: this.locale,
      serverUrl: this.serverUrl,
      soundEnabled: this.soundEnabled,
      lists: this.lists,
      tasks: this.tasks,
    };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  private requireTask(taskId: string): TaskItem {
    const task = this.tasks.find((item) => item.id === taskId && item.deletedAt === null);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  getActiveLists(): TaskList[] {
    return this.lists.filter((list) => list.deletedAt === null);
  }

  addList(title: string): TaskList {
    const clean = title.trim();
    if (!clean) {
      throw new Error('List title must not be empty');
    }
    const nowIso = new Date().toISOString();
    const list: TaskList = {
      id: createId('list'),
      title: clean,
      shared: false,
      inviteToken: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: this.clock.now(),
    };
    this.lists.push(list);
    this.persist();
    return list;
  }

  shareList(listId: string): { list: TaskList; inviteUrl: string } {
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    list.shared = true;
    list.inviteToken = list.inviteToken ?? createId('inv');
    list.updatedAt = new Date().toISOString();
    list.hlc = this.clock.now();
    this.persist();
    return {
      list,
      inviteUrl: `${this.serverUrl}/join/${list.inviteToken}`,
    };
  }

  addTask(input: AddTaskInput): TaskItem {
    const cleanTitle = input.title.trim();
    if (!cleanTitle) {
      throw new Error('Task title must not be empty');
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    const task: TaskItem = {
      id: createId('task'),
      listId: input.listId,
      title: cleanTitle,
      completed: false,
      completedAt: null,
      starred: Boolean(input.starred),
      myDayDate: input.myDayDate ?? null,
      dueDate: input.dueDate ?? null,
      reminderAt: null,
      recurrence: input.recurrence ?? null,
      note: input.note ?? '',
      steps: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc,
      fieldHlcs: {
        listId: hlc,
        title: hlc,
        completed: hlc,
        completedAt: hlc,
        starred: hlc,
        myDayDate: hlc,
        dueDate: hlc,
        reminderAt: hlc,
        recurrence: hlc,
        note: hlc,
        steps: hlc,
        deletedAt: hlc,
      },
    };
    this.tasks.unshift(task);
    this.persist();
    return task;
  }

  toggleTaskCompleted(
    taskId: string,
    todayIsoDate = getLocalIsoDate(),
  ): { completedTask: TaskItem; nextRecurringTask: TaskItem | null } {
    const task = this.requireTask(taskId);
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    const nextCompleted = !task.completed;

    task.completed = nextCompleted;
    task.completedAt = nextCompleted ? nowIso : null;
    task.updatedAt = nowIso;
    task.hlc = hlc;
    task.fieldHlcs = {
      ...task.fieldHlcs,
      completed: hlc,
      completedAt: hlc,
    };

    let nextRecurringTask: TaskItem | null = null;
    if (nextCompleted && task.recurrence) {
      const baseDue = task.dueDate ?? todayIsoDate;
      const nextDueDate = computeNextDueDate(baseDue, task.recurrence);
      nextRecurringTask = this.addTask({
        title: task.title,
        listId: task.listId,
        starred: task.starred,
        myDayDate: task.myDayDate === todayIsoDate ? nextDueDate : null,
        dueDate: nextDueDate,
        recurrence: task.recurrence,
        note: task.note,
      });
    } else {
      this.persist();
    }

    return { completedTask: task, nextRecurringTask };
  }

  toggleTaskStarred(taskId: string): TaskItem {
    const task = this.requireTask(taskId);
    const hlc = this.clock.now();
    task.starred = !task.starred;
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, starred: hlc };
    this.persist();
    return task;
  }

  toggleTaskMyDay(taskId: string, todayIsoDate = getLocalIsoDate()): TaskItem {
    const task = this.requireTask(taskId);
    const hlc = this.clock.now();
    task.myDayDate = task.myDayDate === todayIsoDate ? null : todayIsoDate;
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, myDayDate: hlc };
    this.persist();
    return task;
  }

  updateTask(
    taskId: string,
    patch: Partial<Pick<TaskItem, 'title' | 'dueDate' | 'reminderAt' | 'recurrence' | 'note' | 'listId'>>,
  ): TaskItem {
    const task = this.requireTask(taskId);
    const hlc = this.clock.now();
    const fieldHlcs = { ...task.fieldHlcs };

    if (patch.title !== undefined) {
      const clean = patch.title.trim();
      if (clean) {
        task.title = clean;
        fieldHlcs.title = hlc;
      }
    }
    if (patch.dueDate !== undefined) {
      task.dueDate = patch.dueDate;
      fieldHlcs.dueDate = hlc;
    }
    if (patch.reminderAt !== undefined) {
      task.reminderAt = patch.reminderAt;
      fieldHlcs.reminderAt = hlc;
    }
    if (patch.recurrence !== undefined) {
      task.recurrence = patch.recurrence;
      fieldHlcs.recurrence = hlc;
    }
    if (patch.note !== undefined) {
      task.note = patch.note;
      fieldHlcs.note = hlc;
    }
    if (patch.listId !== undefined) {
      task.listId = patch.listId;
      fieldHlcs.listId = hlc;
    }

    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = fieldHlcs;
    this.persist();
    return task;
  }

  addTaskStep(taskId: string, stepTitle: string): TaskItem {
    const clean = stepTitle.trim();
    if (!clean) {
      throw new Error('Step title must not be empty');
    }
    const task = this.requireTask(taskId);
    const hlc = this.clock.now();
    task.steps.push({
      id: createId('step'),
      title: clean,
      completed: false,
      position: task.steps.length,
    });
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, steps: hlc };
    this.persist();
    return task;
  }

  toggleTaskStep(taskId: string, stepId: string): TaskItem {
    const task = this.requireTask(taskId);
    const step = task.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step not found: ${stepId}`);
    }
    const hlc = this.clock.now();
    step.completed = !step.completed;
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, steps: hlc };
    this.persist();
    return task;
  }

  deleteTaskStep(taskId: string, stepId: string): TaskItem {
    const task = this.requireTask(taskId);
    const hlc = this.clock.now();
    task.steps = task.steps
      .filter((s) => s.id !== stepId)
      .map((s, index) => ({ ...s, position: index }));
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, steps: hlc };
    this.persist();
    return task;
  }

  deleteTask(taskId: string): void {
    const task = this.requireTask(taskId);
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    task.deletedAt = nowIso;
    task.updatedAt = nowIso;
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, deletedAt: hlc };
    this.persist();
  }

  importJson(rawJson: string): { importedLists: number; importedTasks: number } {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const hlc = this.clock.now();

    let result;
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      result = importWunderlistJson(rawJson, hlc);
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lists)) {
      result = importMicrosoftToDoJson(rawJson, hlc);
    } else {
      throw new Error('Unsupported export format');
    }

    const existingListIds = new Set(this.lists.map((l) => l.id));
    let importedLists = 0;
    for (const list of result.lists) {
      if (!existingListIds.has(list.id)) {
        this.lists.push(list);
        existingListIds.add(list.id);
        importedLists += 1;
      }
    }

    const existingTasksById = new Map(this.tasks.map((task) => [task.id, task]));
    let importedTasks = 0;
    for (const task of result.tasks) {
      const existing = existingTasksById.get(task.id);
      if (existing) {
        const merged = mergeTaskLww(existing, task);
        const index = this.tasks.findIndex((t) => t.id === task.id);
        this.tasks[index] = merged;
      } else {
        this.tasks.unshift(task);
        importedTasks += 1;
      }
    }

    this.persist();
    return { importedLists, importedTasks };
  }

  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    this.persist();
  }

  setServerUrl(url: string): string {
    const normalized = normalizeServerUrl(url);
    this.serverUrl = normalized;
    this.persist();
    return normalized;
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.persist();
  }
}
