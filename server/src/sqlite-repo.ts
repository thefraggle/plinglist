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
  }

  async applyAndPullDeltas(request: SyncRequest): Promise<SyncResponse> {
    if (this.guard) {
      const allowed = await this.guard(request.userId);
      if (!allowed) {
        throw new EntitlementRequiredError(request.userId);
      }
    }

    const allowedLists = Array.from(new Set(request.listIds.filter((id) => id.trim().length > 0)));
    if (allowedLists.length === 0) {
      return {
        acceptedCount: 0,
        serverLists: [],
        serverTasks: [],
        cursorHlc: request.sinceHlc ?? null,
      };
    }

    const allowedSet = new Set(allowedLists);
    let acceptedCount = 0;

    const selectListStmt = this.db.prepare('SELECT payload_json FROM lists WHERE id = ?');
    const upsertListStmt = this.db.prepare(`
      INSERT INTO lists (id, invite_token, hlc, payload_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
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
        if (!allowedSet.has(incomingList.id)) continue;
        const row = selectListStmt.get(incomingList.id) as { payload_json: string } | undefined;
        const merged = row
          ? mergeListLww(JSON.parse(row.payload_json) as TaskList, incomingList)
          : incomingList;
        upsertListStmt.run(
          merged.id,
          merged.inviteToken,
          merged.hlc,
          JSON.stringify(merged),
        );
        acceptedCount += 1;
      }

      for (const incomingTask of request.clientTasks) {
        if (!allowedSet.has(incomingTask.listId)) continue;
        const row = selectTaskStmt.get(incomingTask.id) as { payload_json: string } | undefined;
        const merged = row
          ? mergeTaskLww(JSON.parse(row.payload_json) as TaskItem, incomingTask)
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

    const placeholders = allowedLists.map(() => '?').join(', ');
    const listRows = this.db
      .prepare(`SELECT payload_json FROM lists WHERE id IN (${placeholders})`)
      .all(...allowedLists) as Array<{ payload_json: string }>;
    const taskRows = this.db
      .prepare(`SELECT payload_json FROM tasks WHERE list_id IN (${placeholders})`)
      .all(...allowedLists) as Array<{ payload_json: string }>;

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
