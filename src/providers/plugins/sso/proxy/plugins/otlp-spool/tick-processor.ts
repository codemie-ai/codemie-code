import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { withSessionLock } from './session-lock.js';
import { readStatus, writeStatus } from './session-status.js';
import { hasPendingData, readSpoolState } from './spool-state.js';
import { gateDecision } from './completeness-gate.js';
import { forwardSession } from './forwarder.js';
import { areCredentialsStale } from './auth-state.js';

const currentlyForwarding = new Set<string>();

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

  await withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) {
      return;
    }
    if (areCredentialsStale()) {
      return;
    }

    const spool = await readSpoolState(sessionId, status);
    const decision = gateDecision(spool, status);
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
    }
    // 'noop': nothing written yet
  });

  if (!shouldForward || currentlyForwarding.has(sessionId)) {
    return;
  }

  currentlyForwarding.add(sessionId);

  try {
    await forwardSession(sessionId, hooksOnly, credentials);
  } finally {
    currentlyForwarding.delete(sessionId);
  }
}
