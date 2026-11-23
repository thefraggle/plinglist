import type {
  FieldHlcMap,
  HlcTimestamp,
  MergeableTaskField,
  TaskItem,
  TaskList,
} from './types.ts';

export interface ParsedHlc {
  wallMs: number;
  counter: number;
  nodeId: string;
}

const MERGEABLE_FIELDS: readonly MergeableTaskField[] = [
  'listId',
  'title',
  'completed',
  'completedAt',
  'starred',
  'myDayDate',
  'dueDate',
  'reminderAt',
  'recurrence',
  'note',
  'steps',
  'deletedAt',
];

export function formatHlc(wallMs: number, counter: number, nodeId: string): HlcTimestamp {
  const paddedWall = Math.max(0, Math.floor(wallMs)).toString().padStart(15, '0');
  const paddedCounter = Math.max(0, Math.floor(counter)).toString().padStart(5, '0');
  return `${paddedWall}:${paddedCounter}:${nodeId}`;
}

export function parseHlc(hlc: HlcTimestamp): ParsedHlc {
  const parts = hlc.split(':');
  if (parts.length < 3) {
    throw new Error(`Invalid HLC timestamp: ${hlc}`);
  }
  const wallMs = Number(parts[0]);
  const counter = Number(parts[1]);
  const nodeId = parts.slice(2).join(':');
  if (!Number.isFinite(wallMs) || !Number.isFinite(counter) || !nodeId) {
    throw new Error(`Invalid HLC timestamp: ${hlc}`);
  }
  return { wallMs, counter, nodeId };
}

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (pa.wallMs !== pb.wallMs) return pa.wallMs < pb.wallMs ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  if (pa.nodeId !== pb.nodeId) return pa.nodeId < pb.nodeId ? -1 : 1;
  return 0;
}

/**
 * Monotonic Hybrid Logical Clock for deterministic offline-first ordering.
 */
export class HlcClock {
  private wallMs = 0;
  private counter = 0;
  private readonly nodeId: string;

  constructor(nodeId: string, initialWallMs = 0) {
    if (!nodeId.trim()) {
      throw new Error('HlcClock requires a non-empty nodeId');
    }
    this.nodeId = nodeId;
    this.wallMs = initialWallMs;
  }

  now(physicalWallMs = Date.now()): HlcTimestamp {
    if (physicalWallMs > this.wallMs) {
      this.wallMs = physicalWallMs;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatHlc(this.wallMs, this.counter, this.nodeId);
  }

  receive(remoteHlc: HlcTimestamp, physicalWallMs = Date.now()): HlcTimestamp {
    const remote = parseHlc(remoteHlc);
    const maxWall = Math.max(this.wallMs, remote.wallMs, physicalWallMs);

    if (maxWall === this.wallMs && maxWall === remote.wallMs) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxWall === this.wallMs) {
      this.counter += 1;
    } else if (maxWall === remote.wallMs) {
      this.counter = remote.counter + 1;
    } else {
      this.counter = 0;
    }

    this.wallMs = maxWall;
    return formatHlc(this.wallMs, this.counter, this.nodeId);
  }
}

function getFieldHlc(task: TaskItem, field: MergeableTaskField): HlcTimestamp {
  return task.fieldHlcs?.[field] ?? task.hlc;
}

/**
 * Field-level Last-Write-Wins merge: concurrent offline edits to distinct fields
 * (e.g. completing a task on Device A while editing its note on Device B) combine cleanly.
 */
export function mergeTaskLww(local: TaskItem, incoming: TaskItem): TaskItem {
  if (local.id !== incoming.id) {
    throw new Error(`Cannot merge tasks with different IDs: ${local.id} vs ${incoming.id}`);
  }

  const mergedFieldHlcs: FieldHlcMap = {};
  const result: TaskItem = {
    ...local,
    steps: local.steps.map((s) => ({ ...s })),
    fieldHlcs: mergedFieldHlcs,
  };

  for (const field of MERGEABLE_FIELDS) {
    const localFieldHlc = getFieldHlc(local, field);
    const incomingFieldHlc = getFieldHlc(incoming, field);
    const winnerIsIncoming = compareHlc(incomingFieldHlc, localFieldHlc) > 0;

    if (winnerIsIncoming) {
      if (field === 'steps') {
        result.steps = incoming.steps.map((s) => ({ ...s }));
      } else {
        (result as unknown as Record<string, unknown>)[field] = incoming[field];
      }
      mergedFieldHlcs[field] = incomingFieldHlc;
    } else {
      mergedFieldHlcs[field] = localFieldHlc;
    }
  }

  result.hlc = compareHlc(incoming.hlc, local.hlc) > 0 ? incoming.hlc : local.hlc;
  result.createdAt = local.createdAt <= incoming.createdAt ? local.createdAt : incoming.createdAt;
  result.updatedAt = local.updatedAt >= incoming.updatedAt ? local.updatedAt : incoming.updatedAt;

  return result;
}

export function mergeListLww(local: TaskList, incoming: TaskList): TaskList {
  if (local.id !== incoming.id) {
    throw new Error(`Cannot merge lists with different IDs: ${local.id} vs ${incoming.id}`);
  }
  const winner = compareHlc(incoming.hlc, local.hlc) > 0 ? incoming : local;
  return {
    id: local.id,
    title: winner.title,
    shared: winner.shared,
    inviteToken: winner.inviteToken,
    deletedAt: winner.deletedAt,
    hlc: winner.hlc,
    createdAt: local.createdAt <= incoming.createdAt ? local.createdAt : incoming.createdAt,
    updatedAt: local.updatedAt >= incoming.updatedAt ? local.updatedAt : incoming.updatedAt,
  };
}
