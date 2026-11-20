import { getAnalyticsPlatformSource, getPlatformUrl, getStoredAnalyticsCredentials } from '@/providers/core/codemie-auth-helpers.js';
import { withVerifiedOwner } from '@/providers/core/credential-owner.js';
import { ORG_ENCODING_V1 } from '@/agents/core/evidence/org-encoding.js';
import { applicableAuthMarker } from '@/providers/plugins/sso/sso.auth-gate.js';
import { summarizeSpoolDelivery, type LatestDrop, type SendFailure } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js';
import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { advertisesContract, getPolicyState, type PolicyState } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import { logger } from '@/utils/logger.js';
import type { DaemonState } from './daemon-manager.js';

export type DeliveryReason =
  | 'credentials_expired'
  | 'auth_rejected'
  | 'identity_mismatch'
  | 'send_failed'
  | 'classification_unreachable'
  | 'classification_unsupported';

export interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: DeliveryReason;
  /** Unsent bytes across all sessions; absent when the spool could not be read, which is not the same as none. */
  pendingBytes?: number;
  /** The part of `pendingBytes` held in sessions that are not sent for now; absent when none, or when `pendingBytes` is. */
  heldBytes?: number;
  /** The spool could not be read completely and no failure was found in what was read, so delivery cannot be judged. */
  incomplete?: true;
  /** When the next send is due and why the last one failed; set only when `reason` is `send_failed`. */
  sendFailure?: SendFailure;
  /** The newest drop the spool records; informational, it never changes `status`. */
  latestDrop?: LatestDrop;
}

/**
 * Label and remedy per reason; keyed by `Record` so a new code without a label fails to compile.
 * Every label is written for a non-technical reader, and calls the service "CodeMie". Only
 * `identity_mismatch` states its machine-wide scope in the label, because it comes from the spool,
 * which is shared by the whole machine; the `Unsent data` row states that scope for the rest.
 * `send_failed`, `classification_unreachable` and `classification_unsupported` have no `run`: there is
 * nothing the CLI can do locally — the first two clear on their own once CodeMie responds, the last
 * needs a CodeMie administrator to enable the feature on the backend.
 *
 * Known limitation: `classification_unreachable`/`classification_unsupported` read the active
 * profile's capability against every session in the shared spool (see `SpoolDeliverySummary`'s
 * docstring) — a session still pending from a profile the user has since switched away from is
 * judged by the wrong capability until it drains or is lost to retention.
 */
export const DELIVERY_REASONS: Record<DeliveryReason, { label: string; command?: string }> = {
  credentials_expired: { label: 'CodeMie sign-in has expired', command: 'codemie profile login' },
  auth_rejected: { label: 'CodeMie asked you to sign in again', command: 'codemie profile login' },
  identity_mismatch: {
    label: "analytics destination doesn't match your signed-in account — affects all sessions on this computer",
    command: 'codemie proxy restart',
  },
  send_failed: { label: 'last send to CodeMie failed, retrying' },
  classification_unreachable: { label: 'waiting for CodeMie to respond' },
  classification_unsupported: { label: "CodeMie isn't set up to accept this data yet — contact your CodeMie administrator" },
};

const UNKNOWN: DeliveryHealth = { status: 'unknown' };

/**
 * The cached classification-policy state for the active profile's namespace, read from the on-disk
 * stored credential — never the daemon's live one. Run through `withVerifiedOwner`, the same owner
 * lookup the daemon's own tick applies before it writes the policy cache (`otlp.plugin.ts`'s
 * `tick`), so a login with no `codemie_access_token` claim (oauth2-proxy) resolves to the same
 * namespace key the daemon actually cached under, instead of always falling back to an unresolved
 * state. `withVerifiedOwner` may probe the backend once and then cache the result on disk, bounded
 * by its own timeout and failure cooldown. `null` is the safe fallback whenever no NamespaceId can
 * be resolved (or the read fails), so an unresolved identity can never produce a false
 * `classification_unreachable`/`classification_unsupported` (spec AC3) — only a genuinely resolved
 * `PolicyState` ever drives a reason. Never throws, for the same reason: a credential-read failure
 * here must not blank out the other signals `collectDeliveryHealth` already computed.
 */
async function resolvePolicyState(state: DaemonState): Promise<PolicyState | null> {
  try {
    const stored = await getStoredAnalyticsCredentials(state.syncCodeMieUrl, {}, {
      provider: state.provider,
      baseUrl: state.targetUrl,
    });
    if (!stored) return null;
    const identity = forwarderIdentity(await withVerifiedOwner(stored.credentials));
    if (!identity) return null;
    return await getPolicyState({ ...identity, profile: state.profile });
  } catch (error) {
    logger.debug('[delivery-health] Could not resolve analytics capability:', error);
    return null;
  }
}

/**
 * Whether analytics reach CodeMie, judged from the daemon's `/health` reply, the auth marker and the
 * OTLP spool. Sends no analytics request. For a login without an owner claim, resolving the namespace
 * may make one bounded `GET /v1/user` (5 s timeout, then cached per login) and write the owner record,
 * as the daemon's tick does. The auth marker is matched against the daemon's recorded profile,
 * never the calling process's. Never throws: any failure reads as `unknown`.
 */
export async function collectDeliveryHealth(
  state: DaemonState,
  reply?: AnalyticsHealthReply
): Promise<DeliveryHealth> {
  try {
    const source = getAnalyticsPlatformSource(
      state.syncCodeMieUrl,
      {},
      { provider: state.provider, baseUrl: state.targetUrl }
    );
    // The spool scan touches different data than capability resolution (credential read, possibly
    // an owner-verification probe), so all three run concurrently instead of the scan waiting on it.
    const [marker, policyState, spool] = await Promise.all([
      applicableAuthMarker(source, [state.targetUrl, state.syncApiUrl, getPlatformUrl(source)]),
      resolvePolicyState(state),
      summarizeSpoolDelivery(),
    ]);

    const reason: DeliveryReason | undefined =
      reply?.credentials === 'stale' ? 'credentials_expired'
      : marker ? 'auth_rejected'
      : spool.mismatchHeld ? 'identity_mismatch'
      : spool.sendFailure ? 'send_failed'
      // Capability is a single resolved value, so at most one of the capability branches ever applies.
      // `evidence` means the backend answered with a usable policy but one that still does not advertise
      // the negotiated publication contract — a stalled session under it is just as stuck as under
      // `legacy`, it just means "answered, but still missing the capability" rather than "never answered".
      // A contract stall clears once the contract is advertised, so an advertising backend stays quiet; an
      // organization-encoding stall does not, so it is judged by the encodings the last policy advertised,
      // which stay readable after the policy expires: an expired cache is an outage, not a missing encoding.
      : spool.classificationStalled && policyState?.capability === 'unknown' ? 'classification_unreachable'
      : spool.classificationStalled && policyState?.capability === 'legacy' ? 'classification_unsupported'
      : spool.classificationStalled && policyState?.capability === 'evidence' && !advertisesContract(policyState) ? 'classification_unsupported'
      : spool.organizationEncodingStalled && policyState?.capability === 'evidence' && !policyState.organizationEncodings?.includes(ORG_ENCODING_V1)
        ? 'classification_unsupported'
      : undefined;

    const drop = spool.latestDrop ? { latestDrop: spool.latestDrop } : {};
    const pending = spool.incomplete ? {} : { pendingBytes: spool.pendingBytes, ...(spool.heldBytes ? { heldBytes: spool.heldBytes } : {}) };
    if (reason) {
      const failure = reason === 'send_failed' && spool.sendFailure ? { sendFailure: spool.sendFailure } : {};
      return { status: 'unhealthy', reason, ...pending, ...failure, ...drop };
    }
    if (spool.incomplete) {
      return { status: 'unknown', incomplete: true, ...drop };
    }
    return { status: reply?.credentials === 'ok' ? 'healthy' : 'unknown', ...pending, ...drop };
  } catch (error) {
    logger.debug('[delivery-health] Could not collect delivery health:', error);
    return UNKNOWN;
  }
}

/** Why delivery cannot be judged: an unreadable spool is not fixed by a restart, a missing health reply is. */
export function unknownHint(health: DeliveryHealth): string {
  return health.incomplete ? 'local analytics data could not be read' : 'restart the proxy to enable all checks';
}
