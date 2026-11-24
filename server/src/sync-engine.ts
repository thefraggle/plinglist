import {
  HlcClock,
  compareHlc,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type TaskItem,
  type TaskList,
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
}

export interface SyncResponse {
  acceptedCount: number;
  serverLists?: TaskList[];
  serverTasks: TaskItem[];
  revokedListIds?: string[];
  cursorHlc: HlcTimestamp | null;
}

export interface SyncRepository {
  applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse>;
  resolveInviteToken?(inviteToken: string): Promise<TaskList | null>;
  deleteWorkspace?(syncKey: string, userId?: string): Promise<number>;
  upsertEntitlement?(state: EntitlementRecord): void;
  hasActiveEntitlement?(userKey: string, nowMs?: number): boolean;
}

export class EntitlementRequiredError extends Error {
  readonly code = 'PRO_ENTITLEMENT_REQUIRED';

  constructor(userId: string) {
    super(`Cloud sync requires an active Plinglist Pro entitlement for user ${userId}`);
    this.name = 'EntitlementRequiredError';
  }
}

export function isAuthorizedCaller(params: {
  ownerKey: string | null | undefined;
  callerKey: string;
  callerUserId?: string;
  shared: boolean;
  storedInviteToken: string | null;
  listId: string;
  inviteTokens?: Record<string, string>;
  incomingInviteToken?: string | null;
}): boolean {
  const {
    ownerKey,
    callerKey,
    callerUserId,
    shared,
    storedInviteToken,
    listId,
    inviteTokens,
    incomingInviteToken,
  } = params;
  if (
    !ownerKey ||
    ownerKey === callerKey ||
    (Boolean(callerUserId) && ownerKey === callerUserId)
  ) {
    return true;
  }
  if (shared && storedInviteToken) {
    const provided = inviteTokens?.[listId] ?? incomingInviteToken ?? null;
    return provided === storedInviteToken;
  }
  return false;
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

/**
 * In-memory sync repository with zero-auth capability-based workspace isolation.
 */
export class InMemorySyncRepository implements SyncRepository {
  private readonly listsById = new Map<string, TaskList>();
  private readonly ownerByListId = new Map<string, string>();
  private readonly tasksById = new Map<string, TaskItem>();
  private readonly entitlementsByUser = new Map<string, EntitlementRecord>();
  private readonly serverClock = new HlcClock('server');
  private readonly guard?: CloudEntitlementGuard;

  constructor(guard?: CloudEntitlementGuard) {
    this.guard = guard;
  }

  upsertEntitlement(state: EntitlementRecord): void {
    this.entitlementsByUser.set(state.userId, state);
  }

  hasActiveEntitlement(userKey: string, nowMs = Date.now()): boolean {
    return isEntitlementActive(this.entitlementsByUser.get(userKey) ?? null, nowMs);
  }

  private isAuthorizedForList(
    listId: string,
    callerKey: string,
    callerUserId: string,
    inviteTokens?: Record<string, string>,
    incomingInviteToken?: string | null,
  ): boolean {
    const existing = this.listsById.get(listId);
    if (!existing) {
      return true;
    }
    return isAuthorizedCaller({
      ownerKey: this.ownerByListId.get(listId),
      callerKey,
      callerUserId,
      shared: existing.shared,
      storedInviteToken: existing.inviteToken,
      listId,
      inviteTokens,
      incomingInviteToken,
    });
  }

  async applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse> {
    const callerUserId = request.userId.trim();
    const callerKey = request.syncKey?.trim() || callerUserId;
    if (this.guard) {
      const allowed = await this.guard(callerKey);
      if (!allowed) {
        throw new EntitlementRequiredError(callerKey);
      }
    }

    let maxStoredHlc: HlcTimestamp | null = null;
    for (const list of this.listsById.values()) {
      maxStoredHlc = pickHigherHlc(maxStoredHlc, list.hlc);
    }
    for (const task of this.tasksById.values()) {
      maxStoredHlc = pickHigherHlc(maxStoredHlc, task.hlc);
    }

    const requestedLists = new Set(request.listIds);
    let acceptedCount = 0;

    for (const incomingList of request.clientLists ?? []) {
      if (!requestedLists.has(incomingList.id)) continue;
      if (
        !this.isAuthorizedForList(
          incomingList.id,
          callerKey,
          callerUserId,
          request.inviteTokens,
          incomingList.inviteToken,
        )
      ) {
        continue;
      }

      const existing = this.listsById.get(incomingList.id);
      const existingOwner = this.ownerByListId.get(incomingList.id);
      const isLegacyOwner = Boolean(callerUserId && existingOwner === callerUserId);
      const nextOwner = !existingOwner || isLegacyOwner ? callerKey : existingOwner;
      const ownerUpgraded = existingOwner !== nextOwner;
      this.ownerByListId.set(incomingList.id, nextOwner);

      const merged = existing ? mergeListLww(existing, incomingList) : { ...incomingList };
      const changed = !existing || ownerUpgraded || JSON.stringify(merged) !== JSON.stringify(existing);
      if (changed) {
        merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxStoredHlc, this.serverClock);
      }
      maxStoredHlc = pickHigherHlc(maxStoredHlc, merged.hlc);
      this.listsById.set(incomingList.id, merged);
      acceptedCount += 1;
    }

    for (const incoming of request.clientTasks) {
      if (!requestedLists.has(incoming.listId)) continue;
      if (!this.isAuthorizedForList(incoming.listId, callerKey, callerUserId, request.inviteTokens)) {
        continue;
      }
      const existing = this.tasksById.get(incoming.id);
      if (existing && existing.listId !== incoming.listId) {
        if (
          !this.listsById.has(existing.listId) ||
          !this.isAuthorizedForList(
            existing.listId,
            callerKey,
            callerUserId,
            request.inviteTokens,
          )
        ) {
          continue;
        }
      }
      const merged = existing ? mergeTaskLww(existing, incoming) : { ...incoming };
      const changed = !existing || JSON.stringify(merged) !== JSON.stringify(existing);
      if (changed) {
        merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxStoredHlc, this.serverClock);
      }
      maxStoredHlc = pickHigherHlc(maxStoredHlc, merged.hlc);
      this.tasksById.set(incoming.id, merged);
      acceptedCount += 1;
    }

    const pullListIds = new Set<string>();
    const revokedListIds: string[] = [];
    for (const listId of requestedLists) {
      if (this.isAuthorizedForList(listId, callerKey, callerUserId, request.inviteTokens)) {
        pullListIds.add(listId);
      } else if (this.listsById.has(listId) && isGuestShareRequest(listId, request)) {
        revokedListIds.push(listId);
      }
    }
    for (const [listId, owner] of this.ownerByListId.entries()) {
      if (owner === callerKey || (Boolean(callerUserId) && owner === callerUserId)) {
        pullListIds.add(listId);
      }
    }

    const serverLists: TaskList[] = [];
    const serverTasks: TaskItem[] = [];
    let maxHlc: HlcTimestamp | null = request.sinceHlc ?? null;

    for (const list of this.listsById.values()) {
      if (!pullListIds.has(list.id)) continue;
      if (!request.sinceHlc || compareHlc(list.hlc, request.sinceHlc) > 0) {
        serverLists.push(list);
      }
      if (!maxHlc || compareHlc(list.hlc, maxHlc) > 0) {
        maxHlc = list.hlc;
      }
    }

    for (const task of this.tasksById.values()) {
      if (!pullListIds.has(task.listId)) continue;
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
    };
  }

  async resolveInviteToken(inviteToken: string): Promise<TaskList | null> {
    if (!inviteToken.trim()) return null;
    for (const list of this.listsById.values()) {
      if (list.shared && list.deletedAt === null && list.inviteToken === inviteToken) {
        return list;
      }
    }
    return null;
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
    }
    return ownedListIds.size;
  }
}
