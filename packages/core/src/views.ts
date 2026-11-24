import type { RecurrencePattern, TaskItem } from './types.ts';

function isActive(task: TaskItem): boolean {
  return task.deletedAt === null;
}

/**
 * Advances a YYYY-MM-DD date string deterministically in UTC according to the recurrence pattern.
 */
export function computeNextDueDate(
  currentDueDate: string,
  recurrence: RecurrencePattern,
): string {
  const match = currentDueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ISO calendar date: ${currentDueDate}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));

  switch (recurrence) {
    case 'daily':
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    case 'weekly':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'weekdays': {
      do {
        date.setUTCDate(date.getUTCDate() + 1);
      } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
      break;
    }
    case 'monthly':
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case 'yearly':
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
  }

  return date.toISOString().slice(0, 10);
}

/**
 * Midnight reset is implicit and timezone-safe: a task is in "My Day" when
 * its myDayDate matches the user's current local calendar date (YYYY-MM-DD),
 * or optionally when its dueDate matches today.
 */
export function isMyDayTask(
  task: TaskItem,
  todayIsoDate: string,
  includeDueToday = false,
): boolean {
  if (!isActive(task)) return false;
  if (task.myDayDate === todayIsoDate) return true;
  return includeDueToday && !task.completed && task.dueDate === todayIsoDate;
}

export function getMyDayTasks(
  tasks: TaskItem[],
  todayIsoDate: string,
  includeDueToday = false,
): TaskItem[] {
  return tasks.filter((task) => isMyDayTask(task, todayIsoDate, includeDueToday));
}

/**
 * Smart suggestions for My Day: uncompleted active tasks not yet in today's My Day
 * that are overdue, due today (when not auto-included), or rolled over from an earlier My Day date.
 */
export function getMyDaySuggestions(
  tasks: TaskItem[],
  todayIsoDate: string,
  includeDueToday = false,
): TaskItem[] {
  return tasks.filter((task) => {
    if (!isActive(task) || task.completed || isMyDayTask(task, todayIsoDate, includeDueToday)) {
      return false;
    }
    const isDueOrOverdue =
      task.dueDate !== null &&
      (includeDueToday ? task.dueDate < todayIsoDate : task.dueDate <= todayIsoDate);
    const isFromPreviousMyDay = task.myDayDate !== null && task.myDayDate < todayIsoDate;
    return isDueOrOverdue || isFromPreviousMyDay;
  });
}

export function getStarredTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.filter((task) => isActive(task) && task.starred && !task.completed);
}

export function getPlannedTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks
    .filter((task) => isActive(task) && !task.completed && task.dueDate !== null)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
}

export function getAllOpenTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.filter((task) => isActive(task) && !task.completed);
}

export function filterTasksByQuery(tasks: TaskItem[], rawQuery: string): TaskItem[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((task) => {
    if (task.title.toLowerCase().includes(q)) return true;
    if (task.note.toLowerCase().includes(q)) return true;
    return task.steps.some((step) => step.title.toLowerCase().includes(q));
  });
}

export function sortTasksForView(tasks: TaskItem[], moveStarredToTop: boolean): TaskItem[] {
  if (!moveStarredToTop) {
    return [...tasks];
  }
  const starred: TaskItem[] = [];
  const rest: TaskItem[] = [];
  for (const task of tasks) {
    if (task.starred && !task.completed) {
      starred.push(task);
    } else {
      rest.push(task);
    }
  }
  return [...starred, ...rest];
}

export function getListTasks(tasks: TaskItem[], listId: string): TaskItem[] {
  return tasks.filter((task) => isActive(task) && task.listId === listId);
}

/**
 * Returns active uncompleted tasks whose reminder timestamp has reached nowMs
 * and has not already been fired in the current session.
 */
export function getDueReminderTasks(
  tasks: TaskItem[],
  nowMs: number,
  firedKeys?: ReadonlySet<string>,
): TaskItem[] {
  return tasks.filter((task) => {
    if (!isActive(task) || task.completed || task.reminderAt === null) {
      return false;
    }
    const key = `${task.id}:${task.reminderAt}`;
    if (firedKeys?.has(key)) {
      return false;
    }
    const dueMs = Date.parse(task.reminderAt);
    return Number.isFinite(dueMs) && dueMs <= nowMs;
  });
}
