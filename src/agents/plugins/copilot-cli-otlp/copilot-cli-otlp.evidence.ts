import { ProviderRegistry } from '@/providers/index.js';
import { logger } from '@/utils/logger.js';
import { hasRecordForSession, readRecord, recordKey } from '@/agents/core/evidence/record-store.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { hasPendingOwnerSession } from '@/agents/core/evidence/owner-pending.js';
import { fundingRoute, routedViaCodemie, type RoutingInput } from '@/agents/core/evidence/routing.js';
import type { EvidenceInputs } from '@/agents/core/evidence/stamp.js';

/** Explicit Copilot `sessionStart` sources that begin a session. */
const FRESH_SOURCES = new Set(['new', 'startup']);

interface LaunchProfile {
  provider?: string;
  baseUrl?: string;
  authMethod?: string;
}

/** The profile the launcher resolved for this run (`--profile` applied), never the active profile. */
function readLaunchProfile(env: NodeJS.ProcessEnv): LaunchProfile | undefined {
  if (!env['CODEMIE_PROFILE_NAME']?.trim() || !env['CODEMIE_PROFILE_CONFIG']) return undefined;
  try {
    const parsed = JSON.parse(env['CODEMIE_PROFILE_CONFIG']) as Record<string, unknown> | null;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return parsed ? { provider: str(parsed['provider']), baseUrl: str(parsed['baseUrl']), authMethod: str(parsed['authMethod']) } : undefined;
  } catch {
    return undefined; // fixed message: the parse error would quote part of a config that can carry credentials
  }
}

/**
 * Evidence inputs for a Copilot CLI session CodeMie launched and can prove it routed through CodeMie; `undefined`
 * (the unchanged legacy path, no funding claim) for everything else: native Copilot, BYOK or a non-CodeMie profile,
 * an active profile the launch did not use, and any session that already has data but no record (resume, pre-upgrade).
 * Proof is the launcher's own exports: its loopback proxy is the endpoint Copilot was given, and that proxy's upstream
 * is the launch profile's model route (same rule as Claude's managed launch).
 */
export function copilotRouteProof(managed: boolean, env: NodeJS.ProcessEnv = process.env): Pick<EvidenceInputs, 'routing' | 'funding_route'> | undefined {
  if (!managed) return undefined;
  const profile = readLaunchProfile(env);
  if (!profile) return undefined;
  const authType = profile.provider ? ProviderRegistry.getProvider(profile.provider)?.authType : undefined;
  const codemieProvider = authType !== undefined && authType !== 'none' && (authType === 'sso' || profile.authMethod === 'jwt');
  const routingInput: RoutingInput = {
    // Only the facts the managed proof reads; Copilot's endpoint takes the place of Claude's.
    env: {
      CODEMIE_SESSION_ID: env['CODEMIE_SESSION_ID'],
      CODEMIE_BASE_URL: env['CODEMIE_BASE_URL'],
      CODEMIE_TARGET_API_URL: env['CODEMIE_TARGET_API_URL'],
      ANTHROPIC_BASE_URL: env['COPILOT_PROVIDER_BASE_URL'],
    },
    codemieProvider,
    profileBaseUrl: profile.baseUrl,
    profileName: env['CODEMIE_PROFILE_NAME'],
  };
  const routing = routedViaCodemie(routingInput);
  if (!routing.routed || routing.routing_proof !== 'proven') return undefined;
  const funding = fundingRoute(routingInput, routing);
  return funding === 'api_based' ? { routing, funding_route: funding } : undefined;
}

/** A session known to the evidence store under ANY login or key: only ever a conservative stop signal, never authorization. */
export async function isKnownSession(sessionId: string): Promise<boolean> {
  return (await hasRecordForSession(sessionId)) || (await hasPendingOwnerSession(sessionId));
}

/** Authorization to continue: a record at THIS login's key, or events held for this session's owner. */
async function isRecordedForCurrentLogin(sessionId: string): Promise<boolean> {
  const id = await currentEvidenceIdentity();
  if (id && (await readRecord(recordKey(id.api_identity, id.owner_hash, sessionId)))) return true;
  return hasPendingOwnerSession(sessionId);
}

/**
 * Inputs for this hook, or `undefined` for the unrecorded path. A NEW funding claim needs a concrete session binding:
 * a fresh start whose id is the one the launcher pinned (`--session-id`). An unpinned launch (resume/continue) cannot
 * tell its own session from a nested native Copilot that inherited the exports, so it only continues a session that is
 * already recorded. Whether a recorded session still has route proof is the caller's (sticky) decision.
 */
export async function copilotEvidenceInputs(args: {
  sessionId: string;
  managed: boolean;
  pinned: boolean;
  freshStart: boolean;
}, env: NodeJS.ProcessEnv = process.env): Promise<EvidenceInputs | undefined> {
  const proof = copilotRouteProof(args.managed, env);
  if (!proof) return undefined;
  if (!(args.freshStart && args.pinned) && !(await isRecordedForCurrentLogin(args.sessionId))) {
    logger.debug('[copilot-cli-otlp] no session binding or record for a new funding claim; staying on the unrecorded path');
    return undefined;
  }
  // Copilot's own enable/exclusion controls gate every hook; its records do not follow the Claude generation.
  return { ...proof, collection_generation: 0, agent: 'copilot-cli-otlp' };
}

// A missing source is safe only with the launcher pin required by copilotEvidenceInputs.
export const isFreshStart = (eventName: string, source: string | undefined): boolean =>
  eventName === 'sessionStart' && (source === undefined || FRESH_SOURCES.has(source));
