import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getRawGitOrigin, repoKeyFromRemote } from '@/utils/processes.js';
import type { OtlpHookContext } from '../OtlpAgentAdapter.js';
import { resolveHookCredentials } from '../hook-credentials.js';
import { resolveEmailFromCredentials } from '../identity-resolver.js';
import { loadHookConfig, resolveSessionProject } from '../event-fields/identity-fields.js';
import { apiIdentity, ownerHash } from './api-identity.js';
import { launchMode, type FundingRoute, type RoutingResult } from './routing.js';
import { resolveConsent } from './consent-store.js';
import { parseProjectBinding, PROJECT_BINDING_ENV, type ProjectBindingState } from '@/utils/project-binding.js';
import { createOrRead, readRecord, recordKey, touch, type EvidenceFields, type EvidenceRecord } from './record-store.js';
import type { PendingFields } from './owner-pending.js';
import { credentialFingerprint } from '@/providers/core/credential-owner.js';
import { isSSOCredentials, type SSOCredentials } from '@/providers/core/types.js';

/** Adapter-supplied facts the base cannot know (Claude organization, settings.json routing). */
export interface EvidenceInputs {
  organization?: string;
  routing: RoutingResult;
  /** New publication contract: supplied by the adapter, frozen at the first stamp. Absent = legacy recording. */
  funding_route?: FundingRoute;
  collection_generation?: number;
}

/**
 * `detail` names the specific failure (e.g. `project_too_long`); `reason` stays the coarse category.
 * `pending` (only with `no_owner`): the hook-time facts and the login fingerprint, so the events can be held for this login.
 */
export type StampResult =
  | { ok: true; record: EvidenceRecord }
  | { ok: false; reason: string; detail?: string; pending?: { fp: string; fields: PendingFields } };

/** The hook-time facts of a new record, everything but the owner. */
async function hookTimeFields(
  context: OtlpHookContext,
  inputs: EvidenceInputs,
  sessionId: string,
  api: string
): Promise<PendingFields> {
  const hookConfig = await loadHookConfig(context.cwd);
  const configDir = hookConfig?.configDir ?? context.cwd;
  const project = (await resolveSessionProject(context.cwd, sessionId)) || undefined;
  const project_source = await projectSource(project, hookConfig, configDir);
  const rawOrigin = await getRawGitOrigin(context.cwd);
  return {
    session_id: sessionId,
    launch_mode: launchMode(process.env),
    routed_via_codemie: inputs.routing.routed,
    routing_proof: inputs.routing.routing_proof,
    organization: inputs.organization,
    project,
    project_source,
    repo_key: rawOrigin ? repoKeyFromRemote(rawOrigin) : undefined,
    api_identity: api,
    profile: hookConfig?.config.name,
    projectBinding: projectBindingFor(project),
    ...(inputs.funding_route !== undefined
      ? { funding_route: inputs.funding_route, collection_generation: inputs.collection_generation ?? 0 }
      : {}),
  };
}

/** Facts to hold for a login whose owner is not known yet; nothing when there is no login or no usable API URL. */
async function pendingFor(
  credentials: SSOCredentials,
  context: OtlpHookContext,
  inputs: EvidenceInputs,
  sessionId: string
): Promise<{ pending: { fp: string; fields: PendingFields } } | Record<string, never>> {
  if (!isSSOCredentials(credentials) || Object.keys(credentials.cookies).length === 0) return {};
  try {
    const api = apiIdentity(credentials.apiUrl);
    return { pending: { fp: credentialFingerprint(credentials), fields: await hookTimeFields(context, inputs, sessionId, api) } };
  } catch {
    return {};
  }
}

/**
 * Origin of the project actually selected. Only a project equal to the config's own can name the config's
 * origin; an env- or pin-supplied project that differs has no attributable source ('none': project still sent).
 */
async function projectSource(
  project: string | undefined,
  hookConfig: Awaited<ReturnType<typeof loadHookConfig>>,
  configDir: string
): Promise<EvidenceFields['project_source']> {
  if (!project || !hookConfig || hookConfig.config.codeMieProject !== project) return 'none';
  try {
    const { projectOrigin: origin } = await ConfigLoader.resolveProfileIdentity(configDir, hookConfig.config.name);
    // The project may sit on the selected profile record itself, outside any workspace.
    return origin === 'none' ? 'profile' : origin;
  } catch {
    return 'none';
  }
}

/**
 * The launcher's binding state, only when it was computed for the project being stamped
 * (the launcher's own CODEMIE_PROJECT); otherwise omitted.
 */
function projectBindingFor(project: string | undefined): ProjectBindingState | undefined {
  const binding = parseProjectBinding(process.env[PROJECT_BINDING_ENV]);
  if (!binding) return undefined;
  const launched = process.env['CODEMIE_PROJECT']?.trim() || undefined;
  return launched === project ? binding : undefined;
}

/**
 * Creates or reads the session's durable evidence record before anything is spooled.
 * Never throws. A failure carries a reason code only (no URL, email, org or path values).
 */
export async function stampEvidence(
  context: OtlpHookContext,
  inputs: EvidenceInputs
): Promise<StampResult> {
  const sessionId = context.sessionId;
  if (!sessionId) return { ok: false, reason: 'session_id_absent' };
  try {
    const credentials = await resolveHookCredentials();
    if (!credentials?.apiUrl) return { ok: false, reason: 'no_credentials' };
    const email = resolveEmailFromCredentials(credentials);
    if (!email) return { ok: false, reason: 'no_owner', ...(await pendingFor(credentials, context, inputs, sessionId)) };
    let api: string;
    try {
      api = apiIdentity(credentials.apiUrl);
    } catch {
      return { ok: false, reason: 'api_url_unparsable' };
    }

    const key = recordKey(api, ownerHash(email), sessionId);
    const found = await readRecord(key);
    if (found) {
      if (found.kind !== 'created' && found.kind !== 'existing') return { ok: false, reason: found.kind };
      await touch(key);
      return { ok: true, record: found.record };
    }

    const hookFields = await hookTimeFields(context, inputs, sessionId, api);
    // Explicit work consent is frozen as a path-free reference; only the new contract carries it, and only with a project.
    const consent_ref = hookFields.funding_route !== undefined && hookFields.project
      ? await resolveConsent({ owner_hash: ownerHash(email), api_identity: api, project: hookFields.project }, context.cwd)
      : undefined;
    const fields = { ...hookFields, ...(consent_ref ? { consent_ref } : {}), owner_hash: ownerHash(email) };
    let created = await createOrRead(key, fields);
    if (created.kind === 'evidence_capacity') {
      // At the cap: evict idle records whose sessions have no undelivered spool now, not at the next sweep.
      const { pendingSpoolSessionIds } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/sweep.js');
      created = await createOrRead(key, fields, { pendingSessionIds: await pendingSpoolSessionIds() });
    }
    if (created.kind === 'created' || created.kind === 'existing') return { ok: true, record: created.record };
    const detail = 'reason' in created && created.reason !== created.kind ? created.reason : undefined;
    return { ok: false, reason: created.kind, ...(detail ? { detail } : {}) };
  } catch (error) {
    logger.debug(`[evidence-stamp] failed: ${error instanceof Error ? error.name : 'error'}`);
    return { ok: false, reason: 'unavailable' };
  }
}
