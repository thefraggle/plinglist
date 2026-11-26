import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  FREE_MAX_DEVICES,
  FREE_MAX_OWNED_SHARED_LISTS,
  PRO_SNAPSHOT_RETENTION_DAYS,
  HlcClock,
  compareHlc,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type ListAccessRole,
  type TaskItem,
  type TaskList,
  type WorkspaceSnapshotMeta,
} from '../../packages/core/src/index.ts';

export type CloudEntitlementGuard = (userId: string) => Promise<boolean> | boolean;

export type EntitlementPlan = 'free' | 'pro_yearly' | 'pro_lifetime';
export type EntitlementSource = 'none' | 'stripe' | 'revenuecat';

export interface EntitlementRecord {
  userId: string;
  plan: EntitlementPlan;
  expiresAtMs: number | null;
  source: EntitlementSource;
}

export function isEntitlementActive(record: EntitlementRecord | null, nowMs = Date.now()): boolean {
  if (!record) return false;
  if (record.plan === 'pro_lifetime') return true;
  if (record.plan === 'pro_yearly') {
    return record.expiresAtMs !== null && record.expiresAtMs > nowMs;
  }
  return false;
}

export interface SyncRequest {
  userId: string;
  syncKey?: string;
  inviteTokens?: Record<string, string>;
  listIds: string[];
  clientLists?: TaskList[];
  clientTasks: TaskItem[];
  sinceHlc?: HlcTimestamp | null;
  replaceOldestDevice?: boolean;
  leaveListIds?: string[];
}

export interface SyncResponse {
  acceptedCount: number;
  serverLists?: TaskList[];
  serverTasks: TaskItem[];
  revokedListIds?: string[];
  cursorHlc: HlcTimestamp | null;
  plan?: EntitlementPlan;
  deviceCount?: number;
  maxDevices?: number | null;
  maxOwnedSharedLists?: number | null;
}

export interface SyncRepository {
  applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse>;
  resolveInviteToken?(inviteToken: string): Promise<TaskList | null>;
  deleteWorkspace?(syncKey: string, userId?: string): Promise<number>;
  upsertEntitlement?(state: EntitlementRecord): void;
  hasActiveEntitlement?(userKey: string, nowMs?: number): boolean;
  getEntitlement?(userKey: string): EntitlementRecord | null;
  listSnapshots?(syncKey: string): Promise<WorkspaceSnapshotMeta[]>;
  restoreSnapshot?(
    syncKey: string,
    snapshotId: string,
    listId?: string,
  ): Promise<{ restoredLists: number; restoredTasks: number; cursorHlc: HlcTimestamp | null }>;
}

export class EntitlementRequiredError extends Error {
  readonly code = 'PRO_ENTITLEMENT_REQUIRED';

  constructor(userId: string) {
    super(`Cloud sync requires an active Plinglist Pro entitlement for user ${userId}`);
    this.name = 'EntitlementRequiredError';
  }
}

export class DeviceLimitReachedError extends Error {
  readonly code = 'DEVICE_LIMIT_REACHED';
  readonly maxDevices = FREE_MAX_DEVICES;

  constructor(userKey: string) {
    super(
      `Free plan supports up to ${FREE_MAX_DEVICES} paired devices for workspace ${userKey}`,
    );
    this.name = 'DeviceLimitReachedError';
  }
}

export class SharedListLimitError extends Error {
  readonly code = 'SHARED_LIST_LIMIT_REACHED';
  readonly maxOwnedSharedLists = FREE_MAX_OWNED_SHARED_LISTS;

  constructor(userKey: string) {
    super(
      `Free plan allows up to ${FREE_MAX_OWNED_SHARED_LISTS} active own shared list for workspace ${userKey}`,
    );
    this.name = 'SharedListLimitError';
  }
}

export function getCallerAccessRole(params: {
  ownerKey: string | null | undefined;
  callerKey: string;
  callerUserId?: string;
  shared: boolean;
  storedInviteToken: string | null;
  storedReadonlyInviteToken?: string | null;
  listId: string;
  inviteTokens?: Record<string, string>;
  incomingInviteToken?: string | null;
}): ListAccessRole | null {
  const {
    ownerKey,
    callerKey,
    callerUserId,
    shared,
    storedInviteToken,
    storedReadonlyInviteToken,
    listId,
    inviteTokens,
    incomingInviteToken,
  } = params;
  if (
    !ownerKey ||
    ownerKey === callerKey ||
    (Boolean(callerUserId) && ownerKey === callerUserId)
  ) {
    return 'owner';
  }
  if (shared) {
    const provided = inviteTokens?.[listId] ?? incomingInviteToken ?? null;
    if (storedInviteToken && provided === storedInviteToken) {
      return 'editor';
    }
    if (storedReadonlyInviteToken && provided === storedReadonlyInviteToken) {
      return 'viewer';
    }
  }
  return null;
}

export function isAuthorizedCaller(params: {
  ownerKey: string | null | undefined;
  callerKey: string;
  callerUserId?: string;
  shared: boolean;
  storedInviteToken: string | null;
  storedReadonlyInviteToken?: string | null;
  listId: string;
  inviteTokens?: Record<string, string>;
  incomingInviteToken?: string | null;
}): boolean {
  return getCallerAccessRole(params) !== null;
}

export function sanitizeListForRole(list: TaskList, role: ListAccessRole): TaskList {
  if (role === 'owner') {
    return {
      ...list,
      readonlyInviteToken: list.readonlyInviteToken ?? null,
      accessRole: 'owner',
    };
  }
  if (role === 'editor') {
    return {
      ...list,
      readonlyInviteToken: null,
      accessRole: 'editor',
    };
  }
  const roToken = list.readonlyInviteToken ?? list.inviteToken;
  return {
    ...list,
    inviteToken: roToken,
    readonlyInviteToken: roToken,
    accessRole: 'viewer',
  };
}

export function buildSnapshotPayloadBuffer(lists: TaskList[], tasks: TaskItem[]): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ lists, tasks }), 'utf8'));
}

export function parseSnapshotPayloadBuffer(payloadGzip: Uint8Array): {
  lists: TaskList[];
  tasks: TaskItem[];
} {
  const json = zlib.gunzipSync(Buffer.from(payloadGzip)).toString('utf8');
  const parsed = JSON.parse(json) as { lists?: TaskList[]; tasks?: TaskItem[] };
  return {
    lists: Array.isArray(parsed.lists) ? parsed.lists : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
  };
}

export function getSnapshotCutoffDay(
  nowMs = Date.now(),
  retentionDays = PRO_SNAPSHOT_RETENTION_DAYS,
): string {
  return new Date(nowMs - retentionDays * 86_400_000).toISOString().slice(0, 10);
}

export function isGuestShareRequest(listId: string, request: SyncRequest): boolean {
  if (request.inviteTokens?.[listId]) {
    return true;
  }
  const clientList = request.clientLists?.find((l) => l.id === listId);
  return Boolean(clientList && (clientList.shared || clientList.inviteToken));
}

export function pickHigherHlc(
  a: HlcTimestamp | null,
  b: HlcTimestamp | null,
): HlcTimestamp | null {
  if (!a) return b;
  if (!b) return a;
  return compareHlc(a, b) >= 0 ? a : b;
}

export function advanceWatermarkIfNeeded(
  hlc: HlcTimestamp,
  maxStoredHlc: HlcTimestamp | null,
  serverClock: HlcClock,
): HlcTimestamp {
  if (maxStoredHlc && compareHlc(hlc, maxStoredHlc) <= 0) {
    return serverClock.receive(maxStoredHlc, 0);
  }
  return hlc;
}

interface InMemoryDeviceRow {
  deviceId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface InMemorySnapshotRow {
  id: string;
  ownerSyncKey: string;
  snapshotDay: string;
  createdAt: string;
  listCount: number;
  taskCount: number;
  payloadGzip: Buffer;
}

/**
 * In-memory sync repository with zero-auth capability-based workspace isolation.
 */
export class InMemorySyncRepository implements SyncRepository {
  private readonly listsById = new Map<string, TaskList>();
  private readonly ownerByListId = new Map<string, string>();
  private readonly tasksById = new Map<string, TaskItem>();
  private readonly entitlementsByUser = new Map<string, EntitlementRecord>();
  private readonly devicesBySyncKey = new Map<string, Map<string, InMemoryDeviceRow>>();
  private readonly membershipsBySyncKey = new Map<string, Map<string, string>>();
  private readonly snapshotsBySyncKey = new Map<string, Map<string, InMemorySnapshotRow>>();
  private readonly serverClock = new HlcClock('server');
  private readonly guard?: CloudEntitlementGuard;

  constructor(guard?: CloudEntitlementGuard) {
    this.guard = guard;
  }

  upsertEntitlement(state: EntitlementRecord): void {
    this.entitlementsByUser.set(state.userId, state);
  }

  getEntitlement(userKey: string): EntitlementRecord | null {
    return this.entitlementsByUser.get(userKey) ?? null;
  }

  hasActiveEntitlement(userKey: string, nowMs = Date.now()): boolean {
    return isEntitlementActive(this.entitlementsByUser.get(userKey) ?? null, nowMs);
  }

  private getEffectivePlan(callerKey: string, nowMs = Date.now()): EntitlementPlan {
    const record = this.getEntitlement(callerKey);
    return isEntitlementActive(record, nowMs) ? record!.plan : 'free';
  }

  private registerDeviceForSyncKey(
    callerKey: string,
    callerUserId: string,
    isPro: boolean,
    replaceOldestDevice: boolean,
    nowIso: string,
  ): number {
    let devices = this.devicesBySyncKey.get(callerKey);
    if (!devices) {
      devices = new Map<string, InMemoryDeviceRow>();
      this.devicesBySyncKey.set(callerKey, devices);
    }
    const existing = devices.get(callerUserId);
    if (existing) {
      existing.lastSeenAt = nowIso;
      return devices.size;
    }
    if (!isPro && devices.size >= FREE_MAX_DEVICES) {
      if (replaceOldestDevice) {
        let oldestId: string | null = null;
        let oldestAt = '';
        for (const [id, row] of devices.entries()) {
          if (!oldestId || row.lastSeenAt < oldestAt) {
            oldestId = id;
            oldestAt = row.lastSeenAt;
          }
        }
        if (oldestId) {
          devices.delete(oldestId);
        }
      } else {
        throw new DeviceLimitReachedError(callerKey);
      }
    }
    devices.set(callerUserId, {
      deviceId: callerUserId,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    return devices.size;
  }

  private getAccessRoleForList(
    listId: string,
    callerKey: string,
    callerUserId: string,
    inviteTokens?: Record<string, string>,
    incomingInviteToken?: string | null,
  ): ListAccessRole | null {
    const existing = this.listsById.get(listId);
    if (!existing) {
      return 'owner';
    }
    return getCallerAccessRole({
      ownerKey: this.ownerByListId.get(listId),
      callerKey,
      callerUserId,
      shared: existing.shared,
      storedInviteToken: existing.inviteToken,
      storedReadonlyInviteToken: existing.readonlyInviteToken ?? null,
      listId,
      inviteTokens,
      incomingInviteToken,
    });
  }

  private countActiveOwnedSharedLists(
    callerKey: string,
    callerUserId: string,
    excludeListId: string,
  ): number {
    let count = 0;
    for (const [id, list] of this.listsById.entries()) {
      if (id === excludeListId) continue;
      if (!list.shared || list.deletedAt !== null) continue;
      const owner = this.ownerByListId.get(id);
      if (owner === callerKey || (Boolean(callerUserId) && owner === callerUserId)) {
        count += 1;
      }
    }
    return count;
  }

  private recordDailySnapshotIfOwnedChanged(callerKey: string, nowMs = Date.now()): void {
    const ownedLists: TaskList[] = [];
    const ownedListIds = new Set<string>();
    for (const [listId, owner] of this.ownerByListId.entries()) {
      if (owner === callerKey) {
        const list = this.listsById.get(listId);
        if (list) {
          ownedLists.push(list);
          ownedListIds.add(listId);
        }
      }
    }
    if (ownedLists.length === 0) return;

    const ownedTasks: TaskItem[] = [];
    for (const task of this.tasksById.values()) {
      if (ownedListIds.has(task.listId)) {
        ownedTasks.push(task);
      }
    }

    const nowIso = new Date(nowMs).toISOString();
    const snapshotDay = nowIso.slice(0, 10);
    const cutoffDay = getSnapshotCutoffDay(nowMs);

    let snapshots = this.snapshotsBySyncKey.get(callerKey);
    if (!snapshots) {
      snapshots = new Map<string, InMemorySnapshotRow>();
      this.snapshotsBySyncKey.set(callerKey, snapshots);
    }

    const existing = snapshots.get(snapshotDay);
    const listCount = ownedLists.filter((l) => l.deletedAt === null).length;
    const taskCount = ownedTasks.filter((t) => t.deletedAt === null).length;
    if (!existing || (listCount >= existing.listCount && taskCount >= existing.taskCount)) {
      snapshots.set(snapshotDay, {
        id: existing?.id ?? `snap-${snapshotDay}-${crypto.randomUUID().slice(0, 8)}`,
        ownerSyncKey: callerKey,
        snapshotDay,
        createdAt: nowIso,
        listCount,
        taskCount,
        payloadGzip: buildSnapshotPayloadBuffer(ownedLists, ownedTasks),
      });
    }

    for (const [day] of snapshots.entries()) {
      if (day < cutoffDay) {
        snapshots.delete(day);
      }
    }
  }

  async applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse> {
    const callerUserId = request.userId.trim();
    const hasSyncKey = Boolean(request.syncKey?.trim());
    const callerKey = request.syncKey?.trim() || callerUserId;
    if (this.guard) {
      const allowed = await this.guard(callerKey);
      if (!allowed) {
        throw new EntitlementRequiredError(callerKey);
      }
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const plan = this.getEffectivePlan(callerKey, nowMs);
    const isPro = plan !== 'free';

    let deviceCount: number | undefined;
    if (hasSyncKey) {
      deviceCount = this.registerDeviceForSyncKey(
        callerKey,
        callerUserId,
        isPro,
        Boolean(request.replaceOldestDevice),
        nowIso,
      );
    }

    if (hasSyncKey && request.leaveListIds?.length) {
      const memberships = this.membershipsBySyncKey.get(callerKey);
      if (memberships) {
        for (const leaveId of request.leaveListIds) {
          memberships.delete(leaveId);
        }
      }
    }

    let preRequestMaxHlc: HlcTimestamp | null = null;
    for (const list of this.listsById.values()) {
      preRequestMaxHlc = pickHigherHlc(preRequestMaxHlc, list.hlc);
    }
    for (const task of this.tasksById.values()) {
      preRequestMaxHlc = pickHigherHlc(preRequestMaxHlc, task.hlc);
    }
    let maxWatermarkHlc = preRequestMaxHlc;

    const requestedLists = new Set(request.listIds);
    let acceptedCount = 0;
    let ownedChanged = false;

    for (const incomingList of request.clientLists ?? []) {
      if (!requestedLists.has(incomingList.id)) continue;
      const role = this.getAccessRoleForList(
        incomingList.id,
        callerKey,
        callerUserId,
        request.inviteTokens,
        incomingList.inviteToken,
      );
      if (!role || role === 'viewer') {
        continue;
      }

      if (role === 'owner' && incomingList.shared && incomingList.deletedAt === null && !isPro) {
        const activeOwnedShared = this.countActiveOwnedSharedLists(
          callerKey,
          callerUserId,
          incomingList.id,
        );
        if (activeOwnedShared >= FREE_MAX_OWNED_SHARED_LISTS) {
          throw new SharedListLimitError(callerKey);
        }
      }

      const existing = this.listsById.get(incomingList.id);
      const existingOwner = this.ownerByListId.get(incomingList.id);
      const isLegacyOwner = Boolean(callerUserId && existingOwner === callerUserId);
      const nextOwner = !existingOwner || isLegacyOwner ? callerKey : existingOwner;
      const ownerUpgraded = existingOwner !== nextOwner;
      this.ownerByListId.set(incomingList.id, nextOwner);

      const cleanIncoming: TaskList = { ...incomingList };
      delete cleanIncoming.accessRole;
      const merged = existing ? mergeListLww(existing, cleanIncoming) : cleanIncoming;
      const changed = !existing || ownerUpgraded || JSON.stringify(merged) !== JSON.stringify(existing);
      if (changed && preRequestMaxHlc && compareHlc(merged.hlc, preRequestMaxHlc) <= 0) {
        merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxWatermarkHlc, this.serverClock);
      }
      if (changed && nextOwner === callerKey) {
        ownedChanged = true;
      }
      maxWatermarkHlc = pickHigherHlc(maxWatermarkHlc, merged.hlc);
      this.listsById.set(incomingList.id, merged);
      acceptedCount += 1;
    }

    for (const incoming of request.clientTasks) {
      if (!requestedLists.has(incoming.listId)) continue;
      const role = this.getAccessRoleForList(
        incoming.listId,
        callerKey,
        callerUserId,
        request.inviteTokens,
      );
      if (!role || role === 'viewer') {
        continue;
      }
      const existing = this.tasksById.get(incoming.id);
      if (existing && existing.listId !== incoming.listId) {
        const existingRole = this.listsById.has(existing.listId)
          ? this.getAccessRoleForList(
              existing.listId,
              callerKey,
              callerUserId,
              request.inviteTokens,
            )
          : null;
        if (!existingRole || existingRole === 'viewer') {
          continue;
        }
      }
      const merged = existing ? mergeTaskLww(existing, incoming) : { ...incoming };
      const changed = !existing || JSON.stringify(merged) !== JSON.stringify(existing);
      if (changed && preRequestMaxHlc && compareHlc(merged.hlc, preRequestMaxHlc) <= 0) {
        merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxWatermarkHlc, this.serverClock);
      }
      if (changed) {
        const listOwner = this.ownerByListId.get(incoming.listId);
        if (listOwner === callerKey) {
          ownedChanged = true;
        }
      }
      maxWatermarkHlc = pickHigherHlc(maxWatermarkHlc, merged.hlc);
      this.tasksById.set(incoming.id, merged);
      acceptedCount += 1;
    }

    if (ownedChanged) {
      this.recordDailySnapshotIfOwnedChanged(callerKey, nowMs);
    }

    const pullRoleByListId = new Map<string, ListAccessRole>();
    const revokedListIds: string[] = [];
    let memberships = hasSyncKey ? this.membershipsBySyncKey.get(callerKey) : undefined;
    for (const listId of requestedLists) {
      const role = this.getAccessRoleForList(
        listId,
        callerKey,
        callerUserId,
        request.inviteTokens,
      );
      if (role) {
        pullRoleByListId.set(listId, role);
        if (hasSyncKey && (role === 'editor' || role === 'viewer')) {
          const token = request.inviteTokens?.[listId];
          if (token) {
            if (!memberships) {
              memberships = new Map<string, string>();
              this.membershipsBySyncKey.set(callerKey, memberships);
            }
            memberships.set(listId, token);
          }
        }
      } else if (this.listsById.has(listId) && isGuestShareRequest(listId, request)) {
        revokedListIds.push(listId);
        memberships?.delete(listId);
      }
    }

    if (hasSyncKey && memberships) {
      for (const [memberListId, memberToken] of Array.from(memberships.entries())) {
        const list = this.listsById.get(memberListId);
        if (!list || !list.shared || list.deletedAt !== null) {
          memberships.delete(memberListId);
          continue;
        }
        const role = getCallerAccessRole({
          ownerKey: this.ownerByListId.get(memberListId),
          callerKey,
          callerUserId,
          shared: list.shared,
          storedInviteToken: list.inviteToken,
          storedReadonlyInviteToken: list.readonlyInviteToken ?? null,
          listId: memberListId,
          inviteTokens: { [memberListId]: memberToken },
        });
        if (role) {
          pullRoleByListId.set(memberListId, role);
        } else {
          memberships.delete(memberListId);
        }
      }
    }

    for (const [listId, owner] of this.ownerByListId.entries()) {
      if (owner === callerKey || (Boolean(callerUserId) && owner === callerUserId)) {
        pullRoleByListId.set(listId, 'owner');
      }
    }

    const serverLists: TaskList[] = [];
    const serverTasks: TaskItem[] = [];
    let maxHlc: HlcTimestamp | null = request.sinceHlc ?? null;

    for (const list of this.listsById.values()) {
      const role = pullRoleByListId.get(list.id);
      if (!role) continue;
      if (!request.sinceHlc || compareHlc(list.hlc, request.sinceHlc) > 0) {
        serverLists.push(sanitizeListForRole(list, role));
      }
      if (!maxHlc || compareHlc(list.hlc, maxHlc) > 0) {
        maxHlc = list.hlc;
      }
    }

    for (const task of this.tasksById.values()) {
      if (!pullRoleByListId.has(task.listId)) continue;
      if (!request.sinceHlc || compareHlc(task.hlc, request.sinceHlc) > 0) {
        serverTasks.push(task);
      }
      if (!maxHlc || compareHlc(task.hlc, maxHlc) > 0) {
        maxHlc = task.hlc;
      }
    }

    serverLists.sort((a, b) => compareHlc(a.hlc, b.hlc));
    serverTasks.sort((a, b) => compareHlc(a.hlc, b.hlc));

    return {
      acceptedCount,
      serverLists,
      serverTasks,
      revokedListIds,
      cursorHlc: maxHlc,
      plan,
      ...(deviceCount !== undefined ? { deviceCount } : {}),
      maxDevices: isPro ? null : FREE_MAX_DEVICES,
      maxOwnedSharedLists: isPro ? null : FREE_MAX_OWNED_SHARED_LISTS,
    };
  }

  async resolveInviteToken(inviteToken: string): Promise<TaskList | null> {
    const clean = inviteToken.trim();
    if (!clean) return null;
    for (const list of this.listsById.values()) {
      if (!list.shared || list.deletedAt !== null) continue;
      if (list.inviteToken === clean) {
        return sanitizeListForRole(list, 'editor');
      }
      if (list.readonlyInviteToken && list.readonlyInviteToken === clean) {
        return sanitizeListForRole(list, 'viewer');
      }
    }
    return null;
  }

  async listSnapshots(syncKey: string): Promise<WorkspaceSnapshotMeta[]> {
    const cleanKey = syncKey.trim();
    if (!cleanKey) return [];
    const snapshots = this.snapshotsBySyncKey.get(cleanKey);
    if (!snapshots) return [];
    return Array.from(snapshots.values())
      .map((s) => ({
        id: s.id,
        snapshotDay: s.snapshotDay,
        createdAt: s.createdAt,
        listCount: s.listCount,
        taskCount: s.taskCount,
      }))
      .sort((a, b) => b.snapshotDay.localeCompare(a.snapshotDay));
  }

  async restoreSnapshot(
    syncKey: string,
    snapshotId: string,
    listId?: string,
  ): Promise<{ restoredLists: number; restoredTasks: number; cursorHlc: HlcTimestamp | null }> {
    const cleanKey = syncKey.trim();
    const snapshots = this.snapshotsBySyncKey.get(cleanKey);
    const snap = snapshots
      ? Array.from(snapshots.values()).find((item) => item.id === snapshotId)
      : undefined;
    if (!snap) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const { lists, tasks } = parseSnapshotPayloadBuffer(snap.payloadGzip);
    const targetLists = listId ? lists.filter((l) => l.id === listId) : lists;
    const targetListIds = new Set(targetLists.map((l) => l.id));
    const targetTasks = listId
      ? tasks.filter((t) => t.listId === listId)
      : tasks.filter((t) => targetListIds.has(t.listId));

    const nowIso = new Date().toISOString();
    let maxHlc: HlcTimestamp | null = null;
    for (const list of targetLists) {
      const hlc = this.serverClock.now();
      this.listsById.set(list.id, {
        ...list,
        deletedAt: null,
        updatedAt: nowIso,
        hlc,
      });
      this.ownerByListId.set(list.id, cleanKey);
      maxHlc = pickHigherHlc(maxHlc, hlc);
    }
    for (const task of targetTasks) {
      const hlc = this.serverClock.now();
      this.tasksById.set(task.id, {
        ...task,
        deletedAt: null,
        updatedAt: nowIso,
        hlc,
        fieldHlcs: {
          ...task.fieldHlcs,
          title: hlc,
          note: hlc,
          steps: hlc,
          dueDate: hlc,
          reminderAt: hlc,
          myDayDate: hlc,
          starred: hlc,
          deletedAt: hlc,
        },
      });
      maxHlc = pickHigherHlc(maxHlc, hlc);
    }
    return {
      restoredLists: targetLists.length,
      restoredTasks: targetTasks.length,
      cursorHlc: maxHlc,
    };
  }

  async deleteWorkspace(syncKey: string, userId?: string): Promise<number> {
    const cleanKey = syncKey.trim();
    const cleanUserId = userId?.trim() || '';
    if (!cleanKey && !cleanUserId) return 0;

    const ownedListIds = new Set<string>();
    for (const [listId, owner] of this.ownerByListId.entries()) {
      if ((cleanKey && owner === cleanKey) || (cleanUserId && owner === cleanUserId)) {
        ownedListIds.add(listId);
      }
    }

    for (const listId of ownedListIds) {
      this.listsById.delete(listId);
      this.ownerByListId.delete(listId);
    }
    for (const [taskId, task] of this.tasksById.entries()) {
      if (ownedListIds.has(task.listId)) {
        this.tasksById.delete(taskId);
      }
    }
    if (cleanKey) {
      this.entitlementsByUser.delete(cleanKey);
      this.devicesBySyncKey.delete(cleanKey);
      this.membershipsBySyncKey.delete(cleanKey);
      this.snapshotsBySyncKey.delete(cleanKey);
    }
    return ownedListIds.size;
  }
}
