import type { EvidenceRecord, RecordResult } from '@/agents/core/evidence/record-store.js';
import type { Capability } from './policy-cache.js';
import type { ProjectSeal, SessionStatus } from './session-status.js';

/** Named reasons a session or a stream is held. Every hold ends in a send or, past `heldRetentionMs`, a recorded loss. */
export const HOLD_REASONS = [
  'stamp_pending',
  'stamp_invalid',
  'evidence_capacity',
  'personal_not_forwardable',
  'verdict_unavailable',
  'classification_unresolved',
  'session_mismatch',
  'session_id_absent',
  'project_conflict',
  'otlp_unparseable',
  'otlp_entry_too_large',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** A loss keeps its hold reason, except an expired `stamp_pending`, which is `no_evidence_timeout`. */
export type LossReason = Exclude<HoldReason, 'stamp_pending'> | 'no_evidence_timeout';
export const LOSS_REASONS: readonly LossReason[] = [
  ...HOLD_REASONS.filter((reason): reason is Exclude<HoldReason, 'stamp_pending'> => reason !== 'stamp_pending'),
  'no_evidence_timeout',
];

export interface Hold {
  reason: HoldReason;
  /** First-hold time; kept across reason changes and restarts, so the retention bound is total. */
  since: number;
}

/** Hold, or past the retention bound measured from the first hold, lose with the matching loss reason. */
export function holdOrLose(
  reason: HoldReason,
  heldSince: number | undefined,
  now: number,
  retentionMs: number
): { action: 'hold'; reason: HoldReason } | { action: 'lose'; reason: LossReason } {
  if (heldSince === undefined || now - heldSince < retentionMs) return { action: 'hold', reason };
  return { action: 'lose', reason: reason === 'stamp_pending' ? 'no_evidence_timeout' : reason };
}

export interface SessionEvidenceInput {
  /** The hooks file has data (an OTLP-only session has none). */
  hasHooks: boolean;
  /** A hook line of this session carried the `evidence_v` envelope marker (sticky). */
  marked: boolean;
  /** `readRecord` at the forwarder's own key; undefined = no record, or no key could be built. */
  record: RecordResult | undefined;
  capability: Capability;
  /** A sticky Personal verdict exists for the session (I5). */
  stickyPersonal: boolean;
  /** The session is known to predate this version's `epoch.json`. */
  preEpoch: boolean;
  heldSince?: number;
  now: number;
  retentionMs: number;
}

export type SessionEvidenceDecision =
  | { action: 'send_evidence'; record: EvidenceRecord }
  | { action: 'send_legacy'; reason: 'unstamped_legacy' }
  | { action: 'hold'; reason: HoldReason }
  | { action: 'lose'; reason: LossReason };

/**
 * Pure provenance decision for one session (spec items 7, 8; I2, I5, I6). Order matters:
 * a bad or missing record under the marker holds before any capability shortcut (I2: never an
 * evidence-free send); `unknown` capability is treated as possibly evidence-capable, so a new
 * OTLP-only session waits for its stamp instead of a legacy send (failures never become legacy).
 */
export function evaluateSessionEvidence(input: SessionEvidenceInput): SessionEvidenceDecision {
  const hold = (reason: HoldReason): SessionEvidenceDecision =>
    holdOrLose(reason, input.heldSince, input.now, input.retentionMs);
  const legacy: SessionEvidenceDecision = { action: 'send_legacy', reason: 'unstamped_legacy' };
  const { record } = input;
  const valid = record && (record.kind === 'created' || record.kind === 'existing') ? record.record : undefined;

  if (record && !valid) return hold('stamp_invalid');
  if (input.marked && !valid) return hold('stamp_invalid');
  if (input.capability === 'legacy') return input.stickyPersonal ? hold('personal_not_forwardable') : legacy;
  if (valid) return { action: 'send_evidence', record: valid };
  if (input.hasHooks || input.preEpoch) return legacy;
  return hold('stamp_pending');
}

/** Upper bound on remembered conflicting names; only their existence matters. */
export const MAX_CONFLICT_NAMES = 8;

const blank = (name: string): boolean => name.trim().length === 0;

/**
 * A non-blank name that can travel as an HTTP header value unchanged. Restricted to printable
 * ASCII: `fetch`/`undici` encode a JS string placed in a header byte-for-byte as Latin-1, not
 * UTF-8, so a non-ASCII name (e.g. "Café") would arrive at the backend corrupted.
 */
export function isSendableProjectName(name: string): boolean {
  return !blank(name) && name === name.trim() && /^[\x20-\x7e]+$/.test(name);
}

/** String values of `codemie_project_name` at the top level and inside `raw` of a hook event. */
export function hookEventProjectNames(event: unknown): string[] {
  const names: string[] = [];
  const collect = (holder: unknown): void => {
    if (typeof holder !== 'object' || holder === null) return;
    const value = (holder as Record<string, unknown>)['codemie_project_name'];
    if (typeof value === 'string') names.push(value);
  };
  collect(event);
  collect((event as Record<string, unknown> | null)?.['raw']);
  return names;
}

export type ProjectDecision =
  | { action: 'noop' }
  | { action: 'bind'; project: string }
  | { action: 'conflict'; names: string[] };

/**
 * Pure decision over the incoming names plus the stored binding, so a mixed
 * batch is judged as a whole and a later batch against what is already stored.
 */
export function decideProject(names: string[], status: SessionStatus): ProjectDecision {
  if (status.projectConflict) return { action: 'noop' };

  const distinct = new Map<string, string>();
  for (const name of [...(status.project ? [status.project] : []), ...names]) {
    if (blank(name)) continue;
    const key = name.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, name);
  }
  const candidates = [...distinct.values()];

  if (candidates.length > 1 || candidates.some((name) => !isSendableProjectName(name))) {
    return { action: 'conflict', names: candidates };
  }
  if (candidates.length === 1 && !status.project) {
    return { action: 'bind', project: candidates[0] };
  }
  return { action: 'noop' };
}

/**
 * Mutates `status` only; the caller persists it. `hooksSizeBefore` is the exact size of the hooks
 * file before the append that caused the conflict: when the session was bound, it becomes the end
 * of the sealed prefix. Without it (legacy scan) or without a bound project there is no seal.
 */
export function applyProjectDecision(
  status: SessionStatus,
  decision: ProjectDecision,
  hooksSizeBefore?: number
): void {
  if (decision.action === 'bind') {
    status.project = decision.project;
  } else if (decision.action === 'conflict' && !status.projectConflict) {
    if (status.project && hooksSizeBefore !== undefined && isSendableProjectName(status.project)) {
      status.projectSeal = { v: 1, project: status.project, hooksEnd: hooksSizeBefore };
    }
    status.projectConflict = decision.names.slice(0, MAX_CONFLICT_NAMES);
  }
}

/**
 * A seal is usable only if it is exactly what `applyProjectDecision` writes: version 1, a sendable
 * project, a safe non-negative end, and a conflict that names that project. Anything else is ignored,
 * which means the old behaviour (discard).
 */
export function parseProjectSeal(raw: unknown, conflict: string[] | undefined): ProjectSeal | undefined {
  if (typeof raw !== 'object' || raw === null || !conflict) return undefined;
  const seal = raw as Record<string, unknown>;
  const { v, project, hooksEnd } = seal;
  if (v !== 1 || typeof project !== 'string' || !isSendableProjectName(project)) return undefined;
  if (typeof hooksEnd !== 'number' || !Number.isSafeInteger(hooksEnd) || hooksEnd < 0) return undefined;
  if (!conflict.some((name) => name.toLowerCase() === project.toLowerCase())) return undefined;
  return { v: 1, project, hooksEnd };
}

/** A hook record is provably `project`'s only if every name it carries is non-blank and equals it. */
export function hookRecordIsProject(record: string, project: string): boolean {
  try {
    const { hookEvent } = JSON.parse(record) as { hookEvent: string };
    const names = hookEventProjectNames(JSON.parse(hookEvent));
    const wanted = project.toLowerCase();
    return names.length > 0 && names.every((name) => name.toLowerCase() === wanted);
  } catch {
    return false;
  }
}

export type ProjectGate =
  | { state: 'bound'; project: string }
  | { state: 'conflict' }
  | { state: 'unbound' };

export function projectGate(status: SessionStatus): ProjectGate {
  if (status.projectConflict) return { state: 'conflict' };
  if (status.project) return { state: 'bound', project: status.project };
  return { state: 'unbound' };
}

/** What may leave for one class of streams. `hold`: not decided yet, the completeness gate decides. */
export type StreamPolicy =
  | { kind: 'send'; project: string; limit?: number; onlyProject?: string }
  | { kind: 'discard' }
  | { kind: 'hold' };

export interface SessionPolicy {
  state: ProjectGate['state'] | 'undecided' | 'held';
  hooks: StreamPolicy;
  otel: StreamPolicy;
  /** A conflicted session whose provably-original hooks prefix is still being flushed. */
  sealed: boolean;
  /** Why everything is discarded, for the one log line; set only on a conflict. */
  reason?: 'no-seal' | 'hooks-only-forwarding-disabled' | 'seal-flushed';
}

export interface PolicyInput {
  hooksSize: number;
  hooksOnlyAllowed: boolean;
}

const DISCARD: StreamPolicy = { kind: 'discard' };
const HOLD: StreamPolicy = { kind: 'hold' };

/**
 * The single decision behind the tick and the snapshots, so they cannot drift apart. Pure.
 * A conflicted session sends nothing, except the hooks prefix sealed while it was bound, and only
 * while hooks-only forwarding is allowed: that prefix can only travel without OTLP.
 */
export function evaluateProjectPolicy(status: SessionStatus, input: PolicyInput): SessionPolicy {
  // A session hold (stamp_pending, stamp_invalid, ...) wins over everything: nothing sent, nothing discarded.
  if (status.holds?.session) return { state: 'held', hooks: HOLD, otel: HOLD, sealed: false };

  const gate = projectGate(status);

  if (gate.state === 'bound') {
    const send: StreamPolicy = { kind: 'send', project: gate.project };
    return { state: 'bound', hooks: send, otel: send, sealed: false };
  }

  if (gate.state === 'unbound') {
    // AC8: an evidence session without a project is sent without Project headers, never discarded locally.
    if (status.sendMode === 'evidence') {
      const send: StreamPolicy = { kind: 'send', project: '' };
      return { state: 'unbound', hooks: send, otel: send, sealed: false };
    }
    // No hooks yet: late hooks may still bind, so the wait/skip path of the completeness gate stays in charge.
    if (input.hooksSize === 0) return { state: 'undecided', hooks: HOLD, otel: HOLD, sealed: false };
    return { state: 'unbound', hooks: DISCARD, otel: DISCARD, sealed: false };
  }

  const seal = status.projectSeal;
  if (!seal) return { state: 'conflict', hooks: DISCARD, otel: DISCARD, sealed: false, reason: 'no-seal' };
  if (!input.hooksOnlyAllowed) {
    return { state: 'conflict', hooks: DISCARD, otel: DISCARD, sealed: false, reason: 'hooks-only-forwarding-disabled' };
  }
  const end = Math.min(seal.hooksEnd, input.hooksSize);
  if (status.cursors.hooks >= end) {
    return { state: 'conflict', hooks: DISCARD, otel: DISCARD, sealed: false, reason: 'seal-flushed' };
  }
  return {
    state: 'conflict',
    hooks: { kind: 'send', project: seal.project, limit: end, onlyProject: seal.project },
    otel: DISCARD,
    sealed: true,
  };
}
