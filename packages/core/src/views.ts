import type { TaskItem } from './types.ts';

function isActive(task: TaskItem): boolean {
  return task.deletedAt === null;
}

/**
 * Midnight reset is implicit and timezone-safe: a task is in "My Day" only when
 * its myDayDate matches the user's current local calendar date (YYYY-MM-DD).
 */
export function isMyDayTask(task: TaskItem, todayIsoDate: string): boolean {
  return isActive(task) && task.myDayDate === todayIsoDate;
}

export function getMyDayTasks(tasks: TaskItem[], todayIsoDate: string): TaskItem[] {
  return tasks.filter((task) => isMyDayTask(task, todayIsoDate));
}

/**
 * Smart suggestions for My Day: uncompleted active tasks not yet in today's My Day
 * that are overdue, due today, or rolled over from an earlier My Day date.
 */
export function getMyDaySuggestions(tasks: TaskItem[], todayIsoDate: string): TaskItem[] {
  return tasks.filter((task) => {
    if (!isActive(task) || task.completed || task.myDayDate === todayIsoDate) {
      return false;
    }
    const isDueOrOverdue = task.dueDate !== null && task.dueDate <= todayIsoDate;
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

export function getListTasks(tasks: TaskItem[], listId: string): TaskItem[] {
  return tasks.filter((task) => isActive(task) && task.listId === listId);
}
