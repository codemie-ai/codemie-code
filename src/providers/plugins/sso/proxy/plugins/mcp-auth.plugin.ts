/**
 * MCP Authorization Proxy Plugin
 * Priority: 3 (runs before endpoint blocker, auth, and all other plugins)
 *
 * Proxies the MCP OAuth authorization flow so that:
 * 1. All auth traffic is routed through the CodeMie proxy
 * 2. `client_name` is replaced with MCP_CLIENT_NAME env var (default "CodeMie CLI") in dynamic client registration
 *
 * URL scheme:
 * - /mcp_auth?original=<url>                          → Initial MCP connection
 * - /mcp_relay/<root_b64>/<relay_b64>/<path>          → Relayed requests (per-flow scoped)
 *
 * The root_b64 segment carries the root MCP server origin for per-flow isolation.
 * The relay_b64 segment identifies the actual target origin (may differ from root
 * when the auth server is on a separate host).
 *
 * Response URL rewriting replaces external URLs with proxy relay URLs so that
 * the MCP client (Claude Code CLI) routes all subsequent requests through the proxy.
 *
 * Security:
 * - SSRF protection: private/loopback origins are rejected (hostname + DNS resolution)
 * - Per-flow origin scoping: discovered origins are tagged with their root MCP server
 *   origin and relay requests validate the root-relay association
 * - Buffering is restricted to auth metadata responses; post-auth MCP traffic streams through
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { lookup } from 'dns/promises';
import { gunzip, inflate, brotliDecompress } from 'zlib';
import { promisify } from 'util';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';
import { getMcpClientName } from '../../../../../mcp/constants.js';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

// ─── URL Utilities ───────────────────────────────────────────────────────────

/** Base64url encode (RFC 4648 §5): URL-safe, no padding */
function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Base64url decode */
function base64urlDecode(encoded: string): string {
  // Restore standard base64
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  // Re-add padding
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Extract origin (scheme + host + port) from a URL string */
function getOrigin(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin; // e.g. "https://example.com" or "https://example.com:8443"
  } catch {
    return '';
  }
}

/** Check if a string looks like an absolute HTTP(S) URL */
function isAbsoluteUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

// JSON field names whose values are token audience identifiers, NOT URLs to access.
// These must not be rewritten by the generic URL rewriter.
// Note: 'resource' is handled separately in rewriteJsonValue — it gets special
// bidirectional rewriting (to proxy URL in responses, back to original in requests).
const SKIP_REWRITE_FIELDS = new Set([
  'aud', 'audience', 'redirect_uri', 'redirect_uris',
  'issuer',  // OIDC issuer — rewriting breaks token issuer validation
]);

// Auth server metadata fields whose URLs are browser-facing and must NOT be rewritten.
// The browser must navigate directly to the real auth server for login flows because:
// - Cookies/sessions are domain-scoped (won't work through localhost proxy)
// - SAML/OIDC federation redirects require the real auth server domain
// - The auth server's HTML/JS pages reference its own origin
// Programmatic endpoints (token_endpoint, registration_endpoint) ARE rewritten.
const BROWSER_FACING_FIELDS = new Set([
  'authorization_endpoint',
  'end_session_endpoint',
]);

// Max response body size for buffered MCP auth responses (1MB).
// Auth metadata payloads are typically 1-10KB. This prevents OOM from
// malicious or misconfigured upstreams.
const MAX_RESPONSE_SIZE = 1024 * 1024;

// Max number of discovered origins to prevent Set explosion from malicious responses.
// A normal MCP auth flow discovers 2-3 origins (MCP server + auth server).
const MAX_KNOWN_ORIGINS = 50;

// Max number of distinct MCP server origins accepted via /mcp_auth.
// Bounds the SSRF surface: the proxy is localhost-only but this prevents
// unbounded use as a generic forwarder. A typical setup has 1-3 MCP servers.
const MAX_MCP_SERVER_ORIGINS = 10;

// TTL for discovered origins in milliseconds (30 minutes).
// Bounds the window during which cross-flow origin leakage can occur.
// Refreshed on each access, so active flows keep their origins alive.
const ORIGIN_TTL_MS = 30 * 60 * 1000;

/**
 * Check if a URL origin points to a private, loopback, or link-local network.
 * Prevents SSRF through malicious auth server metadata that advertises internal hosts.
 */
function isPrivateOrLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    // Loopback
    if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;

    // IPv4 ranges
    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
      const [a, b] = parts.map(Number);
      if (a === 127) return true;                       // 127.0.0.0/8 loopback
      if (a === 10) return true;                        // 10.0.0.0/8 private
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
      if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
      if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local
      if (a === 0) return true;                         // 0.0.0.0/8
    }

    // IPv6 (may be bracketed in URL hostnames)
    const ipv6 = hostname.replace(/^\[|\]$/g, '');
    if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true; // fc00::/7 ULA
    if (ipv6.startsWith('fe80')) return true;                        // fe80::/10 link-local

    return false;
  } catch {
    return true; // Can't parse — reject to be safe
  }
}

/**
 * Check if a resolved IP address is in a private, loopback, or link-local range.
 * Used for DNS resolution SSRF validation (catches DNS rebinding attacks where
 * a public hostname resolves to an internal IP).
 */
function isPrivateOrLoopbackIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const ipv4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) {
    return isPrivateOrLoopbackIP(ipv4Mapped[1]);
  }

  // IPv4
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true;                       // 127.0.0.0/8 loopback
    if (a === 10) return true;                        // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local
    if (a === 0) return true;                         // 0.0.0.0/8
  }

  // IPv6
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80')) return true; // Link-local

  return false;
}

/**
 * Resolve a hostname via DNS and check if it points to a private/loopback IP.
 * Defense-in-depth against DNS rebinding SSRF attacks.
 *
 * Note: There is an inherent TOCTOU window between this check and the actual
 * HTTP connection (the hostname could re-resolve differently). This is mitigated
 * by OS-level DNS caching and the short interval between check and connect.
 */
async function resolvesToPrivateIP(hostname: string): Promise<boolean> {
  // Skip DNS resolution for IP literals — already checked by isPrivateOrLoopbackOrigin
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return false;
  }
  try {
    const { address } = await lookup(hostname);
    return isPrivateOrLoopbackIP(address);
  } catch {
    // DNS resolution failed — let the HTTP client handle the error naturally
    return false;
  }
}

/**
 * Normalize a URL to origin + pathname (lowercased) for endpoint comparison.
 * Strips query params so that `https://auth/register?foo=1` matches `https://auth/register`.
 */
function normalizeEndpointUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.origin + parsed.pathname).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// Query parameter names that may contain sensitive auth data and must be masked in logs.
const SENSITIVE_QUERY_PARAMS = new Set([
  'code', 'state', 'token', 'access_token', 'refresh_token',
  'id_token', 'session_state', 'client_secret',
]);

/**
 * Mask sensitive query parameter values in a URL for safe logging.
 * Handles nested URLs: if a parameter value itself contains a URL with
 * sensitive params (e.g., original=https://idp/callback?code=abc&state=xyz),
 * those nested values are also masked.
 */
function sanitizeUrlForLog(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const basePath = url.slice(0, queryStart);
  const queryString = url.slice(queryStart + 1);

  const sanitizedParams = queryString.split('&').map(param => {
    const eqIdx = param.indexOf('=');
    if (eqIdx === -1) return param;
    const key = param.slice(0, eqIdx).toLowerCase();
    if (SENSITIVE_QUERY_PARAMS.has(key)) {
      return `${param.slice(0, eqIdx)}=***`;
    }
    // Recursively sanitize nested URLs in parameter values
    const value = param.slice(eqIdx + 1);
    if (isAbsoluteUrl(value) || isAbsoluteUrl(decodeURIComponentSafe(value))) {
      const sanitizedValue = sanitizeUrlForLog(decodeURIComponentSafe(value));
      return `${param.slice(0, eqIdx)}=${sanitizedValue}`;
    }
    return param;
  });

  return `${basePath}?${sanitizedParams.join('&')}`;
}

/** Safe decodeURIComponent that returns the input on failure */
function decodeURIComponentSafe(str: string): string {
  try { return decodeURIComponent(str); } catch { return str; }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export class MCPAuthPlugin implements ProxyPlugin {
  id = '@codemie/proxy-mcp-auth';
  name = 'MCP Auth Proxy';
  version = '1.0.0';
  priority = 3; // Before endpoint blocker (5) and auth (10)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    return new MCPAuthInterceptor(context);
  }
}

// ─── Origin Entry ───────────────────────────────────────────────────────────

interface KnownOriginEntry {
  /** Last-access timestamp for TTL-based expiration */
  timestamp: number;
  /** Root MCP server origins that discovered this origin (per-flow scoping) */
  rootOrigins: Set<string>;
}

// ─── Interceptor ─────────────────────────────────────────────────────────────

class MCPAuthInterceptor implements ProxyInterceptor {
  name = 'mcp-auth';

  /** Proxy's own base URL, set on first MCP auth request */
  private proxyBaseUrl: string | null = null;

  /**
   * Known external origins discovered from auth metadata responses.
   * Map from origin → entry with TTL and per-flow root origin scoping.
   * Origins are ONLY added through validated auth flow responses (WWW-Authenticate,
   * auth server metadata, Location redirects) — never from caller-supplied URLs.
   * Private/loopback origins are rejected to prevent SSRF.
   *
   * Per-flow scoping: each discovered origin is tagged with the root MCP server
   * origin it was discovered from. Relay requests validate that the relay origin
   * was discovered from the root origin carried in the URL. This prevents
   * cross-flow origin leakage (flow A's discovered origins are not usable by flow B).
   */
  private knownOrigins = new Map<string, KnownOriginEntry>();

  /**
   * Normalized URLs (origin+pathname) of discovered registration endpoints.
   * Used to match client_name replacement targets beyond the /register path heuristic.
   */
  private discoveredRegistrationEndpoints = new Set<string>();

  /**
   * Normalized URLs (origin+pathname) of all discovered auth endpoints
   * (token, registration, authorization, jwks, etc.).
   * Used for buffering decisions in isAuthMetadataResponse beyond path heuristics.
   */
  private discoveredAuthEndpoints = new Set<string>();

  /**
   * Distinct MCP server origins accessed via /mcp_auth.
   * Bounded by MAX_MCP_SERVER_ORIGINS to prevent unbounded use as a generic forwarder.
   */
  private mcpServerOrigins = new Set<string>();

  /**
   * Mapping from original MCP server URLs to their proxy /mcp_auth URLs.
   * Used for bidirectional 'resource' field rewriting:
   * - Response: resource "https://real-server/path" → "http://localhost:PORT/mcp_auth?original=https://real-server/path"
   * - Request: reverse mapping before forwarding to auth server
   * This is needed because the MCP SDK validates that the resource metadata's
   * 'resource' field matches the URL the client originally connected to.
   */
  private mcpUrlMapping = new Map<string, string>();

  constructor(private pluginContext: PluginContext) {}

  async onProxyStop(): Promise<void> {
    this.proxyBaseUrl = null;
    this.knownOrigins.clear();
    this.mcpServerOrigins.clear();
    this.mcpUrlMapping.clear();
    this.discoveredRegistrationEndpoints.clear();
    this.discoveredAuthEndpoints.clear();
  }

  /**
   * Check if an origin is known, not expired, and (optionally) associated with a
   * specific root MCP server origin. Refreshes TTL on access.
   */
  private isKnownOrigin(origin: string, rootOrigin?: string): boolean {
    const entry = this.knownOrigins.get(origin);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > ORIGIN_TTL_MS) {
      this.knownOrigins.delete(origin);
      logger.debug(`[${this.name}] Origin expired and removed: ${origin}`);
      return false;
    }
    // Per-flow validation: if rootOrigin specified, verify association
    if (rootOrigin && !entry.rootOrigins.has(rootOrigin)) {
      logger.debug(`[${this.name}] Origin ${origin} not associated with root ${rootOrigin}`);
      return false;
    }
    entry.timestamp = Date.now(); // Refresh on access
    return true;
  }

  /**
   * Add a discovered origin with private-network validation, TTL, and root tagging.
   * If the origin already exists, adds the rootOrigin to its set and refreshes TTL.
   */
  private addKnownOrigin(origin: string, rootOrigin: string): boolean {
    const existing = this.knownOrigins.get(origin);
    if (existing) {
      existing.timestamp = Date.now();
      existing.rootOrigins.add(rootOrigin);
      return true;
    }
    if (isPrivateOrLoopbackOrigin(origin)) {
      logger.debug(`[${this.name}] Rejected private/loopback origin: ${origin}`);
      return false;
    }
    // Sweep expired entries before checking capacity so stale origins
    // don't prevent legitimate new origins from being added.
    if (this.knownOrigins.size >= MAX_KNOWN_ORIGINS) {
      this.sweepExpiredOrigins();
    }
    if (this.knownOrigins.size >= MAX_KNOWN_ORIGINS) return false;
    this.knownOrigins.set(origin, {
      timestamp: Date.now(),
      rootOrigins: new Set([rootOrigin]),
    });
    return true;
  }

  /** Remove all expired origins from the map. */
  private sweepExpiredOrigins(): void {
    const now = Date.now();
    for (const [origin, entry] of this.knownOrigins) {
      if (now - entry.timestamp > ORIGIN_TTL_MS) {
        this.knownOrigins.delete(origin);
        logger.debug(`[${this.name}] Swept expired origin: ${origin}`);
      }
    }
  }

  /**
   * Handle MCP auth requests directly, bypassing normal proxy flow.
   * Returns true if the request was handled (path matched /mcp_auth or /mcp_relay).
   *
   * Why this bypasses the standard pipeline:
   * MCP auth traffic routes to MCP/auth servers (not LLM APIs), so the standard
   * proxy plugins (endpoint blocker, auth injection, request sanitizer) do not apply.
   * This plugin implements its own SSRF protection, origin validation, and logging.
   */
  async handleRequest(
    context: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    const url = context.url; // e.g. "/mcp_auth?original=..." or "/mcp_relay/root/relay/path"

    // Route 1: Initial MCP connection (exact path boundary: /mcp_auth or /mcp_auth?...)
    if (url === '/mcp_auth' || url.startsWith('/mcp_auth?')) {
      const safeUrl = sanitizeUrlForLog(url);
      logger.info(`[${this.name}] ${context.method} ${safeUrl} [${context.requestId}]`);
      const startTime = Date.now();
      await this.handleMCPAuth(context, res, httpClient);
      logger.info(`[${this.name}] ${context.method} ${safeUrl} → ${res.statusCode} (${Date.now() - startTime}ms) [${context.requestId}]`);
      return true;
    }

    // Route 2: Relayed request to external host
    if (url.startsWith('/mcp_relay/')) {
      const safeUrl = sanitizeUrlForLog(url);
      logger.info(`[${this.name}] ${context.method} ${safeUrl} [${context.requestId}]`);
      const startTime = Date.now();
      await this.handleMCPRelay(context, res, httpClient);
      logger.info(`[${this.name}] ${context.method} ${safeUrl} → ${res.statusCode} (${Date.now() - startTime}ms) [${context.requestId}]`);
      return true;
    }

    // Route 3: RFC 8414 well-known URLs constructed over mcp_relay paths.
    // OAuth SDKs construct well-known URLs by inserting .well-known at the URL root:
    //   /.well-known/<type>/mcp_relay/<root>/<relay>/<issuer_path>
    // Rewrite to relay form so handleMCPRelay processes it:
    //   /mcp_relay/<root>/<relay>/.well-known/<type>/<issuer_path>
    if (url.startsWith('/.well-known/') && url.includes('/mcp_relay/')) {
      const mcpRelayIdx = url.indexOf('/mcp_relay/');
      const wellKnownPart = url.slice(0, mcpRelayIdx); // e.g. "/.well-known/oauth-authorization-server"
      const relaySegment = url.slice(mcpRelayIdx + '/mcp_relay/'.length); // <root>/<relay>/<issuer_path>[?query]

      // Extract root and relay segments, then reconstruct
      const firstSlash = relaySegment.indexOf('/');
      if (firstSlash !== -1) {
        const rootEnc = relaySegment.slice(0, firstSlash);
        const afterRoot = relaySegment.slice(firstSlash + 1);
        const secondSlash = afterRoot.indexOf('/');
        const secondQuery = afterRoot.indexOf('?');
        const secondSep = secondSlash === -1 ? secondQuery
          : secondQuery === -1 ? secondSlash
          : Math.min(secondSlash, secondQuery);

        const relayEnc = secondSep === -1 ? afterRoot : afterRoot.slice(0, secondSep);
        const issuerRest = secondSep === -1 ? '' : afterRoot.slice(secondSep); // e.g. "/keycloak_prod/..."

        // Reconstruct: /mcp_relay/<root>/<relay>/.well-known/<type>/<issuer_path>
        const rewrittenUrl = `/mcp_relay/${rootEnc}/${relayEnc}${wellKnownPart}${issuerRest}`;
        logger.debug(`[${this.name}] RFC 8414 well-known rewrite: ${url} → ${rewrittenUrl}`);

        context.url = rewrittenUrl;
        const safeUrl = sanitizeUrlForLog(rewrittenUrl);
        logger.info(`[${this.name}] ${context.method} ${safeUrl} [${context.requestId}]`);
        const startTime = Date.now();
        await this.handleMCPRelay(context, res, httpClient);
        logger.info(`[${this.name}] ${context.method} ${safeUrl} → ${res.statusCode} (${Date.now() - startTime}ms) [${context.requestId}]`);
        return true;
      }
    }

    // Not an MCP auth request — let normal proxy flow handle it
    return false;
  }

  // ─── Route Handlers ──────────────────────────────────────────────────────

  /**
   * Handle /mcp_auth?original=<url>
   * Extracts the real MCP server URL and forwards the request.
   */
  private async handleMCPAuth(
    context: ProxyContext,
    res: ServerResponse,
    httpClient: ProxyHTTPClient
  ): Promise<void> {
    // Set proxy base URL on first request
    if (!this.proxyBaseUrl) {
      const proxyPort = this.pluginContext.config.port;
      this.proxyBaseUrl = `http://localhost:${proxyPort}`;
    }

    // Extract original URL from query string
    const originalUrl = this.extractOriginalUrl(context.url);
    logger.debug(`[${this.name}] Extracted originalUrl: ${originalUrl}`);
    if (!originalUrl) {
      this.sendError(res, 400, 'Missing or invalid "original" query parameter');
      return;
    }

    // SSRF check: reject private/loopback targets in the original URL.
    const origin = getOrigin(originalUrl);
    logger.debug(`[${this.name}] Original origin: ${origin}`);
    if (isPrivateOrLoopbackOrigin(originalUrl)) {
      this.sendError(res, 403, 'SSRF blocked: original URL points to private/loopback network');
      return;
    }

    // Track and cap distinct MCP server origins to prevent use as a generic forwarder.
    // The /mcp_auth path must forward to arbitrary user-configured URLs (by design),
    // but we bound the number of distinct origins to limit SSRF surface.
    if (origin && !this.mcpServerOrigins.has(origin)) {
      if (this.mcpServerOrigins.size >= MAX_MCP_SERVER_ORIGINS) {
        this.sendError(res, 403, `MCP server origin limit reached (${MAX_MCP_SERVER_ORIGINS}). Cannot forward to new origins.`);
        return;
      }
      this.mcpServerOrigins.add(origin);
      logger.debug(`[${this.name}] Registered MCP server origin: ${origin} (${this.mcpServerOrigins.size}/${MAX_MCP_SERVER_ORIGINS})`);
    }

    // The root origin is the MCP server's origin — used for per-flow origin scoping
    const rootOrigin = origin || '';

    // Store mapping for bidirectional 'resource' field rewriting.
    // The MCP SDK validates resource metadata's 'resource' field against the connected URL.
    const proxyUrl = `${this.proxyBaseUrl}/mcp_auth?original=${originalUrl}`;
    this.mcpUrlMapping.set(originalUrl, proxyUrl);
    logger.debug(`[${this.name}] Stored resource mapping: "${originalUrl}" → "${proxyUrl}"`);

    logger.debug(`[${this.name}] Initial MCP auth request → ${originalUrl} [rootOrigin=${rootOrigin}]`);

    await this.forwardAndRewrite(context, res, httpClient, originalUrl, rootOrigin);
  }

  /**
   * Handle /mcp_relay/<root_b64>/<relay_b64>/<path>
   * Decodes both origins, validates the root-relay association, and forwards.
   *
   * URL scheme: /mcp_relay/<encoded_root_origin>/<encoded_relay_origin>/<rest_of_path>
   * The root origin identifies which MCP flow this relay belongs to.
   * The relay origin is the actual target host (may differ from root for auth servers).
   */
  private async handleMCPRelay(
    context: ProxyContext,
    res: ServerResponse,
    httpClient: ProxyHTTPClient
  ): Promise<void> {
    // Parse: /mcp_relay/<encoded_root>/<encoded_relay>/<rest>
    const withoutPrefix = context.url.slice('/mcp_relay/'.length);

    // Find first slash — separates encoded_root from encoded_relay
    const firstSlash = withoutPrefix.indexOf('/');
    if (firstSlash === -1) {
      this.sendError(res, 400, 'Invalid /mcp_relay path: missing relay origin segment');
      return;
    }

    const encodedRoot = withoutPrefix.slice(0, firstSlash);
    const afterRoot = withoutPrefix.slice(firstSlash + 1);

    // Find second separator (/ or ?) — separates encoded_relay from path
    const secondSlash = afterRoot.indexOf('/');
    const queryIdx = afterRoot.indexOf('?');
    const secondSep = secondSlash === -1 ? queryIdx
      : queryIdx === -1 ? secondSlash
      : Math.min(secondSlash, queryIdx);

    let encodedRelay: string;
    let pathAndQuery: string;

    if (secondSep === -1) {
      encodedRelay = afterRoot;
      pathAndQuery = '/';
    } else if (afterRoot[secondSep] === '?') {
      // Query directly on root: /mcp_relay/<root>/<relay>?x=1 → origin + /?x=1
      encodedRelay = afterRoot.slice(0, secondSep);
      pathAndQuery = '/' + afterRoot.slice(secondSep); // → /?x=1
    } else {
      encodedRelay = afterRoot.slice(0, secondSep);
      pathAndQuery = afterRoot.slice(secondSep); // includes leading /
    }

    let decodedRoot: string;
    let decodedRelay: string;
    try {
      decodedRoot = base64urlDecode(encodedRoot);
      decodedRelay = base64urlDecode(encodedRelay);
    } catch {
      this.sendError(res, 400, 'Invalid encoded origin in /mcp_relay path');
      return;
    }

    logger.debug(`[${this.name}] Relay parsed: root="${decodedRoot}" relay="${decodedRelay}" pathAndQuery="${pathAndQuery}"`);

    if (!isAbsoluteUrl(decodedRoot) || !isAbsoluteUrl(decodedRelay)) {
      this.sendError(res, 400, 'Decoded origin is not a valid URL');
      return;
    }

    // Auto-register origins from relay URLs if not already known.
    // The MCP SDK may cache auth state (resource metadata URLs) across sessions.
    // When a new session starts, knownOrigins is empty but the SDK reuses cached
    // /mcp_relay/... URLs from a previous session. The URLs were generated by our
    // own proxy, so the encoded origins are trustworthy (still SSRF-checked).
    if (!this.knownOrigins.has(decodedRoot)) {
      if (!isPrivateOrLoopbackOrigin(decodedRoot)) {
        this.addKnownOrigin(decodedRoot, decodedRoot);
        this.mcpServerOrigins.add(decodedRoot);
        logger.debug(`[${this.name}] Auto-registered root origin from cached relay URL: ${decodedRoot}`);

        // Reconstruct the mcpUrlMapping for resource field rewriting.
        // We don't have the full original URL, but the proxy base URL is set.
        if (!this.proxyBaseUrl) {
          const proxyPort = this.pluginContext.config.port;
          this.proxyBaseUrl = `http://localhost:${proxyPort}`;
        }
      }
    }
    if (decodedRoot !== decodedRelay && !this.knownOrigins.has(decodedRelay)) {
      if (!isPrivateOrLoopbackOrigin(decodedRelay)) {
        this.addKnownOrigin(decodedRelay, decodedRoot);
        logger.debug(`[${this.name}] Auto-registered relay origin from cached relay URL: ${decodedRelay}`);
      }
    }

    // Per-flow validation: the relay origin must have been discovered from this root flow
    if (!this.isKnownOrigin(decodedRelay, decodedRoot)) {
      logger.debug(`[${this.name}] Origin check failed: relay="${decodedRelay}" root="${decodedRoot}" knownOrigins=${JSON.stringify([...this.knownOrigins.entries()].map(([k, v]) => ({ origin: k, roots: [...v.rootOrigins] })))}`);
      this.sendError(res, 403, 'Origin not allowed — not discovered through this MCP auth flow');
      return;
    }

    const targetUrl = decodedRelay + pathAndQuery;
    logger.debug(`[${this.name}] MCP relay request [root=${decodedRoot}] → ${targetUrl}`);

    await this.forwardAndRewrite(context, res, httpClient, targetUrl, decodedRoot);
  }

  // ─── Core: Forward + Rewrite ─────────────────────────────────────────────

  /**
   * Forward a request to the target URL.
   * - Auth metadata responses (401, .well-known, /register, /token) are buffered for URL rewriting.
   * - Everything else (authenticated MCP traffic, SSE, binary) is streamed through.
   */
  private async forwardAndRewrite(
    context: ProxyContext,
    res: ServerResponse,
    httpClient: ProxyHTTPClient,
    targetUrl: string,
    rootOrigin: string
  ): Promise<void> {
    // Modify request body if needed (client_name replacement)
    let requestBody = context.requestBody;
    const headers = { ...context.headers };

    // Strip accept-encoding so upstream returns uncompressed JSON responses.
    // Needed because the buffer path parses JSON for URL rewriting. We can't know
    // which path (buffer vs stream) until after the response arrives, so strip early.
    delete headers['accept-encoding'];

    logger.debug(`[${this.name}] forwardAndRewrite: ${context.method} ${targetUrl} [rootOrigin=${rootOrigin}]`);

    // Only rewrite client_name for POST to /register (OAuth dynamic client registration).
    // Other JSON payloads must not be mutated.
    const isRegEndpoint = this.isRegistrationEndpoint(targetUrl);
    if (requestBody && context.method === 'POST'
        && headers['content-type']?.includes('application/json')
        && isRegEndpoint) {
      logger.debug(`[${this.name}] Rewriting client_name in registration request`);
      requestBody = this.rewriteRequestBody(requestBody, headers);
    }

    // Reverse-rewrite 'resource' parameter: proxy /mcp_auth URL → original URL.
    if (requestBody && context.method === 'POST') {
      const bodyBefore = requestBody;
      requestBody = this.reverseRewriteResourceInBody(requestBody, headers);
      if (requestBody !== bodyBefore) {
        logger.debug(`[${this.name}] Reverse-rewrote resource in request body`);
      }
    }

    // DNS resolution SSRF check
    const parsedTarget = new URL(targetUrl);

    // Also reverse-rewrite 'resource' in URL query params (authorization endpoint GET)
    this.reverseRewriteResourceParam(parsedTarget);

    logger.debug(`[${this.name}] DNS check for hostname: ${parsedTarget.hostname}`);
    if (await resolvesToPrivateIP(parsedTarget.hostname)) {
      this.sendError(res, 403, 'SSRF blocked: target hostname resolves to private/loopback address');
      return;
    }

    // Forward to target
    const upstreamResponse = await httpClient.forward(parsedTarget, {
      method: context.method,
      headers,
      body: requestBody || undefined
    });

    const statusCode = upstreamResponse.statusCode || 200;
    const contentType = upstreamResponse.headers['content-type'] || '';
    const isJson = contentType.includes('application/json') || contentType.includes('text/json');
    const isAuthMeta = this.isAuthMetadataResponse(targetUrl, statusCode);
    const needsBodyRewriting = isJson && isAuthMeta;

    logger.debug(`[${this.name}] Upstream response: status=${statusCode} contentType="${contentType}" isJson=${isJson} isAuthMeta=${isAuthMeta} needsBodyRewriting=${needsBodyRewriting}`);
    logger.debug(`[${this.name}] Response headers: ${JSON.stringify(upstreamResponse.headers)}`);

    if (needsBodyRewriting) {
      await this.bufferAndRewrite(context, res, upstreamResponse, targetUrl, statusCode, rootOrigin);
    } else {
      await this.streamThrough(context, res, upstreamResponse, targetUrl, statusCode, rootOrigin);
    }
  }

  /**
   * Buffer response, rewrite URLs in body and headers, send to client.
   * Used for auth metadata responses (401, JSON) that need URL rewriting.
   */
  private async bufferAndRewrite(
    context: ProxyContext,
    res: ServerResponse,
    upstreamResponse: IncomingMessage,
    targetUrl: string,
    statusCode: number,
    rootOrigin: string
  ): Promise<void> {
    // Buffer response body (with size limit to prevent OOM)
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of upstreamResponse) {
      totalSize += chunk.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        upstreamResponse.destroy();
        this.sendError(res, 502, 'Upstream response too large for MCP auth relay');
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let responseBody: Buffer = Buffer.concat(chunks);

    // Decompress if upstream returned compressed content despite stripped accept-encoding.
    // Uses async decompression to avoid blocking the event loop.
    const contentEncoding = (upstreamResponse.headers['content-encoding'] || '').toLowerCase();
    if (contentEncoding) {
      try {
        let decompressed: Buffer | undefined;
        if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
          decompressed = await gunzipAsync(responseBody);
        } else if (contentEncoding === 'deflate') {
          decompressed = await inflateAsync(responseBody);
        } else if (contentEncoding === 'br') {
          decompressed = await brotliDecompressAsync(responseBody);
        }
        if (decompressed) {
          // Check decompressed size to prevent decompression bomb attacks
          if (decompressed.length > MAX_RESPONSE_SIZE) {
            this.sendError(res, 502, 'Decompressed upstream response too large for MCP auth relay');
            return;
          }
          responseBody = decompressed;
          // Remove content-encoding since we've decompressed
          delete upstreamResponse.headers['content-encoding'];
        }
      } catch (err) {
        logger.debug(`[${this.name}] Failed to decompress ${contentEncoding} response, passing through: ${err}`);
      }
    }

    // Rewrite URLs in response body (JSON only)
    const contentType = upstreamResponse.headers['content-type'] || '';
    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      const bodyBefore = responseBody.toString('utf-8');
      logger.debug(`[${this.name}] Response body BEFORE rewrite (${bodyBefore.length} chars): ${bodyBefore.slice(0, 2000)}`);
      responseBody = this.rewriteResponseBody(responseBody, rootOrigin);
      const bodyAfter = responseBody.toString('utf-8');
      logger.debug(`[${this.name}] Response body AFTER rewrite (${bodyAfter.length} chars): ${bodyAfter.slice(0, 2000)}`);
    }

    // Rewrite URLs in response headers
    const responseHeaders = this.rewriteResponseHeaders(upstreamResponse.headers, targetUrl, rootOrigin);
    logger.debug(`[${this.name}] Rewritten response headers: ${JSON.stringify(responseHeaders)}`);

    // Send to client
    res.statusCode = statusCode;
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (value !== undefined && !['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    // Update content-length to match rewritten body
    res.setHeader('content-length', String(responseBody.length));
    res.end(responseBody);

    logger.debug(`[${this.name}] Buffered response sent: ${statusCode}, ${responseBody.length} bytes`);
  }

  /**
   * Stream response through without buffering.
   * Used for authenticated MCP traffic (SSE, binary, large responses).
   * Only headers are rewritten (Location redirects); body is passed through as-is.
   */
  private async streamThrough(
    _context: ProxyContext,
    res: ServerResponse,
    upstreamResponse: IncomingMessage,
    targetUrl: string,
    statusCode: number,
    rootOrigin: string
  ): Promise<void> {
    // Rewrite URLs in response headers only (no body rewriting)
    logger.debug(`[${this.name}] streamThrough: status=${statusCode} targetUrl=${targetUrl}`);
    const responseHeaders = this.rewriteResponseHeaders(upstreamResponse.headers, targetUrl, rootOrigin);

    // Set status and headers
    res.statusCode = statusCode;
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (value !== undefined && !['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    // Stream body directly to client, honoring backpressure and aborting on disconnect
    let bytesSent = 0;
    let downstreamClosed = false;
    // Resolve any pending drain wait when the client disconnects
    let onClose: (() => void) | null = null;
    res.on('close', () => {
      if (!res.writableFinished) {
        downstreamClosed = true;
        upstreamResponse.destroy();
        // Unblock any pending drain await so the handler doesn't hang
        onClose?.();
      }
    });

    for await (const chunk of upstreamResponse) {
      if (downstreamClosed) break;
      const canContinue = res.write(chunk);
      bytesSent += chunk.length;
      // Honor backpressure: wait for drain OR close (whichever fires first)
      if (!canContinue && !downstreamClosed) {
        await new Promise<void>(resolve => {
          onClose = resolve;
          res.once('drain', () => { onClose = null; resolve(); });
        });
      }
    }
    if (!downstreamClosed) {
      res.end();
    }

    logger.debug(`[${this.name}] Streamed response: ${statusCode}, ${bytesSent} bytes`);
  }

  // ─── Request Body Modification ───────────────────────────────────────────

  /**
   * Replace `client_name` in JSON request bodies.
   * Uses MCP_CLIENT_NAME env var, defaults to "CodeMie CLI".
   * This targets the OAuth dynamic client registration (POST /register).
   */
  private rewriteRequestBody(body: Buffer, headers: Record<string, string>): Buffer {
    const clientName = getMcpClientName();
    try {
      const parsed = JSON.parse(body.toString('utf-8'));

      if (typeof parsed === 'object' && parsed !== null && 'client_name' in parsed) {
        parsed.client_name = clientName;
        const newBody = Buffer.from(JSON.stringify(parsed), 'utf-8');
        headers['content-length'] = String(newBody.length);
        logger.debug(`[${this.name}] Replaced client_name with "${clientName}"`);
        return newBody;
      }
    } catch {
      // Not valid JSON — pass through unchanged
    }
    return body;
  }

  // ─── Response Body URL Rewriting ─────────────────────────────────────────

  /**
   * Rewrite external URLs in a JSON response body to proxy relay URLs.
   * Discovers new origins from response content (e.g., authorization_servers).
   */
  private rewriteResponseBody(body: Buffer, rootOrigin: string): Buffer {
    if (!this.proxyBaseUrl) return body;

    try {
      const bodyStr = body.toString('utf-8');
      const parsed = JSON.parse(bodyStr);

      // First pass: discover new origins from known fields
      this.discoverOrigins(parsed, rootOrigin);

      // Second pass: rewrite URLs
      const rewritten = this.rewriteJsonValue(parsed, null, rootOrigin);
      return Buffer.from(JSON.stringify(rewritten), 'utf-8');
    } catch {
      // Not valid JSON — return unchanged
      return body;
    }
  }

  /**
   * Discover new origins from well-known JSON fields.
   * Specifically targets `authorization_servers` in protected resource metadata.
   */
  private discoverOrigins(obj: unknown, rootOrigin: string): void {
    if (typeof obj !== 'object' || obj === null) return;
    if (this.knownOrigins.size >= MAX_KNOWN_ORIGINS) return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.discoverOrigins(item, rootOrigin);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // authorization_servers: ["https://auth.example.com/realms/r1"]
    if (Array.isArray(record.authorization_servers)) {
      for (const server of record.authorization_servers) {
        if (this.knownOrigins.size >= MAX_KNOWN_ORIGINS) break;
        if (typeof server === 'string' && isAbsoluteUrl(server)) {
          const origin = getOrigin(server);
          if (origin && this.addKnownOrigin(origin, rootOrigin)) {
            logger.debug(`[${this.name}] Discovered auth server origin: ${origin} [root=${rootOrigin}]`);
          }
        }
      }
    }

    // Auth endpoint fields that may be on a different origin than the auth server.
    // e.g., token_endpoint on a CDN or registration_endpoint on a separate service.
    const endpointFields = [
      'token_endpoint', 'registration_endpoint', 'authorization_endpoint',
      'jwks_uri', 'introspection_endpoint', 'revocation_endpoint',
      'userinfo_endpoint', 'end_session_endpoint',
      'device_authorization_endpoint', 'pushed_authorization_request_endpoint',
      'backchannel_authentication_endpoint', 'registration_client_uri',
    ];
    for (const field of endpointFields) {
      if (this.knownOrigins.size >= MAX_KNOWN_ORIGINS) break;
      const value = record[field];
      if (typeof value === 'string' && isAbsoluteUrl(value)) {
        // Track origin for relay allowlisting
        const origin = getOrigin(value);
        if (origin && this.addKnownOrigin(origin, rootOrigin)) {
          logger.debug(`[${this.name}] Discovered origin from ${field}: ${origin} [root=${rootOrigin}]`);
        }
        // Track normalized endpoint URL for buffering and registration detection
        const normalized = normalizeEndpointUrl(value);
        this.discoveredAuthEndpoints.add(normalized);
        if (field === 'registration_endpoint' || field === 'registration_client_uri') {
          this.discoveredRegistrationEndpoints.add(normalized);
          logger.debug(`[${this.name}] Discovered registration endpoint: ${normalized}`);
        }
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        this.discoverOrigins(value, rootOrigin);
      }
    }
  }

  /**
   * Recursively rewrite URL strings in a JSON value.
   * Skips fields in SKIP_REWRITE_FIELDS (token audience identifiers).
   */
  private rewriteJsonValue(value: unknown, parentKey: string | null, rootOrigin: string): unknown {
    if (typeof value === 'string') {
      // Special handling: 'resource' is a token audience identifier that the MCP SDK
      // also validates against the connected URL. Map known MCP server URLs to their
      // proxy /mcp_auth URL; leave others unchanged (never rewrite as /mcp_relay).
      if (parentKey === 'resource') {
        if (isAbsoluteUrl(value)) {
          let mapped = this.mcpUrlMapping.get(value);
          // When the SDK uses cached relay URLs, mcpUrlMapping is empty because
          // handleMCPAuth never ran. Reconstruct the mapping on-the-fly: if the
          // resource value's origin is a known MCP server origin (auto-registered
          // from the cached relay URL), build the proxy URL from it.
          if (!mapped && this.proxyBaseUrl) {
            const valOrigin = getOrigin(value);
            if (valOrigin && this.mcpServerOrigins.has(valOrigin)) {
              mapped = `${this.proxyBaseUrl}/mcp_auth?original=${value}`;
              this.mcpUrlMapping.set(value, mapped);
              logger.debug(`[${this.name}] resource field: reconstructed mapping for cached session: "${value}" → "${mapped}"`);
            }
          }
          logger.debug(`[${this.name}] resource field: value="${value}" mapped=${mapped ? `"${mapped}"` : 'null (no mapping, keeping as-is)'} mappingKeys=[${[...this.mcpUrlMapping.keys()].join(', ')}]`);
          return mapped || value;
        }
        return value;
      }

      // Skip rewriting for token identifiers and browser-facing endpoints
      if (parentKey && (SKIP_REWRITE_FIELDS.has(parentKey) || BROWSER_FACING_FIELDS.has(parentKey))) {
        return value;
      }
      if (isAbsoluteUrl(value)) {
        return this.rewriteUrl(value, rootOrigin);
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.rewriteJsonValue(item, parentKey, rootOrigin));
    }

    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.rewriteJsonValue(val, key, rootOrigin);
      }
      return result;
    }

    return value;
  }

  /**
   * Rewrite an external URL to a proxy relay URL.
   * Uses the two-segment scheme: /mcp_relay/<root_b64>/<relay_b64>/<path>
   * The root segment enables per-flow origin validation in the relay handler.
   * Unknown origins are passed through unchanged.
   */
  private rewriteUrl(urlStr: string, rootOrigin: string): string {
    if (!this.proxyBaseUrl) return urlStr;

    const origin = getOrigin(urlStr);
    if (!origin) return urlStr;

    // Actively block private/loopback URLs — prevent the client from ever receiving
    // internal-network URLs that a malicious auth server might inject.
    if (isPrivateOrLoopbackOrigin(origin)) {
      logger.debug(`[${this.name}] Blocked private/loopback URL in response: ${origin}`);
      return 'urn:codemie:blocked:private-network';
    }

    if (!this.isKnownOrigin(origin, rootOrigin)) {
      logger.debug(`[${this.name}] rewriteUrl: origin "${origin}" not known for root "${rootOrigin}" — passing through`);
      return urlStr; // Unknown external origin — don't rewrite
    }

    // Extract path + query + fragment after the origin
    const pathAndRest = urlStr.slice(origin.length); // e.g. "/path?query=1"
    const encodedRoot = base64urlEncode(rootOrigin);
    const encodedRelay = base64urlEncode(origin);

    const rewritten = `${this.proxyBaseUrl}/mcp_relay/${encodedRoot}/${encodedRelay}${pathAndRest}`;
    logger.debug(`[${this.name}] rewriteUrl: "${urlStr}" → "${rewritten}"`);
    return rewritten;
  }

  // ─── Response Header Rewriting ───────────────────────────────────────────

  /**
   * Rewrite URLs found in response headers.
   * Targets: WWW-Authenticate (resource_metadata), Location (absolute and relative)
   */
  private rewriteResponseHeaders(
    headers: Record<string, string | string[] | undefined>,
    upstreamUrl: string,
    rootOrigin: string
  ): Record<string, string | string[] | undefined> {
    const result = { ...headers };

    // Rewrite WWW-Authenticate header (resource_metadata="<url>")
    // Handle both single string and string[] (Node.js may expose either form)
    const wwwAuth = result['www-authenticate'];
    if (typeof wwwAuth === 'string') {
      result['www-authenticate'] = this.rewriteWWWAuthenticate(wwwAuth, rootOrigin);
    } else if (Array.isArray(wwwAuth)) {
      result['www-authenticate'] = wwwAuth.map(v => this.rewriteWWWAuthenticate(v, rootOrigin));
    }

    // Rewrite Location header (redirects — both absolute and relative)
    const location = result['location'];
    if (typeof location === 'string') {
      let absoluteLocation = location;

      // Resolve relative redirects against the upstream URL's origin
      if (!isAbsoluteUrl(location)) {
        const upstreamOrigin = getOrigin(upstreamUrl);
        if (upstreamOrigin) {
          try {
            absoluteLocation = new URL(location, upstreamUrl).href;
          } catch {
            // Can't resolve — leave as-is
          }
        }
      }

      if (isAbsoluteUrl(absoluteLocation)) {
        const locOrigin = getOrigin(absoluteLocation);
        if (locOrigin) {
          this.addKnownOrigin(locOrigin, rootOrigin);
        }
        result['location'] = this.rewriteUrl(absoluteLocation, rootOrigin);
      }
    }

    return result;
  }

  /**
   * Rewrite URLs inside a WWW-Authenticate header value.
   * Targets: resource_metadata="<url>"
   */
  private rewriteWWWAuthenticate(header: string, rootOrigin: string): string {
    logger.debug(`[${this.name}] WWW-Authenticate header BEFORE rewrite: ${header}`);
    // Match resource_metadata="<url>"
    const rewritten = header.replace(
      /resource_metadata="([^"]+)"/g,
      (_match, url: string) => {
        if (isAbsoluteUrl(url)) {
          // Discover and register the origin (with SSRF validation and TTL)
          const origin = getOrigin(url);
          if (origin) {
            this.addKnownOrigin(origin, rootOrigin);
          }
          const rewritten = this.rewriteUrl(url, rootOrigin);
          return `resource_metadata="${rewritten}"`;
        }
        return _match;
      }
    );
    logger.debug(`[${this.name}] WWW-Authenticate header AFTER rewrite: ${rewritten}`);
    return rewritten;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Extract original URL from a proxy /mcp_auth URL.
   * Returns null if the URL is not a proxy URL.
   */
  private extractOriginalFromProxyUrl(url: string): string | null {
    if (!this.proxyBaseUrl) return null;
    const mcpAuthPrefix = this.proxyBaseUrl + '/mcp_auth';
    if (!url.startsWith(mcpAuthPrefix)) return null;
    const requestPath = url.slice(this.proxyBaseUrl.length);
    return this.extractOriginalUrl(requestPath);
  }

  /**
   * Reverse-rewrite 'resource' query parameter in a URL.
   * Converts proxy /mcp_auth URL back to the original MCP server URL.
   */
  private reverseRewriteResourceParam(url: URL): void {
    const resource = url.searchParams.get('resource');
    if (resource) {
      const original = this.extractOriginalFromProxyUrl(resource);
      if (original) {
        url.searchParams.set('resource', original);
        logger.debug(`[${this.name}] Reverse-rewrote resource query param to original URL`);
      }
    }
  }

  /**
   * Reverse-rewrite 'resource' field in request body (JSON or form-encoded).
   * Converts proxy /mcp_auth URL back to the original MCP server URL.
   */
  private reverseRewriteResourceInBody(body: Buffer, headers: Record<string, string>): Buffer {
    const contentType = headers['content-type'] || '';

    // JSON body (some OAuth implementations accept JSON)
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.resource === 'string') {
          const original = this.extractOriginalFromProxyUrl(parsed.resource);
          if (original) {
            parsed.resource = original;
            const newBody = Buffer.from(JSON.stringify(parsed), 'utf-8');
            headers['content-length'] = String(newBody.length);
            logger.debug(`[${this.name}] Reverse-rewrote resource in JSON body to original URL`);
            return newBody;
          }
        }
      } catch { /* not valid JSON */ }
    }

    // Form-encoded body (standard OAuth token requests)
    if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const bodyStr = body.toString('utf-8');
        const params = new URLSearchParams(bodyStr);
        const resource = params.get('resource');
        if (resource) {
          const original = this.extractOriginalFromProxyUrl(resource);
          if (original) {
            params.set('resource', original);
            const newBody = Buffer.from(params.toString(), 'utf-8');
            headers['content-length'] = String(newBody.length);
            logger.debug(`[${this.name}] Reverse-rewrote resource in form body to original URL`);
            return newBody;
          }
        }
      } catch { /* not valid form data */ }
    }

    return body;
  }

  /**
   * Check if the target URL is an OAuth dynamic client registration endpoint.
   * First checks against endpoints discovered from auth server metadata
   * (registration_endpoint, registration_client_uri), then falls back to
   * the /register path suffix heuristic for pre-metadata requests.
   */
  private isRegistrationEndpoint(targetUrl: string): boolean {
    // Check against dynamically discovered registration endpoints
    const normalized = normalizeEndpointUrl(targetUrl);
    if (this.discoveredRegistrationEndpoints.has(normalized)) {
      return true;
    }
    // Fallback: path suffix heuristic for before metadata is discovered
    try {
      return new URL(targetUrl).pathname.toLowerCase().endsWith('/register');
    } catch {
      return false;
    }
  }

  /**
   * Check if a response is auth metadata that needs body URL rewriting.
   * First checks against endpoints discovered from auth server metadata, then
   * falls back to path heuristics (401, .well-known/, /register, /token, /authorize).
   * Discovered endpoints cover non-standard paths that the heuristics would miss.
   */
  private isAuthMetadataResponse(targetUrl: string, statusCode: number): boolean {
    if (statusCode === 401) return true;

    // Check against dynamically discovered auth endpoints
    const normalized = normalizeEndpointUrl(targetUrl);
    if (this.discoveredAuthEndpoints.has(normalized)) {
      return true;
    }

    // Fallback: path heuristics for well-known patterns (before metadata is discovered)
    try {
      const path = new URL(targetUrl).pathname.toLowerCase();
      return path.includes('/.well-known/')
        || path.endsWith('/register')
        || path.endsWith('/token')
        || path.endsWith('/authorize');
    } catch {
      return false;
    }
  }

  /**
   * Extract the original URL from /mcp_auth?original=<url>
   * Handles both URL-encoded and raw (unencoded) values.
   *
   * Order: raw extraction FIRST (preserves unencoded nested query parameters like
   * ?original=https://host/p?aud=x&target=https://o/mcp), then URLSearchParams as
   * fallback for properly percent-encoded values. URLSearchParams must NOT run first
   * because it silently truncates unencoded nested URLs at the first `&`.
   */
  private extractOriginalUrl(requestUrl: string): string | null {
    let candidate: string | null = null;

    // 1. Raw extraction — takes everything after "original=" to preserve unencoded
    //    nested query parameters. Boundary check ensures we match a real top-level
    //    param (at start or preceded by &), not a substring inside another value.
    //    Contract: when using raw (unencoded) URLs, `original=` must be the last param.
    const queryStart = requestUrl.indexOf('?');
    if (queryStart !== -1) {
      const queryString = requestUrl.slice(queryStart + 1);
      const prefix = 'original=';
      const idx = queryString.indexOf(prefix);
      if (idx !== -1 && (idx === 0 || queryString[idx - 1] === '&')) {
        const rawValue = queryString.slice(idx + prefix.length);
        // Only use raw extraction for unencoded URLs (starts with http:// or https://).
        // Encoded values (https%3A...) fall through to URLSearchParams which correctly
        // separates top-level query params (e.g., ?original=https%3A...&trace=1).
        if (isAbsoluteUrl(rawValue)) {
          candidate = rawValue;
        }
      }
    }

    // 2. URLSearchParams fallback — handles properly percent-encoded values where
    //    raw extraction didn't find an absolute URL (e.g., double-encoded values).
    if (!candidate) {
      try {
        const parsed = new URL(requestUrl, 'http://localhost');
        const original = parsed.searchParams.get('original');
        if (original && isAbsoluteUrl(original)) {
          candidate = original;
        }
      } catch {
        // Not a valid URL
      }
    }

    // 3. Validate the candidate is fully parseable as a URL.
    //    Catches inputs like "http://%zz" that pass isAbsoluteUrl but fail new URL().
    if (candidate) {
      try {
        new URL(candidate);
        return candidate;
      } catch {
        return null; // Triggers clean 400 "Missing or invalid" response
      }
    }

    return null;
  }

  /** Send a JSON error response */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: { code: 'MCP_AUTH_ERROR', message }
    }));
    logger.debug(`[${this.name}] Error ${statusCode}: ${message}`);
  }
}
