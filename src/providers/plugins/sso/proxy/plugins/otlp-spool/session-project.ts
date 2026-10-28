import type { ProjectSeal, SessionStatus } from './session-status.js';

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

/** The string `codemie_project_name` at the top level of a hook event; `raw` is not consulted. */
export function hookEventProjectNames(event: unknown): string[] {
  if (typeof event !== 'object' || event === null) return [];
  const value = (event as Record<string, unknown>)['codemie_project_name'];
  return typeof value === 'string' ? [value] : [];
}

export type ProjectDecision =
  | { action: 'noop' }
  | { action: 'bind'; project: string }
  | { action: 'conflict'; names: string[] };

/**
 * Pure decision over the incoming names plus the stored binding. A stored conflict is final. A session
 * bound to a sendable project is never changed by incoming names: an unsendable one is dropped when its
 * hooks are forwarded, a different sendable one is its own request. An unbound session binds the first
 * sendable name (names are compared case-insensitively, the first spelling is kept) and conflicts only
 * when every incoming name is unsendable, listing them. The outcome therefore depends on order:
 * `[Bé]` alone conflicts for good, while `[Bé, A]` binds `A`.
 */
export function decideProject(names: string[], status: SessionStatus): ProjectDecision {
  if (status.projectConflict) return { action: 'noop' };
  if (status.project && isSendableProjectName(status.project)) return { action: 'noop' };

  const distinct = new Map<string, string>();
  for (const name of names) {
    if (blank(name)) continue;
    const key = name.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, name);
  }
  const candidates = [...distinct.values()];

  const sendable = candidates.find(isSendableProjectName);
  if (sendable !== undefined) return { action: 'bind', project: sendable };
  if (candidates.length > 0) return { action: 'conflict', names: candidates };
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

/** A hook record is provably `project`'s only if its top-level name is non-blank and equals it. */
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
  state: ProjectGate['state'] | 'undecided';
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
  const gate = projectGate(status);

  if (gate.state === 'bound') {
    const send: StreamPolicy = { kind: 'send', project: gate.project };
    return { state: 'bound', hooks: send, otel: send, sealed: false };
  }

  if (gate.state === 'unbound') {
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
