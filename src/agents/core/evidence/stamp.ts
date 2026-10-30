import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getRawGitOrigin, repoKeyFromRemote } from '@/utils/processes.js';
import type { OtlpHookContext } from '../OtlpAgentAdapter.js';
import { resolveHookCredentials } from '../hook-credentials.js';
import { resolveEmailFromCredentials } from '../identity-resolver.js';
import { loadHookConfig, resolveSessionProject } from '../event-fields/identity-fields.js';
import { apiIdentity, ownerHash } from './api-identity.js';
import { launchMode, type RoutingResult } from './routing.js';
import { createOrRead, readRecord, recordKey, touch, type EvidenceFields, type EvidenceRecord } from './record-store.js';

/** Adapter-supplied facts the base cannot know (Claude organization, settings.json routing). */
export interface EvidenceInputs {
  organization?: string;
  routing: RoutingResult;
}

/** `detail` names the specific failure (e.g. `project_too_long`); `reason` stays the coarse category. */
export type StampResult = { ok: true; record: EvidenceRecord } | { ok: false; reason: string; detail?: string };

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
    const isLocalProfile = await ConfigLoader.isLocalProfile(configDir, hookConfig.config.name);
    return await ConfigLoader.resolveProjectOrigin(configDir, isLocalProfile, launchMode(process.env) === 'native');
  } catch {
    return 'none';
  }
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
    if (!email) return { ok: false, reason: 'no_owner' };
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

    const hookConfig = await loadHookConfig(context.cwd);
    const configDir = hookConfig?.configDir ?? context.cwd;
    const project = (await resolveSessionProject(context.cwd, sessionId)) || undefined;
    const project_source = await projectSource(project, hookConfig, configDir);
    const rawOrigin = await getRawGitOrigin(context.cwd);

    const fields = {
      session_id: sessionId,
      launch_mode: launchMode(process.env),
      routed_via_codemie: inputs.routing.routed,
      routing_proof: inputs.routing.routing_proof,
      organization: inputs.organization,
      project,
      project_source,
      repo_key: rawOrigin ? repoKeyFromRemote(rawOrigin) : undefined,
      api_identity: api,
      owner_hash: ownerHash(email),
      profile: hookConfig?.config.name,
    };
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
