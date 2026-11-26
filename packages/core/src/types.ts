export type TaskId = string;
export type ListId = string;
export type HlcTimestamp = string;

export type RecurrencePattern =
  | 'daily'
  | 'weekly'
  | 'weekdays'
  | 'monthly'
  | 'yearly';

export type SmartViewId =
  | 'my-day'
  | 'starred'
  | 'planned'
  | 'all'
  | 'tasks'
  | 'assigned'
  | 'lists'
  | 'trash';

export type PlannedFilterId =
  | 'all'
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'this-week'
  | 'later';

export type TaskSortMode = 'default' | 'due-date' | 'starred' | 'title';

export type ListAccessRole = 'owner' | 'editor' | 'viewer';

export const FREE_MAX_DEVICES = 2;
export const FREE_MAX_OWNED_SHARED_LISTS = 1;
export const FREE_TRASH_RETENTION_DAYS = 7;
export const PRO_SNAPSHOT_RETENTION_DAYS = 30;

export interface WorkspaceSnapshotMeta {
  id: string;
  snapshotDay: string;
  createdAt: string;
  listCount: number;
  taskCount: number;
}

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
  | 'assignee'
  | 'position'
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
  assignee?: string | null;
  position?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hlc: HlcTimestamp;
  fieldHlcs?: FieldHlcMap;
}

export interface TaskList {
  id: ListId;
  title: string;
  folder?: string | null;
  position?: number;
  shared: boolean;
  inviteToken: string | null;
  readonlyInviteToken?: string | null;
  accessRole?: ListAccessRole;
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
