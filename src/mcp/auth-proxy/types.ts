/**
 * MCP Auth Proxy — shared types.
 *
 * See docs/SPEC-mcp-auth-proxy.md (authoritative spec) and
 * docs/superpowers/specs/2026-07-03-mcp-auth-proxy-design.md (design decisions D1–D8).
 */

export type JsonObject = Record<string, unknown>;

export interface RouteConfig {
  /** Canonical upstream MCP endpoint (https:// only; stored without trailing slash). */
  upstreamUrl: string;
  /** DCR client_name override; absent = pass through (R4). */
  clientName?: string;
  /** Scope override applied at every rewrite point (R1–R6); absent = pass through. */
  scopes?: string[];
}

export interface AuthProxyConfig {
  port: number;
  /** Serve the loopback listener over HTTPS with the locally-generated CA (default false). */
  tls: boolean;
  servers: Record<string, RouteConfig>;
}

export interface AuthProxyDaemonState {
  pid: number;
  port: number;
  routes: string[];
  startedAt: string;
  /** True when the daemon listener speaks HTTPS (absent in pre-TLS state files = false). */
  tls?: boolean;
}

export type RouteStatus = 'ok' | 'degraded' | 'unknown';

export interface UpstreamMetadata {
  /** Upstream Protected Resource Metadata document (RFC 9728), verbatim. */
  prm: JsonObject;
  /** Upstream Authorization Server metadata document (RFC 8414 / OIDC), verbatim. */
  asMetadata: JsonObject;
  /** Upstream canonical resource URI for RFC 8707 rewrites (no trailing slash). */
  upstreamResource: string;
  registrationEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface RewriteResult<T> {
  value: T;
  /** Names of rewritten fields — safe to log (names only, never values). */
  rewrote: string[];
}

export interface RewriteContext {
  /** e.g. `http://127.0.0.1:42800` (no trailing slash). */
  proxyOrigin: string;
  routeId: string;
  scopes?: string[];
}
