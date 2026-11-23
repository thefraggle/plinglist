import {
  compareHlc,
  mergeTaskLww,
  type HlcTimestamp,
  type TaskItem,
} from '../../packages/core/src/index.ts';

export type CloudEntitlementGuard = (userId: string) => Promise<boolean> | boolean;

export interface SyncRequest {
  userId: string;
  listIds: string[];
  clientTasks: TaskItem[];
  sinceHlc?: HlcTimestamp | null;
}

export interface SyncResponse {
  acceptedCount: number;
  serverTasks: TaskItem[];
  cursorHlc: HlcTimestamp | null;
}

export interface SyncRepository {
  applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse>;
}

export class EntitlementRequiredError extends Error {
  readonly code = 'PRO_ENTITLEMENT_REQUIRED';

  constructor(userId: string) {
    super(`Cloud sync requires an active Plinglist Pro entitlement for user ${userId}`);
    this.name = 'EntitlementRequiredError';
  }
}

/**
 * Self-hosted sync engine core.
 * In self-hosted mode (no guard), all authenticated users can sync freely.
 * In managed cloud mode (`./cloud`), a CloudEntitlementGuard checks Pro/Lifetime status.
 */
export class InMemorySyncRepository implements SyncRepository {
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

    for (const incoming of request.clientTasks) {
      if (!allowedLists.has(incoming.listId)) {
        continue;
      }
      const existing = this.tasksById.get(incoming.id);
      const merged = existing ? mergeTaskLww(existing, incoming) : incoming;
      this.tasksById.set(incoming.id, merged);
      acceptedCount += 1;
    }

    const serverTasks: TaskItem[] = [];
    let maxHlc: HlcTimestamp | null = request.sinceHlc ?? null;

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

    serverTasks.sort((a, b) => compareHlc(a.hlc, b.hlc));

    return {
      acceptedCount,
      serverTasks,
      cursorHlc: maxHlc,
    };
  }
}
