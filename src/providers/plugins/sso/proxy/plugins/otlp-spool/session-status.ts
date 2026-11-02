import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SPOOL_STREAMS, spoolRoot, statusFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import {
  DELIVERY_LOSS_REASONS,
  HOLD_REASONS,
  isSendableProjectName,
  LOSS_REASONS,
  MAX_CONFLICT_NAMES,
  parseProjectSeal,
  type DeliveryLossReason,
  type Hold,
  type HoldReason,
  type LossReason,
} from './session-project.js';

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
  /**
   * Named holds. `session` blocks every stream (provenance: stamp_pending, stamp_invalid, ...); a
   * stream hold tracks a head-of-line proof hold of that stream only. `since` survives restarts.
   */
  holds?: Partial<Record<HoldScope, Hold>>;
  /** The latest recorded loss: a hold that reached the retention bound and dropped its backlog. */
  lastLoss?: { reason: LossReason; at: number; bytes: number; detail?: string };
  /**
   * The latest hook-time stamp failure (no durable evidence record, nothing spooled). Its own single slot:
   * a stamp failure never overwrites `lastLoss` (a retention or delivery loss), and vice versa.
   */
  stampLoss?: StampLoss;
  /**
   * Unacknowledged delivery per stream: the first failure of the pending range starting at `cursor`
   * (backlog `[cursor, end)` as it was then). Valid only while the stream cursor still equals `cursor`.
   */
  delivery?: Partial<Record<SpoolStream, DeliveryFailure>>;
  /**
   * The latest final backend discard/rejection (e.g. `session_project_conflict`): acknowledged and
   * advanced, never an accepted send, so it stays visible here (AC18). Reason capped at 200 chars.
   */
  lastDiscard?: Discard;
  /** Provenance decided at the last tick: evidence request or today's legacy request. */
  sendMode?: 'evidence' | 'legacy';
  /** A hook line of this session carried the `evidence_v` envelope marker. Sticky. */
  evidenceMarked?: true;
}

export interface DeliveryFailure {
  reason: DeliveryLossReason;
  /** Backend/transport cause (capped), e.g. `http_413` or `default_project_unavailable`; never a body. */
  detail?: string;
  /** First failure of this range; kept across reason changes and restarts, so the retention bound is total. */
  since: number;
  cursor: number;
  end: number;
  attempts: number;
  /** No request for this stream before this time (bounded backoff). */
  nextAt: number;
}

/** `reason` is a bounded snake_case token from the hook (the stamp failure kind), else `stamp_invalid`. */
export interface StampLoss {
  reason: string;
  at: number;
  events: number;
}

export const MAX_STAMP_REASON = 40;
const STAMP_REASON = /^[a-z][a-z0-9_]*$/;

export function stampReasonToken(reason: unknown): string {
  return typeof reason === 'string' && reason.length <= MAX_STAMP_REASON && STAMP_REASON.test(reason) ? reason : 'stamp_invalid';
}

function parseStampLoss(raw: unknown): StampLoss | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { reason, at, events } = raw as Record<string, unknown>;
  if (toOffset(at) === 0) return undefined;
  return { reason: stampReasonToken(reason), at: toOffset(at), events: Math.max(1, toOffset(events)) };
}

export interface Discard {
  reason: string;
  stream: SpoolStream;
  bytes: number;
  at: number;
}

export type HoldScope = 'session' | SpoolStream;
const HOLD_SCOPES: readonly HoldScope[] = ['session', ...SPOOL_STREAMS];

function parseHolds(raw: unknown): SessionStatus['holds'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const holds: Partial<Record<HoldScope, Hold>> = {};
  for (const scope of HOLD_SCOPES) {
    const hold = (raw as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
    const since = toOffset(hold?.['since']);
    if (since > 0 && (HOLD_REASONS as readonly unknown[]).includes(hold?.['reason'])) {
      holds[scope] = { reason: hold!['reason'] as HoldReason, since };
    }
  }
  return Object.keys(holds).length > 0 ? holds : undefined;
}

function parseLoss(raw: unknown): SessionStatus['lastLoss'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { reason, at, bytes } = raw as Record<string, unknown>;
  if (!(LOSS_REASONS as readonly unknown[]).includes(reason) || toOffset(at) === 0) return undefined;
  const detail = (raw as Record<string, unknown>)['detail'];
  return {
    reason: reason as LossReason,
    at: toOffset(at),
    bytes: toOffset(bytes),
    ...(typeof detail === 'string' && detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
  };
}

const MAX_DETAIL = 200;

function parseDelivery(raw: unknown): SessionStatus['delivery'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Partial<Record<SpoolStream, DeliveryFailure>> = {};
  for (const stream of SPOOL_STREAMS) {
    const rec = (raw as Record<string, unknown>)[stream] as Record<string, unknown> | undefined;
    const since = toOffset(rec?.['since']);
    const end = toOffset(rec?.['end']);
    const cursor = toOffset(rec?.['cursor']);
    if (since === 0 || end <= cursor || !(DELIVERY_LOSS_REASONS as readonly unknown[]).includes(rec?.['reason'])) continue;
    const detail = rec!['detail'];
    out[stream] = {
      reason: rec!['reason'] as DeliveryLossReason,
      ...(typeof detail === 'string' && detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
      since,
      cursor,
      end,
      attempts: Math.max(1, toOffset(rec!['attempts'])),
      nextAt: toOffset(rec!['nextAt']),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDiscard(raw: unknown): Discard | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { reason, stream, bytes, at } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || !reason || !(SPOOL_STREAMS as readonly unknown[]).includes(stream)) return undefined;
  if (toOffset(at) === 0) return undefined;
  return { reason: reason.slice(0, 200), stream: stream as SpoolStream, bytes: toOffset(bytes), at: toOffset(at) };
}

export function createStatus(): SessionStatus {
  return {
    cursors: { hooks: 0, logs: 0, metrics: 0, traces: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
    waitTicks: 0,
  };
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
  const holds = parseHolds(source['holds']);
  if (holds) status.holds = holds;
  const loss = parseLoss(source['lastLoss']);
  if (loss) status.lastLoss = loss;
  const stampLoss = parseStampLoss(source['stampLoss']);
  if (stampLoss) status.stampLoss = stampLoss;
  const delivery = parseDelivery(source['delivery']);
  if (delivery) status.delivery = delivery;
  const discard = parseDiscard(source['lastDiscard']);
  if (discard) status.lastDiscard = discard;
  if (source['sendMode'] === 'evidence' || source['sendMode'] === 'legacy') status.sendMode = source['sendMode'];
  if (source['evidenceMarked'] === true) status.evidenceMarked = true;

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
  await mkdir(spoolRoot(), { recursive: true, mode: 0o700 });
  await writeFile(statusFile(sessionId), JSON.stringify(status), { encoding: 'utf-8', mode: 0o600 });
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

/** Advance an acknowledged cursor. Monotonic: never moves backwards. A final discard is recorded in the same write. */
export async function advanceCursor(
  sessionId: string,
  stream: SpoolStream,
  nextOffset: number,
  discard?: Discard
): Promise<void> {
  await updateStatus(sessionId, (status) => {
    status.cursors[stream] = Math.max(status.cursors[stream], nextOffset);
    // A partial acknowledgement trims the failing range to what is still unacknowledged; its first-failure
    // time and `end` stay, so the old remainder keeps its deadline. Only reaching `end` ends the range.
    const failing = status.delivery?.[stream];
    if (failing && status.cursors[stream] > failing.cursor) {
      if (status.cursors[stream] >= failing.end) {
        delete status.delivery![stream];
        if (Object.keys(status.delivery!).length === 0) delete status.delivery;
      } else {
        failing.cursor = status.cursors[stream];
      }
    }
    if (discard) status.lastDiscard = { ...discard, reason: discard.reason.slice(0, 200) };
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
