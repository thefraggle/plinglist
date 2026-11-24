export type TaskId = string;
export type ListId = string;
export type HlcTimestamp = string;

export type RecurrencePattern =
  | 'daily'
  | 'weekly'
  | 'weekdays'
  | 'monthly'
  | 'yearly';

export type SmartViewId = 'my-day' | 'starred' | 'planned' | 'all' | 'tasks' | 'lists';

export interface TaskStep {
  id: string;
  title: string;
  completed: boolean;
  position: number;
}

export type MergeableTaskField =
  | 'listId'
  | 'title'
  | 'completed'
  | 'completedAt'
  | 'starred'
  | 'myDayDate'
  | 'dueDate'
  | 'reminderAt'
  | 'recurrence'
  | 'note'
  | 'steps'
  | 'deletedAt';

export type FieldHlcMap = Partial<Record<MergeableTaskField, HlcTimestamp>>;

export interface TaskItem {
  id: TaskId;
  listId: ListId;
  title: string;
  completed: boolean;
  completedAt: string | null;
  starred: boolean;
  /** Local ISO calendar date (YYYY-MM-DD); resets My Day automatically at midnight */
  myDayDate: string | null;
  /** Local ISO calendar date (YYYY-MM-DD) */
  dueDate: string | null;
  /** ISO-8601 timestamp */
  reminderAt: string | null;
  recurrence: RecurrencePattern | null;
  note: string;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hlc: HlcTimestamp;
  fieldHlcs?: FieldHlcMap;
}

export interface TaskList {
  id: ListId;
  title: string;
  shared: boolean;
  inviteToken: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hlc: HlcTimestamp;
}

export interface SyncDelta {
  tasks: TaskItem[];
  lists: TaskList[];
  cursorHlc: HlcTimestamp;
}
