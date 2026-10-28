import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, evidenceDir } from '@/agents/core/evidence/record-store.js';
import type { Policy } from '@/agents/core/evidence/classify.js';
import { logger } from '@/utils/logger.js';
import { readBoundedBody } from './response.js';

/*
 * Per-namespace classification policy + backend capability cache. One file per namespace
 * sha256(api_identity, owner_hash, profile?) under the evidence dir; the name never matches the
 * record or verdict patterns, so session sweeps never touch it. Never throws to callers, never logs
 * credentials or organization names.
 * Backend contract (read-only peek, ingest-routing worktree): GET /v1/analytics/cli-analytics/classification-policy
 * -> 200 {"organizations": string[], "version": string}.
 */

export const POLICY_PATH = '/v1/analytics/cli-analytics/classification-policy';
export const POLICY_USABLE_MS = 24 * 3_600_000;
export const BACKOFF_MS = 5 * 60_000;
export const LEGACY_REPROBE_MS = 3_600_000;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10_000;

export type Capability = 'evidence' | 'legacy' | 'unknown';

export interface NamespaceId {
  api_identity: string;
  owner_hash: string;
  profile?: string;
}

interface CacheFile extends NamespaceId {
  schema: 1;
  capability: Capability;
  policy?: Policy;
  fetchedAt?: number;
  probedAt?: number;
  backoffUntil?: number;
}

export interface PolicyState {
  policy: Policy | null; // only when usable
  capability: Capability;
  usable: boolean;
  backoffUntil?: number;
  /** Caller should call refreshPolicy now (no usable policy, backoff over, legacy re-probe due). */
  refreshDue: boolean;
}

export interface PolicyOpts {
  now?: number;
  fetchImpl?: typeof fetch;
}

export interface RefreshInput extends PolicyOpts {
  /** Analytics base URL (daemon targetUrl/url, as forwarder.resolveBaseUrl). */
  baseUrl: string;
  /** Auth headers (as forwarder.buildAuthHeadersFromCreds); empty/null = unauthenticated. */
  headers: Record<string, string> | null;
  /** Bypass the 5 min backoff (e.g. 409 stale_policy). */
  force?: boolean;
}

export function namespaceKey(id: NamespaceId): string {
  const h = createHash('sha256');
  for (const p of [id.api_identity, id.owner_hash, id.profile ?? '']) h.update(`${p.length}:${p}|`);
  return h.digest('hex');
}

const fileOf = (id: NamespaceId) => join(evidenceDir(), `${namespaceKey(id)}.policy.json`);

function validPolicy(v: unknown): Policy | null {
  if (!v || typeof v !== 'object') return null;
  const { organizations, version } = v as Record<string, unknown>;
  if (typeof version !== 'string' || !version || version.length > 128) return null;
  if (!Array.isArray(organizations) || organizations.length > 10_000) return null;
  if (!organizations.every((o) => typeof o === 'string' && o.length <= 256)) return null;
  return { organizations: organizations as string[], version };
}

async function load(id: NamespaceId): Promise<CacheFile | null> {
  try {
    const c = JSON.parse(await readFile(fileOf(id), 'utf-8')) as CacheFile;
    if (c.schema !== 1 || c.api_identity !== id.api_identity || c.owner_hash !== id.owner_hash) return null;
    if ((c.profile ?? '') !== (id.profile ?? '')) return null; // stored identity mismatch => ignored
    if (!['evidence', 'legacy', 'unknown'].includes(c.capability)) return null;
    const policy = c.policy === undefined ? undefined : validPolicy(c.policy);
    if (c.policy !== undefined && !policy) return null;
    return { ...c, policy: policy ?? undefined };
  } catch {
    return null;
  }
}

export async function getPolicyState(id: NamespaceId, opts: PolicyOpts = {}): Promise<PolicyState> {
  const now = opts.now ?? Date.now();
  const c = await load(id);
  if (!c) return { policy: null, capability: 'unknown', usable: false, refreshDue: true };
  const usable = !!c.policy && c.fetchedAt !== undefined && now - c.fetchedAt >= 0 && now - c.fetchedAt < POLICY_USABLE_MS;
  const inBackoff = c.backoffUntil !== undefined && now < c.backoffUntil;
  const legacyWait = c.capability === 'legacy' && c.probedAt !== undefined && now - c.probedAt < LEGACY_REPROBE_MS;
  return {
    policy: usable ? c.policy! : null,
    capability: c.capability,
    usable,
    backoffUntil: inBackoff ? c.backoffUntil : undefined,
    refreshDue: !usable && !inBackoff && !legacyWait,
  };
}

type Outcome =
  | { kind: 'ok'; policy: Policy }
  | { kind: 'legacy' }
  | { kind: 'unknown' };

async function probe(input: RefreshInput): Promise<Outcome> {
  const authed = !!input.headers && Object.keys(input.headers).length > 0;
  try {
    const url = `${input.baseUrl.replace(/\/+$/, '')}${POLICY_PATH}`;
    const res = await (input.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { ...(input.headers ?? {}), Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return authed ? { kind: 'legacy' } : { kind: 'unknown' };
    if (res.status !== 200) return { kind: 'unknown' };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) return { kind: 'unknown' };
    const body = await readBoundedBody(res, MAX_BODY);
    if (body.state !== 'complete') return { kind: 'unknown' };
    const policy = validPolicy(JSON.parse(body.bytes.toString('utf-8')));
    return policy ? { kind: 'ok', policy } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' }; // timeout, network, non-JSON
  }
}

/** Fetch + persist. Honors backoff / legacy re-probe wait unless `force`. Never throws. */
export async function refreshPolicy(id: NamespaceId, input: RefreshInput): Promise<PolicyState> {
  const now = input.now ?? Date.now();
  try {
    const prev = await load(id);
    if (!input.force && prev) {
      if (prev.backoffUntil !== undefined && now < prev.backoffUntil) return getPolicyState(id, { now });
      if (prev.capability === 'legacy' && prev.probedAt !== undefined && now - prev.probedAt < LEGACY_REPROBE_MS) {
        return getPolicyState(id, { now });
      }
    }
    const out = await probe(input);
    const base = { schema: 1 as const, api_identity: id.api_identity, owner_hash: id.owner_hash, ...(id.profile ? { profile: id.profile } : {}) };
    let next: CacheFile;
    if (out.kind === 'ok') {
      next = { ...base, capability: 'evidence', policy: out.policy, fetchedAt: now };
    } else if (out.kind === 'legacy') {
      next = { ...base, capability: 'legacy', probedAt: now, backoffUntil: now + BACKOFF_MS };
    } else {
      // A previous 'evidence' stays through unknown outcomes (policy ages out at 24h on its own).
      next = {
        ...base,
        capability: prev?.capability === 'evidence' ? 'evidence' : 'unknown',
        ...(prev?.policy ? { policy: prev.policy, fetchedAt: prev.fetchedAt } : {}),
        backoffUntil: now + BACKOFF_MS,
      };
    }
    await mkdir(evidenceDir(), { recursive: true });
    await atomicReplace(fileOf(id), JSON.stringify(next));
  } catch (err) {
    logger.debug(`[policy-cache] refresh failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  return getPolicyState(id, { now });
}
