import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { recordKey } from '@/agents/core/evidence/record-store.js';
import { isStopped } from '@/agents/core/evidence/stop-marker.js';
import { consentHoldReleaser } from './consent-hold-releaser.js';
import type { HoldReason } from './session-project.js';
import { readStatus } from './session-status.js';
import { listSessionIdsStrict, statusFile } from './spool-paths.js';

/*
 * Releasing sessions the proxy holds locally once what held them is resolved (`codemie proxy analytics resend`; later
 * possibly every tick). One releaser per hold reason decides whether the cause is gone and removes it; sending stays
 * with the tick and the forwarder. A session held for a reason without a releaser is never touched, and a stopped
 * session is never released.
 */

export interface EvidenceIdentity {
  api_identity: string;
  owner_hash: string;
}

export interface HoldReleaseContext {
  sessionId: string;
  /** The session's evidence record key under `identity`. */
  key: string;
  identity: EvidenceIdentity;
}

/** `released`: the cause is gone, the next pass sends it; `kept`: still held (`detail` names why); `unavailable`: retry. */
export interface HoldReleaseVerdict {
  outcome: 'released' | 'kept' | 'unavailable';
  detail?: string;
}

export interface HoldReleaser {
  reason: HoldReason;
  /** Called under the session's forward lock, never for a stopped session. May throw (reported as `unavailable`). */
  release(ctx: HoldReleaseContext): Promise<HoldReleaseVerdict>;
}

/** A verdict, or `stopped` (never released) / `busy` (a proxy pass held the session; retry). */
export type HoldReleaseOutcome = HoldReleaseVerdict['outcome'] | 'stopped' | 'busy';

export interface HoldReleaseResult {
  sessionId: string;
  reason: HoldReason;
  outcome: HoldReleaseOutcome;
  detail?: string;
}

/** Filters of a release run; future ones (a session id, a dry run) are added here. */
export interface HoldReleaseOptions {
  /** Only these hold reasons (default: every reason with a releaser). */
  reasons?: readonly HoldReason[];
}

const RELEASERS: readonly HoldReleaser[] = [consentHoldReleaser];

/** How long a release waits for a proxy pass that holds the session. */
const LOCK_BUDGET_MS = 5_000;

export function releasableHoldReasons(): HoldReason[] {
  return RELEASERS.map((r) => r.reason);
}

function releaserFor(reason: string | undefined, options: HoldReleaseOptions): HoldReleaser | undefined {
  return RELEASERS.find((r) => r.reason === reason && (!options.reasons || options.reasons.includes(r.reason)));
}

/**
 * Releases one session when its hold has a releaser and the cause is gone. The caller holds the session's forward
 * lock (the tick does already; `releaseHeldSessions` takes it). Undefined when the session is not held for such a
 * reason. Never throws.
 */
export async function releaseHoldLocked(
  sessionId: string,
  identity: EvidenceIdentity,
  options: HoldReleaseOptions = {}
): Promise<HoldReleaseResult | undefined> {
  const releaser = releaserFor((await readStatus(sessionId))?.holds?.session?.reason, options);
  if (!releaser) return undefined;
  const key = recordKey(identity.api_identity, identity.owner_hash, sessionId);
  try {
    if (await isStopped(key)) return { sessionId, reason: releaser.reason, outcome: 'stopped' };
    return { sessionId, reason: releaser.reason, ...(await releaser.release({ sessionId, key, identity })) };
  } catch (err) {
    logger.debug('[hold-release] release failed', ...sanitizeLogArgs({ sessionId, reason: releaser.reason, error: err instanceof Error ? err.name : 'error' }));
    return { sessionId, reason: releaser.reason, outcome: 'unavailable' };
  }
}

/**
 * Every spooled session held for a reason with a releaser, each released under its forward lock so a proxy pass never
 * decides on a half-changed session. Sessions not held for such a reason are left out of the result. Throws only when
 * the spool directory cannot be listed.
 */
export async function releaseHeldSessions(identity: EvidenceIdentity, options: HoldReleaseOptions = {}): Promise<HoldReleaseResult[]> {
  const results: HoldReleaseResult[] = [];
  for (const sessionId of await listSessionIdsStrict()) {
    // Cheap pre-filter without the lock; the locked call reads the status again.
    const releaser = releaserFor((await readStatus(sessionId))?.holds?.session?.reason, options);
    if (!releaser) continue;
    const lock = await acquirePidLock(`${statusFile(sessionId)}.forward.lock`, { mode: 'wait', budgetMs: LOCK_BUDGET_MS });
    if (!lock) {
      results.push({ sessionId, reason: releaser.reason, outcome: 'busy' });
      continue;
    }
    try {
      const result = await releaseHoldLocked(sessionId, identity, options);
      if (result) results.push(result);
    } finally {
      await lock.release();
    }
  }
  return results;
}
