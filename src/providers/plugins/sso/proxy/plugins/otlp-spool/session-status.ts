import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SPOOL_STREAMS, spoolRoot, statusFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { isSendableProjectName, MAX_CONFLICT_NAMES, parseProjectSeal } from './session-project.js';

/** Byte offsets that have been acknowledged by the backend, per stream. */
export type SessionCursors = Record<SpoolStream, number>;

/**
 * The hooks prefix `[0, hooksEnd)` was written while the session was bound to `project`.
 * Set once, in the status write that records the conflict; read back only through
 * `parseProjectSeal`, which fails closed.
 */
export interface ProjectSeal {
  v: 1;
  project: string;
  hooksEnd: number;
}

export interface SessionStatus {
  /**
   * Delivery progress. A cursor is a byte offset into the corresponding spool
   * file and is only advanced after the backend acknowledges those bytes.
   */
  cursors: SessionCursors;
  /** Consecutive ticks a session has waited for its missing group (hooks-only or OTEL-only). */
  waitTicks: number;
  /**
   * Time when a successfully forwarded hooks batch contained `SessionEnd`.
   * Marks *normal completion*, not *delivery completion*: forwarding continues
   * for any bytes that are still pending or appended afterwards.
   */
  endedAt?: number;
  /** Project bound to the session: first usable name seen on a hook, original spelling, set once. */
  project?: string;
  /** Distinct project names seen once the session became ambiguous. Sticky: nothing is sent. */
  projectConflict?: string[];
  /** Only with `projectConflict` and a bound `project`: the hooks prefix that is still provably that project's. */
  projectSeal?: ProjectSeal;
  /** The on-disk hooks were scanned for a project (legacy recovery) or there was nothing to scan. */
  projectScanned?: true;
}

export function createStatus(): SessionStatus {
  return { cursors: { hooks: 0, logs: 0, metrics: 0, traces: 0 }, waitTicks: 0 };
}

function toOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Coerce whatever is on disk into a well-formed status. Unknown fields (e.g.
 * the removed `*Written` flags, flat cursors, `forwarded`) are dropped.
 */
function normalizeStatus(raw: unknown): SessionStatus {
  const status = createStatus();
  if (typeof raw !== 'object' || raw === null) {
    return status;
  }

  const source = raw as Record<string, unknown>;
  const cursors = (source['cursors'] ?? {}) as Record<string, unknown>;
  for (const stream of SPOOL_STREAMS) {
    status.cursors[stream] = toOffset(cursors[stream]);
  }
  status.waitTicks = toOffset(source['waitTicks']);
  const endedAt = toOffset(source['endedAt']);
  if (endedAt > 0) {
    status.endedAt = endedAt;
  }
  const project = source['project'];
  if (typeof project === 'string' && isSendableProjectName(project)) {
    status.project = project;
  }
  const conflict = source['projectConflict'];
  if (Array.isArray(conflict) && conflict.length > 0 && conflict.every((n) => typeof n === 'string')) {
    status.projectConflict = (conflict as string[]).slice(0, MAX_CONFLICT_NAMES);
  }
  const seal = parseProjectSeal(source['projectSeal'], status.projectConflict);
  if (seal) {
    status.projectSeal = seal;
  }
  if (source['projectScanned'] === true) {
    status.projectScanned = true;
  }

  return status;
}

/** Read and normalize a session status, or `null` when there is no status file. */
export async function readStatus(sessionId: string): Promise<SessionStatus | null> {
  try {
    const raw = await readFile(statusFile(sessionId), 'utf-8');
    return normalizeStatus(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeStatus(sessionId: string, status: SessionStatus): Promise<void> {
  await mkdir(spoolRoot(), { recursive: true });
  await writeFile(statusFile(sessionId), JSON.stringify(status), 'utf-8');
}

/**
 * Read-modify-write a status under the session lock.
 *
 * NOTE: the session lock is not reentrant — never call this while already
 * holding the lock for the same session.
 */
export async function updateStatus(
  sessionId: string,
  mutate: (status: SessionStatus) => void
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return; // session was swept — nothing to acknowledge
    mutate(status);
    await writeStatus(sessionId, status);
  });
}

export async function markSessionEnded(sessionId: string): Promise<void> {
  await updateStatus(sessionId, (status) => {
    status.endedAt ??= Date.now();
  });
}

/** Advance an acknowledged cursor. Monotonic: never moves backwards. */
export async function advanceCursor(
  sessionId: string,
  stream: SpoolStream,
  nextOffset: number
): Promise<void> {
  await updateStatus(sessionId, (status) => {
    status.cursors[stream] = Math.max(status.cursors[stream], nextOffset);
  });
}

/**
 * Create a default status if the session has none.
 * Caller MUST already hold the session lock.
 */
export async function ensureStatusLocked(sessionId: string): Promise<void> {
  if (await readStatus(sessionId)) {
    return;
  }
  await writeStatus(sessionId, createStatus());
}

/** Lock-acquiring variant — never call while holding the session lock. */
export async function ensureStatus(sessionId: string): Promise<void> {
  await withSessionLock(sessionId, () => ensureStatusLocked(sessionId));
}
