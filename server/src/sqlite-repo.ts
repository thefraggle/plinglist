import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  compareHlc,
  mergeListLww,
  mergeTaskLww,
  type HlcTimestamp,
  type TaskItem,
  type TaskList,
} from '../../packages/core/src/index.ts';
import {
  EntitlementRequiredError,
  type CloudEntitlementGuard,
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
    listId: string,
    inviteTokens?: Record<string, string>,
    incomingInviteToken?: string | null,
  ): boolean {
    if (!row) {
      return true;
    }
    if (!row.owner_sync_key || row.owner_sync_key === callerKey) {
      return true;
    }
    const existing = JSON.parse(row.payload_json) as TaskList;
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
        owner_sync_key = COALESCE(lists.owner_sync_key, excluded.owner_sync_key),
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
      for (const incomingList of request.clientLists ?? []) {
        if (!requestedSet.has(incomingList.id)) continue;
        const row = selectListStmt.get(incomingList.id) as StoredListRow | undefined;
        if (
          !this.isListRowAuthorized(
            row,
            callerKey,
            incomingList.id,
            request.inviteTokens,
            incomingList.inviteToken,
          )
        ) {
          continue;
        }
        const merged = row
          ? mergeListLww(JSON.parse(row.payload_json) as TaskList, incomingList)
          : incomingList;
        const ownerKey = row?.owner_sync_key ?? callerKey;
        upsertListStmt.run(
          merged.id,
          ownerKey,
          merged.inviteToken,
          merged.hlc,
          JSON.stringify(merged),
        );
        acceptedCount += 1;
      }

      for (const incomingTask of request.clientTasks) {
        if (!requestedSet.has(incomingTask.listId)) continue;
        const listRow = selectListStmt.get(incomingTask.listId) as StoredListRow | undefined;
        if (
          !this.isListRowAuthorized(listRow, callerKey, incomingTask.listId, request.inviteTokens)
        ) {
          continue;
        }

        const taskRow = selectTaskStmt.get(incomingTask.id) as { payload_json: string } | undefined;
        const merged = taskRow
          ? mergeTaskLww(JSON.parse(taskRow.payload_json) as TaskItem, incomingTask)
          : incomingTask;
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
      if (this.isListRowAuthorized(row, callerKey, listId, request.inviteTokens)) {
        authorizedListIds.add(listId);
      }
    }

    const ownedRows = this.db
      .prepare('SELECT id FROM lists WHERE owner_sync_key = ?')
      .all(callerKey) as Array<{ id: string }>;
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

  close(): void {
    this.db.close();
  }
}
