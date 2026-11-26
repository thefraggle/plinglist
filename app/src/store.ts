import {
  FREE_MAX_OWNED_SHARED_LISTS,
  FREE_TRASH_RETENTION_DAYS,
  HlcClock,
  compareHlc,
  computeNextDueDate,
  importMicrosoftToDoCsv,
  importMicrosoftToDoJson,
  importWunderlistJson,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type ListAccessRole,
  type RecurrencePattern,
  type TaskItem,
  type TaskList,
} from '../../packages/core/src/index.ts';
import {
  DEFAULT_SERVER_URL,
  OFFICIAL_APP_ORIGIN,
  extractInviteTokenFromInput,
  extractSyncKeyFromInput,
  getDefaultServerUrl,
  isNativeShellOrigin,
  isOfficialCloudOrigin,
  normalizeServerUrl,
} from './config.ts';
import type { SupportedLocale } from './i18n.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PlinglistPreferences {
  addNewTasksOnTop: boolean;
  moveStarredToTop: boolean;
  confirmBeforeDelete: boolean;
  autoAddDueTodayToMyDay: boolean;
  autoHideEmptySmartLists: boolean;
  showAllSmartList: boolean;
  telemetryEnabled: boolean;
  telemetryOptedOut?: boolean;
  syncEnabled: boolean;
  displayName: string;
}

export const DEFAULT_PREFERENCES: PlinglistPreferences = {
  addNewTasksOnTop: true,
  moveStarredToTop: true,
  confirmBeforeDelete: true,
  autoAddDueTodayToMyDay: true,
  autoHideEmptySmartLists: false,
  showAllSmartList: false,
  telemetryEnabled: true,
  telemetryOptedOut: false,
  syncEnabled: true,
  displayName: '',
};

export type StoreEntitlementPlan = 'free' | 'pro_yearly' | 'pro_lifetime';

export class SharedListLimitError extends Error {
  readonly code = 'SHARED_LIST_LIMIT_REACHED';

  constructor() {
    super(
      `Free plan allows up to ${FREE_MAX_OWNED_SHARED_LISTS} active own shared list`,
    );
    this.name = 'SharedListLimitError';
  }
}

export class ProEntitlementRequiredError extends Error {
  readonly code = 'PRO_ENTITLEMENT_REQUIRED';

  constructor(feature = 'this feature') {
    super(`Plinglist Pro entitlement required for ${feature}`);
    this.name = 'ProEntitlementRequiredError';
  }
}

interface PersistedState {
  version: 1;
  userId?: string;
  syncKey?: string;
  cursorHlc?: HlcTimestamp | null;
  entitlementPlan?: StoreEntitlementPlan;
  leftListIds?: string[];
  locale: SupportedLocale;
  serverUrl: string;
  soundEnabled: boolean;
  preferences?: Partial<PlinglistPreferences>;
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
  assignee?: string | null;
}

const STORAGE_KEY = 'plinglist.local.v1';

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createInviteToken(prefix: 'inv' | 'inv-ro' = 'inv'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }
  const fallback = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(
    24,
    '0',
  );
  return `${prefix}-${fallback.slice(0, 24)}`;
}

const MS_PER_DAY = 86_400_000;

function isTaskScrubbed(task: TaskItem): boolean {
  return task.deletedAt !== null && task.title === '' && task.note === '' && task.steps.length === 0;
}

function isListScrubbed(list: TaskList): boolean {
  return list.deletedAt !== null && list.title === '';
}

function isWithinRetentionWindow(deletedAt: string | null, nowMs: number, retentionDays: number): boolean {
  if (!deletedAt) return false;
  const deletedMs = Date.parse(deletedAt);
  if (!Number.isFinite(deletedMs)) return false;
  return nowMs - deletedMs <= retentionDays * MS_PER_DAY;
}

export function generateSyncKey(): string {
  const raw =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(
          24,
          '0',
        );
  return `pling-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}-${raw.slice(18, 24)}`;
}

export function deriveWorkspaceSuffix(syncKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < syncKey.length; i += 1) {
    hash ^= syncKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
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
  private readonly onLocalMutation?: () => void;
  private readonly clock: HlcClock;
  lists: TaskList[] = [];
  tasks: TaskItem[] = [];
  userId: string = createId('usr');
  syncKey: string = generateSyncKey();
  cursorHlc: HlcTimestamp | null = null;
  private lastPushedHlc: HlcTimestamp | null = null;
  entitlementPlan: StoreEntitlementPlan = 'free';
  leftListIds: string[] = [];
  lastSyncErrorCode: string | null = null;
  locale: SupportedLocale = 'de';
  serverUrl: string = getDefaultServerUrl();
  soundEnabled = true;
  preferences: PlinglistPreferences = { ...DEFAULT_PREFERENCES };
  lastStorageError: string | null = null;

  constructor(options?: {
    storage?: StorageLike | null;
    locale?: SupportedLocale;
    nodeId?: string;
    serverUrl?: string;
    syncKey?: string;
    onLocalMutation?: () => void;
  }) {
    this.storage = options?.storage ?? null;
    this.onLocalMutation = options?.onLocalMutation;
    this.clock = new HlcClock(options?.nodeId ?? 'web-local');
    if (options?.locale) {
      this.locale = options.locale;
    }
    if (options?.serverUrl) {
      this.serverUrl = normalizeServerUrl(options.serverUrl);
    }
    if (options?.syncKey?.trim()) {
      this.syncKey = options.syncKey.trim();
    }

    const loaded = this.load();
    if (!loaded) {
      this.seedDefaults();
      this.persist();
    }
    if (!this.isTelemetrySupported()) {
      this.preferences.telemetryEnabled = false;
    }
  }

  private seedDefaults(hlcOverride?: HlcTimestamp): void {
    const timestampIso =
      hlcOverride === '000000000000000:00000:init'
        ? '1970-01-01T00:00:00.000Z'
        : new Date().toISOString();
    const hlc = hlcOverride ?? this.clock.now();
    const suffix = deriveWorkspaceSuffix(this.syncKey);
    this.lists = [
      {
        id: `list-tasks-${suffix}`,
        title: this.locale === 'de' ? 'Aufgaben' : 'Tasks',
        shared: false,
        inviteToken: null,
        createdAt: timestampIso,
        updatedAt: timestampIso,
        deletedAt: null,
        hlc,
      },
      {
        id: `list-groceries-${suffix}`,
        title: this.locale === 'de' ? 'Einkauf' : 'Groceries',
        shared: false,
        inviteToken: null,
        createdAt: timestampIso,
        updatedAt: timestampIso,
        deletedAt: null,
        hlc,
      },
    ];
  }

  getDefaultTasksListId(): string {
    const active = this.getActiveLists();
    const systemList = active.find(
      (list) => list.id === 'list-tasks' || list.id.startsWith('list-tasks-'),
    );
    return systemList?.id ?? active[0]?.id ?? `list-tasks-${deriveWorkspaceSuffix(this.syncKey)}`;
  }

  isSystemTasksList(listId: string): boolean {
    return (
      listId === 'list-tasks' ||
      listId.startsWith('list-tasks-') ||
      listId === this.getDefaultTasksListId()
    );
  }

  private consolidateWorkspaceLists(): boolean {
    const suffix = deriveWorkspaceSuffix(this.syncKey);
    const nowIso = new Date().toISOString();
    let changed = false;

    const remapTasksToList = (
      matchesListId: (id: string) => boolean,
      canonicalId: string,
    ): void => {
      for (const task of this.tasks) {
        if (matchesListId(task.listId) && task.listId !== canonicalId) {
          const hlc = this.clock.now();
          task.listId = canonicalId;
          task.hlc = hlc;
          task.updatedAt = nowIso;
          task.fieldHlcs = { ...task.fieldHlcs, listId: hlc };
          changed = true;
        }
      }
    };

    const isTasksId = (id: string): boolean => id === 'list-tasks' || id.startsWith('list-tasks-');
    const canonicalTasksId = `list-tasks-${suffix}`;
    const taskLists = this.lists.filter((l) => isTasksId(l.id));
    if (taskLists.length > 0) {
      const keeper = taskLists.find((l) => l.id === canonicalTasksId) ?? taskLists[0];
      const needsUpdate =
        keeper.id !== canonicalTasksId ||
        taskLists.length > 1 ||
        keeper.shared ||
        keeper.inviteToken !== null ||
        keeper.deletedAt !== null;
      if (needsUpdate) {
        keeper.id = canonicalTasksId;
        keeper.shared = false;
        keeper.inviteToken = null;
        keeper.deletedAt = null;
        keeper.updatedAt = nowIso;
        keeper.hlc = this.clock.now();
        this.lists = this.lists.filter((l) => !isTasksId(l.id) || l === keeper);
        changed = true;
      }
      remapTasksToList(isTasksId, canonicalTasksId);
    }

    const isGroceriesId = (id: string): boolean =>
      id === 'list-groceries' || id.startsWith('list-groceries-');
    const canonicalGroceriesId = `list-groceries-${suffix}`;
    const groceryLists = this.lists.filter((l) => isGroceriesId(l.id));
    if (groceryLists.length > 0) {
      const activeGroceries = groceryLists.filter((l) => l.deletedAt === null);
      const keeper =
        activeGroceries.find((l) => l.id === canonicalGroceriesId) ??
        activeGroceries[0] ??
        groceryLists.find((l) => l.id === canonicalGroceriesId) ??
        groceryLists[0];
      if (keeper.id !== canonicalGroceriesId || groceryLists.length > 1) {
        keeper.id = canonicalGroceriesId;
        keeper.updatedAt = nowIso;
        keeper.hlc = this.clock.now();
        this.lists = this.lists.filter((l) => !isGroceriesId(l.id) || l === keeper);
        changed = true;
      }
      remapTasksToList(isGroceriesId, canonicalGroceriesId);
    }

    return changed;
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
      this.userId = parsed.userId || this.userId;
      const rawSyncKey = parsed.syncKey?.trim() || this.syncKey;
      const cleanedSyncKey = extractSyncKeyFromInput(rawSyncKey) || this.syncKey;
      const migratedLegacySyncKeyUrl = cleanedSyncKey !== rawSyncKey;
      this.syncKey = cleanedSyncKey;
      this.cursorHlc = migratedLegacySyncKeyUrl ? null : (parsed.cursorHlc ?? null);
      this.entitlementPlan =
        parsed.entitlementPlan === 'pro_yearly' || parsed.entitlementPlan === 'pro_lifetime'
          ? parsed.entitlementPlan
          : 'free';
      this.leftListIds = Array.isArray(parsed.leftListIds)
        ? parsed.leftListIds.filter((id): id is string => typeof id === 'string')
        : [];
      this.locale = parsed.locale === 'en' ? 'en' : 'de';
      const loadedServerUrl = parsed.serverUrl
        ? normalizeServerUrl(parsed.serverUrl)
        : getDefaultServerUrl();
      const webOrigin =
        typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined;
      const migratedLegacyApiUrl =
        loadedServerUrl === DEFAULT_SERVER_URL &&
        !isNativeShellOrigin(webOrigin) &&
        Boolean(webOrigin && (webOrigin.startsWith('http://') || webOrigin.startsWith('https://')));
      this.serverUrl = migratedLegacyApiUrl ? getDefaultServerUrl() : loadedServerUrl;
      this.soundEnabled = parsed.soundEnabled !== false;
      this.preferences = { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) };
      if (this.isTelemetrySupported() && parsed.preferences?.telemetryOptedOut !== true) {
        // Re-enable telemetry on native shell upgrades where previous builds saved telemetryEnabled=false by default.
        this.preferences.telemetryEnabled = true;
      }
      this.lists = parsed.lists;
      this.tasks = parsed.tasks;
      for (const list of this.lists) {
        this.clock.receive(list.hlc);
      }
      for (const task of this.tasks) {
        this.clock.receive(task.hlc);
      }
      const consolidated = this.consolidateWorkspaceLists();
      const purgedCount = this.purgeExpiredTrash();
      if (consolidated || migratedLegacyApiUrl || migratedLegacySyncKeyUrl || purgedCount > 0) {
        this.persist(true);
      }
      return this.lists.length > 0;
    } catch {
      return false;
    }
  }

  private persist(fromRemoteSync = false): void {
    if (this.storage) {
      const payload: PersistedState = {
        version: 1,
        userId: this.userId,
        syncKey: this.syncKey,
        cursorHlc: this.cursorHlc,
        entitlementPlan: this.entitlementPlan,
        leftListIds: this.leftListIds,
        locale: this.locale,
        serverUrl: this.serverUrl,
        soundEnabled: this.soundEnabled,
        preferences: this.preferences,
        lists: this.lists,
        tasks: this.tasks,
      };
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
        this.lastStorageError = null;
      } catch (err) {
        this.lastStorageError =
          err instanceof Error ? err.message : 'STORAGE_WRITE_FAILED';
      }
    }
    if (!fromRemoteSync) {
      this.onLocalMutation?.();
    }
  }

  isPro(): boolean {
    return this.entitlementPlan === 'pro_yearly' || this.entitlementPlan === 'pro_lifetime';
  }

  isForeignJoinedList(list: TaskList): boolean {
    return list.accessRole === 'editor' || list.accessRole === 'viewer';
  }

  isReadOnlyList(listId: string): boolean {
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    return list?.accessRole === 'viewer';
  }

  private assertListWritable(listId: string): void {
    if (this.isReadOnlyList(listId)) {
      throw new Error('Cannot modify a read-only shared list');
    }
  }

  private requireTask(taskId: string): TaskItem {
    const task = this.tasks.find((item) => item.id === taskId && item.deletedAt === null);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private requireWritableTask(taskId: string): TaskItem {
    const task = this.requireTask(taskId);
    this.assertListWritable(task.listId);
    return task;
  }

  private scrubTaskFields(task: TaskItem, nowIso: string, hlc: HlcTimestamp): void {
    task.title = '';
    task.note = '';
    task.steps = [];
    task.dueDate = null;
    task.reminderAt = null;
    task.myDayDate = null;
    task.starred = false;
    task.assignee = null;
    task.deletedAt = nowIso;
    task.updatedAt = nowIso;
    task.hlc = hlc;
    task.fieldHlcs = {
      ...task.fieldHlcs,
      title: hlc,
      note: hlc,
      steps: hlc,
      dueDate: hlc,
      reminderAt: hlc,
      myDayDate: hlc,
      starred: hlc,
      assignee: hlc,
      deletedAt: hlc,
    };
  }

  private scrubListFields(list: TaskList, nowIso: string, hlc: HlcTimestamp): void {
    list.title = '';
    list.shared = false;
    list.inviteToken = null;
    list.readonlyInviteToken = null;
    list.deletedAt = nowIso;
    list.updatedAt = nowIso;
    list.hlc = hlc;
  }

  getActiveLists(): TaskList[] {
    return this.lists.filter((list) => list.deletedAt === null);
  }

  getCustomLists(): TaskList[] {
    return this.getActiveLists().filter((list) => !this.isSystemTasksList(list.id));
  }

  getOwnedSharedLists(): TaskList[] {
    return this.getActiveLists().filter((list) => list.shared && !this.isForeignJoinedList(list));
  }

  canShareAnotherOwnedList(targetListId?: string): boolean {
    if (this.isPro()) {
      return true;
    }
    const ownedShared = this.getOwnedSharedLists();
    return (
      ownedShared.length < FREE_MAX_OWNED_SHARED_LISTS ||
      (targetListId !== undefined && ownedShared.some((list) => list.id === targetListId))
    );
  }

  addList(title: string, folder?: string | null): TaskList {
    const raw = title.trim();
    if (!raw) {
      throw new Error('List title must not be empty');
    }
    let cleanTitle = raw;
    let cleanFolder = folder?.trim() || null;
    if (folder === undefined && raw.includes(' / ')) {
      const [prefix, ...rest] = raw.split(' / ');
      const candidateTitle = rest.join(' / ').trim();
      if (prefix.trim() && candidateTitle) {
        cleanFolder = prefix.trim();
        cleanTitle = candidateTitle;
      }
    }
    const nowIso = new Date().toISOString();
    const list: TaskList = {
      id: createId('list'),
      title: cleanTitle,
      folder: cleanFolder,
      shared: false,
      inviteToken: null,
      readonlyInviteToken: null,
      accessRole: 'owner',
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: this.clock.now(),
    };
    this.lists.push(list);
    this.persist();
    return list;
  }

  renameList(listId: string, nextTitle: string, nextFolder?: string | null): TaskList {
    if (this.isSystemTasksList(listId)) {
      throw new Error('Cannot rename the default tasks list');
    }
    this.assertListWritable(listId);
    const clean = nextTitle.trim();
    if (!clean) {
      throw new Error('List title must not be empty');
    }
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    list.title = clean;
    if (nextFolder !== undefined) {
      list.folder = nextFolder?.trim() || null;
    }
    list.updatedAt = new Date().toISOString();
    list.hlc = this.clock.now();
    this.persist();
    return list;
  }

  duplicateList(listId: string, customTitle?: string): TaskList {
    const source = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!source) {
      throw new Error(`List not found: ${listId}`);
    }
    const nowIso = new Date().toISOString();
    const listHlc = this.clock.now();
    const duplicatedList: TaskList = {
      id: createId('list'),
      title: customTitle?.trim() || `${source.title} (2)`,
      folder: source.folder ?? null,
      shared: false,
      inviteToken: null,
      readonlyInviteToken: null,
      accessRole: 'owner',
      createdAt: nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc: listHlc,
    };
    this.lists.push(duplicatedList);

    const sourceTasks = this.tasks.filter(
      (task) => task.listId === listId && task.deletedAt === null,
    );
    for (const src of sourceTasks) {
      const hlc = this.clock.now();
      const cloned: TaskItem = {
        id: createId('task'),
        listId: duplicatedList.id,
        title: src.title,
        completed: false,
        completedAt: null,
        starred: src.starred,
        myDayDate: null,
        dueDate: src.dueDate,
        reminderAt: null,
        recurrence: src.recurrence,
        note: src.note,
        steps: src.steps.map((s, idx) => ({
          id: createId('step'),
          title: s.title,
          completed: false,
          position: idx,
        })),
        assignee: src.assignee ?? null,
        ...(typeof src.position === 'number' ? { position: src.position } : {}),
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
          assignee: hlc,
          ...(typeof src.position === 'number' ? { position: hlc } : {}),
          deletedAt: hlc,
        },
      };
      this.tasks.push(cloned);
    }
    this.persist();
    return duplicatedList;
  }

  getListFolders(): string[] {
    const folders = new Set<string>();
    for (const list of this.getCustomLists()) {
      const folder = list.folder?.trim();
      if (folder) folders.add(folder);
    }
    return Array.from(folders).sort((a, b) => a.localeCompare(b));
  }

  deleteList(listId: string, options?: { permanent?: boolean }): void {
    if (this.isSystemTasksList(listId)) {
      throw new Error('Cannot delete the default tasks list');
    }
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    if (this.getActiveLists().length <= 1) {
      throw new Error('Cannot delete the last remaining list');
    }
    if (this.isForeignJoinedList(list)) {
      this.leaveSharedList(listId);
      return;
    }
    if (list.shared) {
      throw new Error('Cannot delete an actively shared list');
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    if (options?.permanent) {
      this.scrubListFields(list, nowIso, hlc);
      for (const task of this.tasks) {
        if (task.listId === listId && !isTaskScrubbed(task)) {
          this.scrubTaskFields(task, nowIso, hlc);
        }
      }
    } else {
      list.shared = false;
      list.inviteToken = null;
      list.readonlyInviteToken = null;
      list.deletedAt = nowIso;
      list.updatedAt = nowIso;
      list.hlc = hlc;

      for (const task of this.tasks) {
        if (task.listId === listId && task.deletedAt === null) {
          task.deletedAt = nowIso;
          task.updatedAt = nowIso;
          task.hlc = hlc;
          task.fieldHlcs = {
            ...task.fieldHlcs,
            deletedAt: hlc,
          };
        }
      }
    }
    this.persist();
  }

  getPairingUrl(appOrigin = 'https://plinglist.app'): string {
    const cleanOrigin = appOrigin.replace(/\/+$/, '');
    return `${cleanOrigin}/?pair=${encodeURIComponent(this.syncKey)}`;
  }

  getInviteUrl(
    listId: string,
    appOrigin?: string,
    options?: { readOnly?: boolean },
  ): string | null {
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list || !list.shared) {
      return null;
    }
    const token = options?.readOnly ? list.readonlyInviteToken : list.inviteToken;
    if (!token) {
      return null;
    }
    return appOrigin
      ? `${appOrigin.replace(/\/+$/, '')}/?join=${encodeURIComponent(token)}`
      : `${this.serverUrl}/join/${token}`;
  }

  shareList(
    listId: string,
    appOrigin?: string,
    options?: { readOnly?: boolean },
  ): { list: TaskList; inviteUrl: string } {
    if (this.isSystemTasksList(listId)) {
      throw new Error('Cannot share the default tasks list');
    }
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    if (!this.canShareAnotherOwnedList(listId)) {
      throw new SharedListLimitError();
    }
    if (options?.readOnly && !this.isPro()) {
      throw new ProEntitlementRequiredError('read-only share links');
    }
    list.shared = true;
    list.inviteToken = list.inviteToken ?? createInviteToken('inv');
    if (options?.readOnly) {
      list.readonlyInviteToken = list.readonlyInviteToken ?? createInviteToken('inv-ro');
    }
    list.updatedAt = new Date().toISOString();
    list.hlc = this.clock.now();
    this.persist();
    const activeToken = options?.readOnly ? list.readonlyInviteToken! : list.inviteToken;
    const inviteUrl = appOrigin
      ? `${appOrigin.replace(/\/+$/, '')}/?join=${encodeURIComponent(activeToken)}`
      : `${this.serverUrl}/join/${activeToken}`;
    return {
      list,
      inviteUrl,
    };
  }

  unshareList(listId: string): TaskList {
    const list = this.lists.find((item) => item.id === listId && item.deletedAt === null);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    list.shared = false;
    list.inviteToken = null;
    list.readonlyInviteToken = null;
    list.updatedAt = new Date().toISOString();
    list.hlc = this.clock.now();
    this.persist();
    return list;
  }

  leaveSharedList(listId: string): void {
    const list = this.lists.find((item) => item.id === listId);
    if (!list) return;
    this.lists = this.lists.filter((item) => item.id !== listId);
    this.tasks = this.tasks.filter((task) => task.listId !== listId);
    if (!this.leftListIds.includes(listId)) {
      this.leftListIds.push(listId);
    }
    this.persist();
  }

  addTask(input: AddTaskInput): TaskItem {
    this.assertListWritable(input.listId);
    const cleanTitle = input.title.trim();
    if (!cleanTitle) {
      throw new Error('Task title must not be empty');
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    const cleanAssignee = input.assignee?.trim().replace(/^@+/, '') || null;
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
      assignee: cleanAssignee,
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
        assignee: hlc,
        deletedAt: hlc,
      },
    };
    if (this.preferences.addNewTasksOnTop) {
      this.tasks.unshift(task);
    } else {
      this.tasks.push(task);
    }
    this.persist();
    return task;
  }

  toggleTaskCompleted(
    taskId: string,
    todayIsoDate = getLocalIsoDate(),
  ): { completedTask: TaskItem; nextRecurringTask: TaskItem | null } {
    const task = this.requireWritableTask(taskId);
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
    const task = this.requireWritableTask(taskId);
    const hlc = this.clock.now();
    task.starred = !task.starred;
    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, starred: hlc };
    this.persist();
    return task;
  }

  toggleTaskMyDay(taskId: string, todayIsoDate = getLocalIsoDate()): TaskItem {
    const task = this.requireWritableTask(taskId);
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
    patch: Partial<
      Pick<
        TaskItem,
        'title' | 'dueDate' | 'reminderAt' | 'recurrence' | 'note' | 'listId' | 'assignee' | 'position'
      >
    >,
  ): TaskItem {
    const task = this.requireWritableTask(taskId);
    if (patch.listId !== undefined) {
      this.assertListWritable(patch.listId);
    }
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
    if (patch.assignee !== undefined) {
      task.assignee = patch.assignee?.trim().replace(/^@+/, '') || null;
      fieldHlcs.assignee = hlc;
    }
    if (patch.position !== undefined) {
      task.position = patch.position;
      fieldHlcs.position = hlc;
    }

    task.updatedAt = new Date().toISOString();
    task.hlc = hlc;
    task.fieldHlcs = fieldHlcs;
    this.persist();
    return task;
  }

  clearCompletedTasks(listId?: string): number {
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    let cleared = 0;
    for (const task of this.tasks) {
      if (
        task.deletedAt === null &&
        task.completed &&
        (!listId || task.listId === listId) &&
        !this.isReadOnlyList(task.listId)
      ) {
        task.deletedAt = nowIso;
        task.updatedAt = nowIso;
        task.hlc = hlc;
        task.fieldHlcs = { ...task.fieldHlcs, deletedAt: hlc };
        cleared += 1;
      }
    }
    if (cleared > 0) {
      this.persist();
    }
    return cleared;
  }

  moveTaskOrder(
    draggedTaskId: string,
    targetTaskId: string,
    orderedVisibleIds?: string[],
  ): boolean {
    if (draggedTaskId === targetTaskId) return false;
    const dragged = this.requireWritableTask(draggedTaskId);
    const target = this.requireTask(targetTaskId);
    if (!dragged || !target) return false;

    const baseIds =
      orderedVisibleIds && orderedVisibleIds.length > 0
        ? orderedVisibleIds.filter((id) =>
            this.tasks.some((t) => t.id === id && t.deletedAt === null),
          )
        : this.tasks.filter((t) => t.deletedAt === null && !t.completed).map((t) => t.id);

    const fromIdx = baseIds.indexOf(draggedTaskId);
    const toIdx = baseIds.indexOf(targetTaskId);
    if (fromIdx < 0 || toIdx < 0) return false;

    baseIds.splice(fromIdx, 1);
    baseIds.splice(toIdx, 0, draggedTaskId);

    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    baseIds.forEach((id, index) => {
      const item = this.tasks.find((t) => t.id === id);
      if (item && !this.isReadOnlyList(item.listId)) {
        item.position = index;
        item.updatedAt = nowIso;
        item.hlc = hlc;
        item.fieldHlcs = { ...item.fieldHlcs, position: hlc };
      }
    });
    this.persist();
    return true;
  }

  addTaskStep(taskId: string, stepTitle: string): TaskItem {
    const clean = stepTitle.trim();
    if (!clean) {
      throw new Error('Step title must not be empty');
    }
    const task = this.requireWritableTask(taskId);
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
    const task = this.requireWritableTask(taskId);
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
    const task = this.requireWritableTask(taskId);
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

  deleteTask(taskId: string, options?: { permanent?: boolean }): void {
    const task = this.requireWritableTask(taskId);
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    if (options?.permanent) {
      this.scrubTaskFields(task, nowIso, hlc);
    } else {
      task.deletedAt = nowIso;
      task.updatedAt = nowIso;
      task.hlc = hlc;
      task.fieldHlcs = {
        ...task.fieldHlcs,
        deletedAt: hlc,
      };
    }
    this.persist();
  }

  getDeletedLists(
    nowMs = Date.now(),
    retentionDays = FREE_TRASH_RETENTION_DAYS,
  ): TaskList[] {
    return this.lists.filter(
      (list) =>
        !this.isSystemTasksList(list.id) &&
        !isListScrubbed(list) &&
        list.title.trim().length > 0 &&
        isWithinRetentionWindow(list.deletedAt, nowMs, retentionDays),
    );
  }

  getDeletedTasks(
    nowMs = Date.now(),
    retentionDays = FREE_TRASH_RETENTION_DAYS,
  ): TaskItem[] {
    return this.tasks.filter(
      (task) =>
        !isTaskScrubbed(task) &&
        task.title.trim().length > 0 &&
        isWithinRetentionWindow(task.deletedAt, nowMs, retentionDays),
    );
  }

  restoreList(listId: string): TaskList {
    const list = this.lists.find((item) => item.id === listId && item.deletedAt !== null);
    if (!list || isListScrubbed(list)) {
      throw new Error(`Deleted list not recoverable: ${listId}`);
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    list.deletedAt = null;
    list.updatedAt = nowIso;
    list.hlc = hlc;

    for (const task of this.tasks) {
      if (task.listId === listId && task.deletedAt !== null && !isTaskScrubbed(task)) {
        task.deletedAt = null;
        task.updatedAt = nowIso;
        task.hlc = hlc;
        task.fieldHlcs = { ...task.fieldHlcs, deletedAt: hlc };
      }
    }
    this.persist();
    return list;
  }

  restoreTask(taskId: string): TaskItem {
    const task = this.tasks.find((item) => item.id === taskId && item.deletedAt !== null);
    if (!task || isTaskScrubbed(task)) {
      throw new Error(`Deleted task not recoverable: ${taskId}`);
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();

    const parentList = this.lists.find((item) => item.id === task.listId);
    if (parentList && parentList.deletedAt !== null) {
      if (!isListScrubbed(parentList)) {
        parentList.deletedAt = null;
        parentList.updatedAt = nowIso;
        parentList.hlc = hlc;
      } else {
        task.listId = this.getDefaultTasksListId();
        task.fieldHlcs = { ...task.fieldHlcs, listId: hlc };
      }
    } else if (!parentList) {
      task.listId = this.getDefaultTasksListId();
      task.fieldHlcs = { ...task.fieldHlcs, listId: hlc };
    }

    task.deletedAt = null;
    task.updatedAt = nowIso;
    task.hlc = hlc;
    task.fieldHlcs = { ...task.fieldHlcs, deletedAt: hlc };
    this.persist();
    return task;
  }

  permanentlyDeleteTask(taskId: string): void {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    this.assertListWritable(task.listId);
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    this.scrubTaskFields(task, nowIso, hlc);
    this.persist();
  }

  permanentlyDeleteList(listId: string): void {
    if (this.isSystemTasksList(listId)) {
      throw new Error('Cannot delete the default tasks list');
    }
    const list = this.lists.find((item) => item.id === listId);
    if (!list) {
      throw new Error(`List not found: ${listId}`);
    }
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    this.scrubListFields(list, nowIso, hlc);
    for (const task of this.tasks) {
      if (task.listId === listId && !isTaskScrubbed(task)) {
        this.scrubTaskFields(task, nowIso, hlc);
      }
    }
    this.persist();
  }

  emptyTrash(): { scrubbedLists: number; scrubbedTasks: number } {
    const nowIso = new Date().toISOString();
    const hlc = this.clock.now();
    let scrubbedLists = 0;
    let scrubbedTasks = 0;

    for (const list of this.lists) {
      if (list.deletedAt !== null && !isListScrubbed(list) && !this.isSystemTasksList(list.id)) {
        this.scrubListFields(list, nowIso, hlc);
        scrubbedLists += 1;
      }
    }
    for (const task of this.tasks) {
      if (task.deletedAt !== null && !isTaskScrubbed(task)) {
        this.scrubTaskFields(task, nowIso, hlc);
        scrubbedTasks += 1;
      }
    }
    if (scrubbedLists > 0 || scrubbedTasks > 0) {
      this.persist();
    }
    return { scrubbedLists, scrubbedTasks };
  }

  purgeExpiredTrash(
    nowMs = Date.now(),
    retentionDays = FREE_TRASH_RETENTION_DAYS,
  ): number {
    const nowIso = new Date(nowMs).toISOString();
    let purged = 0;

    for (const list of this.lists) {
      if (
        list.deletedAt !== null &&
        !isListScrubbed(list) &&
        !isWithinRetentionWindow(list.deletedAt, nowMs, retentionDays)
      ) {
        this.scrubListFields(list, nowIso, this.clock.now(nowMs));
        purged += 1;
      }
    }
    for (const task of this.tasks) {
      if (
        task.deletedAt !== null &&
        !isTaskScrubbed(task) &&
        !isWithinRetentionWindow(task.deletedAt, nowMs, retentionDays)
      ) {
        this.scrubTaskFields(task, nowIso, this.clock.now(nowMs));
        purged += 1;
      }
    }
    return purged;
  }

  importJson(rawInput: string): { importedLists: number; importedTasks: number } {
    const trimmed = rawInput.replace(/^\uFEFF/, '').trim();
    const hlc = this.clock.now();

    let result;
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        result = importWunderlistJson(trimmed, hlc);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lists)) {
        result = importMicrosoftToDoJson(trimmed, hlc);
      } else {
        throw new Error('Unsupported export format');
      }
    } else {
      result = importMicrosoftToDoCsv(trimmed, hlc);
    }

    const suffix = deriveWorkspaceSuffix(this.syncKey);
    const existingListIds = new Set(this.lists.map((l) => l.id));
    let importedLists = 0;
    for (const rawList of result.lists) {
      const list: TaskList = {
        ...rawList,
        id: `${rawList.id}-${suffix}`,
      };
      if (!existingListIds.has(list.id)) {
        this.lists.push(list);
        existingListIds.add(list.id);
        importedLists += 1;
      }
    }

    const existingTasksById = new Map(this.tasks.map((task) => [task.id, task]));
    let importedTasks = 0;
    for (const rawTask of result.tasks) {
      const task: TaskItem = {
        ...rawTask,
        id: `${rawTask.id}-${suffix}`,
        listId: `${rawTask.listId}-${suffix}`,
      };
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
    if (normalized !== this.serverUrl) {
      this.cursorHlc = null;
      this.lastPushedHlc = null;
    }
    this.serverUrl = normalized;
    this.persist();
    return normalized;
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.persist();
  }

  isTelemetrySupported(locationOrigin?: string): boolean {
    if (isOfficialCloudOrigin(locationOrigin)) {
      return true;
    }
    const origin =
      locationOrigin ??
      (typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined);
    return (
      isNativeShellOrigin(origin) &&
      (this.serverUrl === DEFAULT_SERVER_URL || this.serverUrl === OFFICIAL_APP_ORIGIN)
    );
  }

  isTelemetryActive(locationOrigin?: string): boolean {
    return this.isTelemetrySupported(locationOrigin) && Boolean(this.preferences.telemetryEnabled);
  }

  setPreferences(patch: Partial<PlinglistPreferences>): PlinglistPreferences {
    const next = { ...this.preferences, ...patch };
    if (this.isTelemetrySupported()) {
      if (patch.telemetryEnabled !== undefined) {
        next.telemetryOptedOut = !patch.telemetryEnabled;
      }
    } else {
      next.telemetryEnabled = false;
    }
    this.preferences = next;
    this.persist();
    return this.preferences;
  }

  forceFullSync(): void {
    this.cursorHlc = null;
    this.lastPushedHlc = null;
  }

  setSyncKey(nextSyncKey: string, options?: { forceReset?: boolean }): string {
    const clean = extractSyncKeyFromInput(nextSyncKey);
    if (clean.length < 8) {
      throw new Error('Sync-Key must be at least 8 characters');
    }
    const prevSyncKey = this.syncKey;
    this.syncKey = clean;
    this.cursorHlc = null;
    this.lastPushedHlc = null;

    if (clean !== prevSyncKey || options?.forceReset) {
      this.tasks = [];
      this.leftListIds = [];
      this.entitlementPlan = 'free';
      this.lastSyncErrorCode = null;
      this.seedDefaults('000000000000000:00000:init');
    } else {
      this.consolidateWorkspaceLists();
    }

    this.persist();
    return clean;
  }

  applyServerSync(response: {
    serverLists?: TaskList[];
    serverTasks: TaskItem[];
    revokedListIds?: string[];
    cursorHlc: HlcTimestamp | null;
  }): { pulledLists: number; pulledTasks: number; revokedLists: number } {
    let pulledLists = 0;
    let pulledTasks = 0;

    for (const incomingList of response.serverLists ?? []) {
      this.clock.receive(incomingList.hlc);
      const index = this.lists.findIndex((l) => l.id === incomingList.id);
      if (index >= 0) {
        this.lists[index] = mergeListLww(this.lists[index], incomingList);
      } else {
        this.lists.push(incomingList);
      }
      pulledLists += 1;
    }

    for (const incomingTask of response.serverTasks) {
      this.clock.receive(incomingTask.hlc);
      const index = this.tasks.findIndex((item) => item.id === incomingTask.id);
      if (index >= 0) {
        this.tasks[index] = mergeTaskLww(this.tasks[index], incomingTask);
      } else {
        this.tasks.unshift(incomingTask);
      }
      pulledTasks += 1;
    }

    let revokedLists = 0;
    for (const revokedId of response.revokedListIds ?? []) {
      if (this.isSystemTasksList(revokedId)) continue;
      if (this.lists.some((l) => l.id === revokedId)) {
        this.lists = this.lists.filter((l) => l.id !== revokedId);
        this.tasks = this.tasks.filter((t) => t.listId !== revokedId);
        revokedLists += 1;
      }
    }

    if (response.cursorHlc) {
      this.cursorHlc = response.cursorHlc;
    }

    this.consolidateWorkspaceLists();
    this.persist(true);
    return { pulledLists, pulledTasks, revokedLists };
  }

  async syncWithServer(
    fetchFn: typeof fetch = globalThis.fetch,
    options?: { replaceOldestDevice?: boolean },
  ): Promise<{ synced: boolean; pulledLists: number; pulledTasks: number; revokedLists: number }> {
    if (!this.preferences.syncEnabled) {
      return { synced: false, pulledLists: 0, pulledTasks: 0, revokedLists: 0 };
    }

    const inviteTokens: Record<string, string> = {};
    for (const list of this.lists) {
      const token =
        list.accessRole === 'viewer'
          ? (list.readonlyInviteToken ?? list.inviteToken)
          : (list.inviteToken ?? list.readonlyInviteToken);
      if (token) {
        inviteTokens[list.id] = token;
      }
    }

    const sendFullSnapshot = this.cursorHlc === null || this.lastPushedHlc === null;
    const pushedThreshold = this.lastPushedHlc;
    const clientLists = (
      sendFullSnapshot
        ? this.lists
        : this.lists.filter((l) => compareHlc(l.hlc, pushedThreshold!) > 0)
    ).map((l) => ({ ...l }));
    const clientTasks = (
      sendFullSnapshot
        ? this.tasks
        : this.tasks.filter((t) => compareHlc(t.hlc, pushedThreshold!) > 0)
    ).map((t) => ({ ...t }));
    const sentHlcs: HlcTimestamp[] = [
      ...clientLists.map((l) => l.hlc),
      ...clientTasks.map((t) => t.hlc),
    ];
    const pendingLeaveListIds = [...this.leftListIds];

    const requestSyncKey = this.syncKey;
    try {
      const response = await fetchFn(`${this.serverUrl}/api/v1/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.userId,
          syncKey: requestSyncKey,
          inviteTokens,
          listIds: this.lists.map((l) => l.id),
          clientLists,
          clientTasks,
          sinceHlc: sendFullSnapshot ? null : this.cursorHlc,
          ...(options?.replaceOldestDevice ? { replaceOldestDevice: true } : {}),
          ...(pendingLeaveListIds.length > 0 ? { leaveListIds: pendingLeaveListIds } : {}),
        }),
      });
      if (!response.ok) {
        try {
          const errBody = (await response.json()) as { error?: string };
          this.lastSyncErrorCode = typeof errBody.error === 'string' ? errBody.error : null;
        } catch {
          this.lastSyncErrorCode = null;
        }
        return { synced: false, pulledLists: 0, pulledTasks: 0, revokedLists: 0 };
      }
      const data = (await response.json()) as {
        serverLists?: TaskList[];
        serverTasks: TaskItem[];
        revokedListIds?: string[];
        cursorHlc: HlcTimestamp | null;
        plan?: StoreEntitlementPlan;
      };
      if (this.syncKey !== requestSyncKey) {
        return { synced: false, pulledLists: 0, pulledTasks: 0, revokedLists: 0 };
      }
      this.lastSyncErrorCode = null;
      if (data.plan === 'free' || data.plan === 'pro_yearly' || data.plan === 'pro_lifetime') {
        this.entitlementPlan = data.plan;
      }
      if (pendingLeaveListIds.length > 0) {
        const sentSet = new Set(pendingLeaveListIds);
        this.leftListIds = this.leftListIds.filter((id) => !sentSet.has(id));
      }
      const applied = this.applyServerSync(data);
      let maxPushed = this.lastPushedHlc;
      for (const candidate of sentHlcs) {
        if (!maxPushed || compareHlc(candidate, maxPushed) > 0) {
          maxPushed = candidate;
        }
      }
      if (!maxPushed && data.cursorHlc && sentHlcs.length === 0) {
        maxPushed = '000000000000000:00000:init';
      }
      this.lastPushedHlc = maxPushed;
      return { synced: true, ...applied };
    } catch {
      return { synced: false, pulledLists: 0, pulledTasks: 0, revokedLists: 0 };
    }
  }

  async deleteCloudAndResetLocal(fetchFn: typeof fetch = globalThis.fetch): Promise<boolean> {
    let remoteDeleted = false;
    try {
      const response = await fetchFn(`${this.serverUrl}/api/v1/sync`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.userId,
          syncKey: this.syncKey,
        }),
      });
      remoteDeleted = response.ok;
    } catch {
      remoteDeleted = false;
    }

    this.userId = createId('usr');
    this.syncKey = generateSyncKey();
    this.cursorHlc = null;
    this.lastPushedHlc = null;
    this.entitlementPlan = 'free';
    this.leftListIds = [];
    this.lastSyncErrorCode = null;
    this.tasks = [];
    this.seedDefaults();
    this.persist(true);
    return remoteDeleted;
  }

  async joinSharedListByToken(
    inviteToken: string,
    fetchFn: typeof fetch = globalThis.fetch,
  ): Promise<TaskList> {
    const cleanToken = extractInviteTokenFromInput(inviteToken);
    if (!cleanToken) {
      throw new Error('Invite token must not be empty');
    }

    const response = await fetchFn(
      `${this.serverUrl}/api/v1/invites/${encodeURIComponent(cleanToken)}/join`,
      { method: 'POST' },
    );
    if (!response.ok) {
      throw new Error(`Failed to join shared list (${response.status})`);
    }
    const data = (await response.json()) as { list: TaskList; accessRole?: ListAccessRole };
    const resolvedRole: ListAccessRole =
      data.accessRole ??
      data.list.accessRole ??
      (cleanToken.startsWith('inv-ro-') ? 'viewer' : 'editor');
    const joined: TaskList = {
      ...data.list,
      accessRole: resolvedRole,
      ...(resolvedRole === 'viewer'
        ? { readonlyInviteToken: cleanToken, inviteToken: cleanToken }
        : { inviteToken: cleanToken }),
    };

    this.leftListIds = this.leftListIds.filter((id) => id !== joined.id);
    const index = this.lists.findIndex((l) => l.id === joined.id);
    if (index >= 0) {
      this.lists[index] = mergeListLww(this.lists[index], joined);
    } else {
      this.lists.push(joined);
    }
    this.cursorHlc = null;
    this.lastPushedHlc = null;
    this.persist();

    await this.syncWithServer(fetchFn);
    return joined;
  }
}
