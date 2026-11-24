import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HlcClock,
  compareHlc,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type TaskItem,
  type TaskList,
} from '../../packages/core/src/index.ts';
import {
  EntitlementRequiredError,
  advanceWatermarkIfNeeded,
  isAuthorizedCaller,
  isEntitlementActive,
  pickHigherHlc,
  type CloudEntitlementGuard,
  type EntitlementPlan,
  type EntitlementRecord,
  type EntitlementSource,
  type SyncRepository,
  type SyncRequest,
  type SyncResponse,
} from './sync-engine.ts';

interface StoredListRow {
  id: string;
  owner_sync_key: string | null;
  invite_token: string | null;
  payload_json: string;
}

export class SqliteSyncRepository implements SyncRepository {
  private readonly db: DatabaseSync;
  private readonly serverClock = new HlcClock('server');
  private readonly guard?: CloudEntitlementGuard;

  constructor(sqlitePath: string, guard?: CloudEntitlementGuard) {
    this.guard = guard;
    if (sqlitePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        owner_sync_key TEXT,
        invite_token TEXT,
        hlc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lists_invite ON lists(invite_token);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        hlc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_list_hlc ON tasks(list_id, hlc);

      CREATE TABLE IF NOT EXISTS entitlements (
        user_key TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        expires_at_ms INTEGER,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      this.db.exec('ALTER TABLE lists ADD COLUMN owner_sync_key TEXT');
    } catch {
      // Column already exists on newly created or previously migrated databases.
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_sync_key)');
  }

  private isListRowAuthorized(
    row: StoredListRow | undefined,
    callerKey: string,
    callerUserId: string,
    listId: string,
    inviteTokens?: Record<string, string>,
    incomingInviteToken?: string | null,
  ): boolean {
    if (!row) {
      return true;
    }
    const existing = JSON.parse(row.payload_json) as TaskList;
    return isAuthorizedCaller({
      ownerKey: row.owner_sync_key,
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

    const requestedListIds = Array.from(
      new Set(request.listIds.filter((id) => id.trim().length > 0)),
    );
    const requestedSet = new Set(requestedListIds);
    let acceptedCount = 0;

    const selectListStmt = this.db.prepare(
      'SELECT id, owner_sync_key, invite_token, payload_json FROM lists WHERE id = ?',
    );
    const upsertListStmt = this.db.prepare(`
      INSERT INTO lists (id, owner_sync_key, invite_token, hlc, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_sync_key = CASE
          WHEN lists.owner_sync_key IS NULL OR lists.owner_sync_key = ? THEN excluded.owner_sync_key
          ELSE lists.owner_sync_key
        END,
        invite_token = excluded.invite_token,
        hlc = excluded.hlc,
        payload_json = excluded.payload_json
    `);

    const selectTaskStmt = this.db.prepare('SELECT payload_json FROM tasks WHERE id = ?');
    const upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (id, list_id, hlc, payload_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        list_id = excluded.list_id,
        hlc = excluded.hlc,
        payload_json = excluded.payload_json
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const maxListHlcRow = this.db.prepare('SELECT MAX(hlc) AS max_hlc FROM lists').get() as
        | { max_hlc: string | null }
        | undefined;
      const maxTaskHlcRow = this.db.prepare('SELECT MAX(hlc) AS max_hlc FROM tasks').get() as
        | { max_hlc: string | null }
        | undefined;
      let maxStoredHlc = pickHigherHlc(
        maxListHlcRow?.max_hlc ?? null,
        maxTaskHlcRow?.max_hlc ?? null,
      );

      for (const incomingList of request.clientLists ?? []) {
        if (!requestedSet.has(incomingList.id)) continue;
        const row = selectListStmt.get(incomingList.id) as StoredListRow | undefined;
        if (
          !this.isListRowAuthorized(
            row,
            callerKey,
            callerUserId,
            incomingList.id,
            request.inviteTokens,
            incomingList.inviteToken,
          )
        ) {
          continue;
        }
        const existingList = row ? (JSON.parse(row.payload_json) as TaskList) : null;
        const merged = existingList ? mergeListLww(existingList, incomingList) : { ...incomingList };
        const isLegacyOwner = Boolean(callerUserId && row?.owner_sync_key === callerUserId);
        const ownerKey =
          !row?.owner_sync_key || isLegacyOwner ? callerKey : row.owner_sync_key;
        const ownerUpgraded = Boolean(row && row.owner_sync_key !== ownerKey);
        const mergedJsonBeforeWatermark = JSON.stringify(merged);
        const changed =
          !row || ownerUpgraded || mergedJsonBeforeWatermark !== row.payload_json;
        if (changed) {
          merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxStoredHlc, this.serverClock);
        }
        maxStoredHlc = pickHigherHlc(maxStoredHlc, merged.hlc);

        upsertListStmt.run(
          merged.id,
          ownerKey,
          merged.inviteToken,
          merged.hlc,
          JSON.stringify(merged),
          callerUserId,
        );
        acceptedCount += 1;
      }

      for (const incomingTask of request.clientTasks) {
        if (!requestedSet.has(incomingTask.listId)) continue;
        const listRow = selectListStmt.get(incomingTask.listId) as StoredListRow | undefined;
        if (
          !this.isListRowAuthorized(
            listRow,
            callerKey,
            callerUserId,
            incomingTask.listId,
            request.inviteTokens,
          )
        ) {
          continue;
        }

        const taskRow = selectTaskStmt.get(incomingTask.id) as { payload_json: string } | undefined;
        const existingTask = taskRow ? (JSON.parse(taskRow.payload_json) as TaskItem) : null;
        const merged = existingTask ? mergeTaskLww(existingTask, incomingTask) : { ...incomingTask };
        const mergedJsonBeforeWatermark = JSON.stringify(merged);
        const changed = !taskRow || mergedJsonBeforeWatermark !== taskRow.payload_json;
        if (changed) {
          merged.hlc = advanceWatermarkIfNeeded(merged.hlc, maxStoredHlc, this.serverClock);
        }
        maxStoredHlc = pickHigherHlc(maxStoredHlc, merged.hlc);

        upsertTaskStmt.run(
          merged.id,
          merged.listId,
          merged.hlc,
          JSON.stringify(merged),
        );
        acceptedCount += 1;
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const authorizedListIds = new Set<string>();
    for (const listId of requestedListIds) {
      const row = selectListStmt.get(listId) as StoredListRow | undefined;
      if (this.isListRowAuthorized(row, callerKey, callerUserId, listId, request.inviteTokens)) {
        authorizedListIds.add(listId);
      }
    }

    const ownedRows = this.db
      .prepare('SELECT id FROM lists WHERE owner_sync_key = ? OR owner_sync_key = ?')
      .all(callerKey, callerUserId) as Array<{ id: string }>;
    for (const owned of ownedRows) {
      authorizedListIds.add(owned.id);
    }

    const pullIds = Array.from(authorizedListIds);
    if (pullIds.length === 0) {
      return {
        acceptedCount,
        serverLists: [],
        serverTasks: [],
        cursorHlc: request.sinceHlc ?? null,
      };
    }

    const placeholders = pullIds.map(() => '?').join(', ');
    const listRows = this.db
      .prepare(`SELECT payload_json FROM lists WHERE id IN (${placeholders})`)
      .all(...pullIds) as Array<{ payload_json: string }>;
    const taskRows = this.db
      .prepare(`SELECT payload_json FROM tasks WHERE list_id IN (${placeholders})`)
      .all(...pullIds) as Array<{ payload_json: string }>;

    const serverLists: TaskList[] = [];
    const serverTasks: TaskItem[] = [];
    let maxHlc: HlcTimestamp | null = request.sinceHlc ?? null;

    for (const row of listRows) {
      const list = JSON.parse(row.payload_json) as TaskList;
      if (!request.sinceHlc || compareHlc(list.hlc, request.sinceHlc) > 0) {
        serverLists.push(list);
      }
      if (!maxHlc || compareHlc(list.hlc, maxHlc) > 0) {
        maxHlc = list.hlc;
      }
    }

    for (const row of taskRows) {
      const task = JSON.parse(row.payload_json) as TaskItem;
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
    const row = this.db
      .prepare('SELECT payload_json FROM lists WHERE invite_token = ? LIMIT 1')
      .get(inviteToken) as { payload_json: string } | undefined;
    if (!row) return null;
    const list = JSON.parse(row.payload_json) as TaskList;
    if (!list.shared || list.deletedAt !== null) {
      return null;
    }
    return list;
  }

  upsertEntitlement(state: EntitlementRecord): void {
    const cleanKey = state.userId.trim();
    if (!cleanKey) {
      throw new Error('Entitlement userId must not be empty');
    }
    this.db
      .prepare(
        `
        INSERT INTO entitlements (user_key, plan, expires_at_ms, source, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_key) DO UPDATE SET
          plan = excluded.plan,
          expires_at_ms = excluded.expires_at_ms,
          source = excluded.source,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        cleanKey,
        state.plan,
        state.expiresAtMs ?? null,
        state.source,
        new Date().toISOString(),
      );
  }

  getEntitlement(userKey: string): EntitlementRecord | null {
    const cleanKey = userKey.trim();
    if (!cleanKey) return null;
    const row = this.db
      .prepare('SELECT user_key, plan, expires_at_ms, source FROM entitlements WHERE user_key = ?')
      .get(cleanKey) as
      | {
          user_key: string;
          plan: EntitlementPlan;
          expires_at_ms: number | null;
          source: EntitlementSource;
        }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_key,
      plan: row.plan,
      expiresAtMs: row.expires_at_ms,
      source: row.source,
    };
  }

  hasActiveEntitlement(userKey: string, nowMs = Date.now()): boolean {
    return isEntitlementActive(this.getEntitlement(userKey), nowMs);
  }

  close(): void {
    this.db.close();
  }
}
