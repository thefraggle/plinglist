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
 * In-memory sync repository (primarily for unit tests).
 * In self-hosted mode (no guard), all authenticated users can sync freely.
 * In managed cloud mode (`./cloud`), a CloudEntitlementGuard checks Pro/Lifetime status.
 */
export class InMemorySyncRepository implements SyncRepository {
  private readonly listsById = new Map<string, TaskList>();
  private readonly tasksById = new Map<string, TaskItem>();
  private readonly guard?: CloudEntitlementGuard;

  constructor(guard?: CloudEntitlementGuard) {
    this.guard = guard;
  }

  async applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse> {
    if (this.guard) {
      const allowed = await this.guard(request.userId);
      if (!allowed) {
        throw new EntitlementRequiredError(request.userId);
      }
    }

    const allowedLists = new Set(request.listIds);
    let acceptedCount = 0;

    for (const incomingList of request.clientLists ?? []) {
      if (!allowedLists.has(incomingList.id)) {
        continue;
      }
      const existing = this.listsById.get(incomingList.id);
      const merged = existing ? mergeListLww(existing, incomingList) : incomingList;
      this.listsById.set(incomingList.id, merged);
      acceptedCount += 1;
    }

    for (const incoming of request.clientTasks) {
      if (!allowedLists.has(incoming.listId)) {
        continue;
      }
      const existing = this.tasksById.get(incoming.id);
      const merged = existing ? mergeTaskLww(existing, incoming) : incoming;
      this.tasksById.set(incoming.id, merged);
      acceptedCount += 1;
    }

    const serverLists: TaskList[] = [];
    const serverTasks: TaskItem[] = [];
    let maxHlc: HlcTimestamp | null = request.sinceHlc ?? null;

    for (const list of this.listsById.values()) {
      if (!allowedLists.has(list.id)) {
        continue;
      }
      if (!request.sinceHlc || compareHlc(list.hlc, request.sinceHlc) > 0) {
        serverLists.push(list);
      }
      if (!maxHlc || compareHlc(list.hlc, maxHlc) > 0) {
        maxHlc = list.hlc;
      }
    }

    for (const task of this.tasksById.values()) {
      if (!allowedLists.has(task.listId)) {
        continue;
      }
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
