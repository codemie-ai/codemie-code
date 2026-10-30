import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { readRecord, recordKey } from '@/agents/core/evidence/record-store.js';
import { withSessionLock } from './session-lock.js';
import { readStatus, writeStatus, type SessionStatus } from './session-status.js';
import { OTEL_STREAMS } from './spool-paths.js';
import { hasPendingData, hooksGroupPresent, readSpoolState, type SpoolState } from './spool-state.js';
import {
  applyProjectPolicyLocked,
  clearHold,
  forwarderIdentity,
  pendingHooksMarkedLocked,
  recordLossLocked,
} from './spool-io.js';
import { gateDecision } from './completeness-gate.js';
import { forwardSession } from './forwarder.js';
import { areCredentialsStale } from './auth-state.js';
import {
  applyProjectDecision,
  decideProject,
  evaluateSessionEvidence,
  holdOrLose,
  type SessionEvidenceDecision,
} from './session-project.js';
import type { PolicyState } from './policy-cache.js';
import { readVerdictState } from './verdict-store.js';
import { heldRetentionMs } from './spool-config.js';
import { isPreEpoch, readOrCreateEpoch, sessionBirthMs } from './epoch.js';
import { classifySession, resolveAnalyticsEndpoint, sessionPolicyState, type AnalyticsEndpoint } from './classification.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';

const currentlyForwarding = new Set<string>();

type TickEvidenceDecision = SessionEvidenceDecision | { action: 'suppress' };

async function stickyPersonalOf(key: string): Promise<boolean> {
  const v = await readVerdictState(key);
  return v.state === 'unreadable' || (v.state === 'ok' && v.verdict.class === 'personal');
}

/**
 * Policy/capability for the forwarder's namespace, refreshed (bounded by the cache's backoff) before
 * the session lock is taken, so a slow backend never blocks spool appends. `undefined` = no identity.
 */
async function tickPolicyState(
  credentials: SSOCredentials | JWTCredentials,
  endpoint: AnalyticsEndpoint,
  reprobe: boolean
): Promise<PolicyState | undefined> {
  const id = endpoint.identity;
  if (!id) return undefined;
  const ns = { ...id, ...(endpoint.profile ? { profile: endpoint.profile } : {}) };
  return sessionPolicyState(ns, endpoint.baseUrl, credentials, undefined, reprobe);
}

/**
 * Gather the provenance inputs (marker, record at the forwarder's own key, capability, sticky
 * verdict, epoch), decide with `evaluateSessionEvidence`, classify an evidence send (consumer seam,
 * sticky verdict) and apply it to `status`: a hold keeps its first-hold time, a loss drops the
 * backlog with its named reason, a send clears the session hold and records the mode (an evidence
 * record also binds its project); `suppress` changes nothing. Caller holds the lock; writes the
 * status only when it changed.
 */
async function applySessionEvidenceLocked(
  sessionId: string,
  status: SessionStatus,
  spool: SpoolState,
  credentials: SSOCredentials | JWTCredentials,
  policy: PolicyState | undefined,
  now: number = Date.now()
): Promise<{ decision: TickEvidenceDecision; result?: ClassResult }> {
  const before = JSON.stringify(status);
  if (!status.evidenceMarked && (await pendingHooksMarkedLocked(sessionId, status))) {
    status.evidenceMarked = true;
  }

  const id = forwarderIdentity(credentials);
  const key = id ? recordKey(id.api_identity, id.owner_hash, sessionId) : undefined;
  const heldSince = status.holds?.session?.since;
  let decision: TickEvidenceDecision = evaluateSessionEvidence({
    hasHooks: hooksGroupPresent(spool),
    marked: status.evidenceMarked === true,
    record: key ? await readRecord(key) : undefined,
    capability: policy?.capability ?? 'unknown',
    // An unreadable verdict may hide a sticky Personal: treated as Personal (fail closed, never legacy).
    stickyPersonal: key ? await stickyPersonalOf(key) : false,
    preEpoch: isPreEpoch(await sessionBirthMs(sessionId), await readOrCreateEpoch()),
    heldSince,
    now,
    retentionMs: heldRetentionMs(),
  });

  let result: ClassResult | undefined;
  if (decision.action === 'send_evidence' && key) {
    const cls = await classifySession(key, decision.record, policy ?? { policy: null, capability: 'unknown' });
    if (cls.action === 'suppress') return { decision: cls };
    if (cls.action === 'hold') decision = holdOrLose(cls.reason, heldSince, now, heldRetentionMs());
    else result = cls.result;
  }

  if (decision.action === 'hold') {
    const since = status.holds?.session?.since ?? now;
    if (status.holds?.session?.reason !== decision.reason) {
      logger.debug('[otlp-tick] session held', ...sanitizeLogArgs({ sessionId, reason: decision.reason }));
    }
    status.holds = { ...status.holds, session: { reason: decision.reason, since } };
  } else {
    clearHold(status, 'session');
    if (decision.action === 'lose') {
      await recordLossLocked(sessionId, status, decision.reason, undefined, now);
    } else {
      status.sendMode = decision.action === 'send_evidence' ? 'evidence' : 'legacy';
      if (decision.action === 'send_evidence' && decision.record.project) {
        applyProjectDecision(status, decideProject([decision.record.project], status));
      }
    }
  }

  if (JSON.stringify(status) !== before) {
    await writeStatus(sessionId, status);
  }
  return { decision, result };
}

/**
 * The daemon's analytics URL does not match the credentials' identity: nothing is sent or fetched, but the
 * session is held under a named reason (and lost, recorded, only past the retention bound) instead of
 * silently stalling. Sessions with nothing pending are left untouched.
 */
async function holdEndpointMismatch(sessionId: string, now: number = Date.now()): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return;
    if (!hasPendingData(await readSpoolState(sessionId, status))) return;
    const heldSince = status.holds?.session?.since;
    const decision = holdOrLose('analytics_endpoint_mismatch', heldSince, now, heldRetentionMs());
    if (decision.action === 'lose') {
      clearHold(status, 'session');
      await recordLossLocked(sessionId, status, decision.reason, undefined, now);
    } else {
      if (status.holds?.session?.reason !== decision.reason) {
        logger.warn('[otlp-tick] analytics endpoint does not match the credential identity; session held', ...sanitizeLogArgs({ sessionId }));
      }
      status.holds = { ...status.holds, session: { reason: decision.reason, since: heldSince ?? now } };
    }
    await writeStatus(sessionId, status);
  });
}

/**
 * Process one tick for a single session: evaluate the completeness gate and,
 * when it permits forwarding, dispatch a forward pass for the streams that
 * actually have bytes after their cursor.
 *
 * A session stays gate-eligible for as long as its spool files are non-empty,
 * so the pending-data check is what keeps a fully drained tick from issuing
 * any HTTP requests.
 */
export async function processSessionTick(
  sessionId: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<void> {
  let shouldForward = false;
  let hooksOnly = false;
  let classification: ClassResult | undefined;
  // Re-decided every tick: the policy is refreshed (when due) before the classification below.
  // One analytics endpoint per tick, validated against the credential identity before any network call.
  const endpoint = areCredentialsStale() ? undefined : await resolveAnalyticsEndpoint(credentials);
  if (endpoint === null) return holdEndpointMismatch(sessionId);
  const reprobe = (await readStatus(sessionId))?.holds?.session?.reason === 'organization_encoding_unsupported';
  const policyState = endpoint ? await tickPolicyState(credentials, endpoint, reprobe) : undefined;

  await withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) {
      return;
    }
    if (areCredentialsStale()) {
      return;
    }

    const spool = await readSpoolState(sessionId, status);

    // Provenance first (spec item 7): a hold or a recorded loss is applied before any send, and the
    // session hold it persists also gates the snapshots and `isSendAllowed`.
    let evidenceSend = false;
    if (hasPendingData(spool)) {
      const { decision, result } = await applySessionEvidenceLocked(sessionId, status, spool, credentials, policyState);
      if (decision.action === 'hold' || decision.action === 'lose' || decision.action === 'suppress') return;
      evidenceSend = decision.action === 'send_evidence';
      classification = result;
    }

    // Project policy, before the completeness gate and the same one the snapshots apply: a
    // conflicted or unbound session sends nothing, so a hooks-only session that would never reach
    // the forwarder snapshots is discarded here. The one exception is the hooks prefix sealed while
    // the session was bound: it is flushed hooks-only at once, with no wait for OTLP that will
    // never be sent. Locked code: no updateStatus/advanceCursor (the lock is not reentrant).
    const policy = await applyProjectPolicyLocked(sessionId, status);
    if (policy.sealed) {
      shouldForward = true;
      hooksOnly = true;
      return;
    }
    // Sendable: bound, undecided (completeness gate decides) or an evidence session without a project (AC8).
    if (policy.state !== 'undecided' && policy.hooks.kind !== 'send') {
      return;
    }

    let decision = gateDecision(spool, status);
    // A valid evidence record proves the project is tracked (the hook stamps only tracked projects),
    // which is what the OTEL-only invariant guards: such a session no longer waits to be skipped.
    if (evidenceSend && !hooksGroupPresent(spool) && decision !== 'noop') {
      decision = 'send';
    }
    const pending = hasPendingData(spool);

    logger.debug(
      '[otlp-tick] gate decision',
      ...sanitizeLogArgs({ sessionId, decision, pending, waitTicks: status.waitTicks })
    );

    if (decision === 'send' || decision === 'hooks-only-force') {
      shouldForward = pending;
      hooksOnly = decision === 'hooks-only-force';
    } else if (decision === 'wait') {
      status.waitTicks += 1;
      await writeStatus(sessionId, status);
    } else if (decision === 'skip') {
      // INVARIANT: OTEL-only sessions are never forwarded (per-project allowlist,
      // see completeness-gate.ts). Advance cursors to EOF so the session counts
      // as drained and the sweeper deletes it.
      // Pure in-place mutation: the session lock is not reentrant, so do NOT call
      // advanceCursor/updateStatus/ensureStatus here.
      // Without valid credentials the tick returns before the gate, so skipping
      // resumes after a proxy restart with valid credentials.
      // Accepted trade-off: a tracked session whose first hook arrives after the
      // wait limit loses the OTEL bytes received before that.
      if (pending) {
        for (const stream of OTEL_STREAMS) {
          status.cursors[stream] = Math.max(status.cursors[stream], spool.streams[stream].size);
        }
        await writeStatus(sessionId, status);
      }
    }
    // 'noop': nothing written yet
  });

  if (!shouldForward || currentlyForwarding.has(sessionId)) {
    return;
  }

  currentlyForwarding.add(sessionId);

  try {
    if (classification) await forwardSession(sessionId, hooksOnly, credentials, classification, endpoint);
    else await forwardSession(sessionId, hooksOnly, credentials, undefined, endpoint);
  } finally {
    currentlyForwarding.delete(sessionId);
  }
}
