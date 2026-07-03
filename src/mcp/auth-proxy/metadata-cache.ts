/**
 * MCP Auth Proxy — per-route upstream OAuth metadata discovery + TTL cache.
 *
 * Discovery chain per the MCP Authorization spec (rev 2025-11-25): upstream PRM
 * (path-aware well-known, then root, plus any resource_metadata URL captured from a live
 * upstream 401), then AS metadata from the PRM's first authorization server, trying the
 * spec's well-known variants in priority order (RFC 8414 path-insertion → OIDC
 * path-insertion → OIDC path-appending). Positive TTL 300 s; failures negative-cached
 * 10 s so a degraded route retries quickly without hammering the upstream. Route
 * failures are fully isolated — one degraded route never affects another.
 */
import { CodeMieError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { JsonObject, RouteConfig, RouteStatus, UpstreamMetadata } from './types.js';

export const METADATA_TTL_MS = 300_000;
export const NEGATIVE_TTL_MS = 10_000;

export class MetadataDiscoveryError extends CodeMieError {
  constructor(routeId: string, reason: string) {
    super(`Metadata discovery failed for route "${routeId}": ${reason}`);
    this.name = 'MetadataDiscoveryError';
  }
}

export type FetchJson = (url: string) => Promise<JsonObject>;

interface CacheEntry {
  metadata: UpstreamMetadata;
  expiresAt: number;
}

interface FailureEntry {
  reason: string;
  expiresAt: number;
}

export class MetadataCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly prmUrlHints = new Map<string, string>();

  constructor(private readonly fetchJson: FetchJson) {}

  /**
   * R2: remember a resource_metadata URL observed on a live upstream 401.
   * SSRF guard: only https hints on the configured upstream's host are accepted —
   * anything else is ignored and discovery falls back to the well-known probes.
   */
  notePrmUrl(routeId: string, url: string, upstreamUrl: string): void {
    try {
      const hint = new URL(url);
      if (hint.protocol !== 'https:' || hint.host !== new URL(upstreamUrl).host) {
        logger.debug(
          `[mcp-auth-proxy] Route "${routeId}": ignoring resource_metadata hint on host "${hint.host}" — not https on the upstream host`
        );
        return;
      }
      this.prmUrlHints.set(routeId, url);
    } catch {
      // Malformed hint — ignore.
    }
  }

  getStatus(routeId: string): RouteStatus {
    if (this.entries.has(routeId)) {
      return 'ok';
    }
    const failure = this.failures.get(routeId);
    if (failure !== undefined && failure.expiresAt > Date.now()) {
      return 'degraded';
    }
    return 'unknown';
  }

  async getMetadata(routeId: string, route: RouteConfig): Promise<UpstreamMetadata> {
    const cached = this.entries.get(routeId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }
    if (cached !== undefined) {
      this.entries.delete(routeId);
    }

    const failure = this.failures.get(routeId);
    if (failure !== undefined && failure.expiresAt > Date.now()) {
      throw new MetadataDiscoveryError(routeId, failure.reason);
    }

    try {
      const metadata = await this.discover(routeId, route);
      this.entries.set(routeId, { metadata, expiresAt: Date.now() + METADATA_TTL_MS });
      this.failures.delete(routeId);
      return metadata;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.failures.set(routeId, { reason, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      throw error instanceof MetadataDiscoveryError
        ? error
        : new MetadataDiscoveryError(routeId, reason);
    }
  }

  private async discover(routeId: string, route: RouteConfig): Promise<UpstreamMetadata> {
    const upstream = new URL(route.upstreamUrl);
    const upstreamPath = upstream.pathname.replace(/\/+$/, '');

    const prmCandidates: string[] = [];
    const hint = this.prmUrlHints.get(routeId);
    if (hint !== undefined) {
      prmCandidates.push(hint);
    }
    if (upstreamPath !== '' && upstreamPath !== '/') {
      prmCandidates.push(`${upstream.origin}/.well-known/oauth-protected-resource${upstreamPath}`);
    }
    prmCandidates.push(`${upstream.origin}/.well-known/oauth-protected-resource`);

    const prm = await this.firstJson(prmCandidates, routeId, 'protected resource metadata');

    const authServers = prm.authorization_servers;
    if (!Array.isArray(authServers) || authServers.length === 0 || typeof authServers[0] !== 'string') {
      throw new MetadataDiscoveryError(routeId, 'upstream PRM has no authorization_servers');
    }
    if (authServers.length > 1) {
      logger.warn(
        `[mcp-auth-proxy] Route "${routeId}": upstream lists ${authServers.length} authorization servers; using the first (v1 limitation)`
      );
    }

    const issuer = new URL(authServers[0]);
    const issuerPath = issuer.pathname.replace(/\/+$/, '');
    const asCandidates =
      issuerPath !== '' && issuerPath !== '/'
        ? [
            `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
            `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
            `${issuer.origin}${issuerPath}/.well-known/openid-configuration`,
          ]
        : [
            `${issuer.origin}/.well-known/oauth-authorization-server`,
            `${issuer.origin}/.well-known/openid-configuration`,
          ];

    const asMetadata = await this.firstJson(asCandidates, routeId, 'authorization server metadata');

    const registrationEndpoint = asMetadata.registration_endpoint;
    if (typeof registrationEndpoint !== 'string' || registrationEndpoint.length === 0) {
      throw new MetadataDiscoveryError(
        routeId,
        'upstream AS advertises no registration_endpoint — DCR is mandatory for this proxy'
      );
    }
    const authorizationEndpoint = asMetadata.authorization_endpoint;
    const tokenEndpoint = asMetadata.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new MetadataDiscoveryError(
        routeId,
        'upstream AS metadata lacks authorization_endpoint/token_endpoint'
      );
    }

    const upstreamResource =
      typeof prm.resource === 'string' && prm.resource.length > 0
        ? prm.resource.replace(/\/+$/, '')
        : route.upstreamUrl.replace(/\/+$/, '');

    return {
      prm,
      asMetadata,
      upstreamResource,
      registrationEndpoint,
      authorizationEndpoint,
      tokenEndpoint,
      ...(typeof asMetadata.revocation_endpoint === 'string'
        ? { revocationEndpoint: asMetadata.revocation_endpoint }
        : {}),
    };
  }

  private async firstJson(candidates: string[], routeId: string, what: string): Promise<JsonObject> {
    let lastError = 'no candidate URLs';
    for (const candidate of candidates) {
      try {
        return await this.fetchJson(candidate);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new MetadataDiscoveryError(routeId, `could not fetch ${what}: ${lastError}`);
  }
}
