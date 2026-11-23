import {
  compareHlc,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type TaskItem,
  type TaskList,
} from '../../packages/core/src/index.ts';

export type CloudEntitlementGuard = (userId: string) => Promise<boolean> | boolean;

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
  cursorHlc: HlcTimestamp | null;
}

export interface SyncRepository {
  applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse>;
  resolveInviteToken?(inviteToken: string): Promise<TaskList | null>;
}

export class EntitlementRequiredError extends Error {
  readonly code = 'PRO_ENTITLEMENT_REQUIRED';

  constructor(userId: string) {
    super(`Cloud sync requires an active Plinglist Pro entitlement for user ${userId}`);
    this.name = 'EntitlementRequiredError';
  }
}

/**
 * In-memory sync repository with zero-auth capability-based workspace isolation.
 */
export class InMemorySyncRepository implements SyncRepository {
  private readonly listsById = new Map<string, TaskList>();
  private readonly ownerByListId = new Map<string, string>();
  private readonly tasksById = new Map<string, TaskItem>();
  private readonly guard?: CloudEntitlementGuard;

  constructor(guard?: CloudEntitlementGuard) {
    this.guard = guard;
  }

  private isAuthorizedForList(
    listId: string,
    callerKey: string,
    inviteTokens?: Record<string, string>,
    incomingInviteToken?: string | null,
  ): boolean {
    const existing = this.listsById.get(listId);
    if (!existing) {
      return true;
    }
    const owner = this.ownerByListId.get(listId);
    if (!owner || owner === callerKey) {
      return true;
    }
    if (existing.shared && existing.inviteToken) {
      const provided = inviteTokens?.[listId] ?? incomingInviteToken ?? null;
      return provided === existing.inviteToken;
    }
    return false;
  }

  async applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse> {
    const callerKey = request.syncKey?.trim() || request.userId;
    if (this.guard) {
      const allowed = await this.guard(callerKey);
      if (!allowed) {
        throw new EntitlementRequiredError(callerKey);
      }
    }

    const requestedLists = new Set(request.listIds);
    let acceptedCount = 0;

    for (const incomingList of request.clientLists ?? []) {
      if (!requestedLists.has(incomingList.id)) continue;
      if (
        !this.isAuthorizedForList(
          incomingList.id,
          callerKey,
          request.inviteTokens,
          incomingList.inviteToken,
        )
      ) {
        continue;
      }

      const existing = this.listsById.get(incomingList.id);
      if (!existing) {
        this.ownerByListId.set(incomingList.id, callerKey);
      }
      const merged = existing ? mergeListLww(existing, incomingList) : incomingList;
      this.listsById.set(incomingList.id, merged);
      acceptedCount += 1;
    }

    for (const incoming of request.clientTasks) {
      if (!requestedLists.has(incoming.listId)) continue;
      if (!this.isAuthorizedForList(incoming.listId, callerKey, request.inviteTokens)) {
        continue;
      }
      const existing = this.tasksById.get(incoming.id);
      const merged = existing ? mergeTaskLww(existing, incoming) : incoming;
      this.tasksById.set(incoming.id, merged);
      acceptedCount += 1;
    }

    const pullListIds = new Set<string>();
    for (const listId of requestedLists) {
      if (this.isAuthorizedForList(listId, callerKey, request.inviteTokens)) {
        pullListIds.add(listId);
      }
    }
    for (const [listId, owner] of this.ownerByListId.entries()) {
      if (owner === callerKey) {
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
}
