/**
 * MCP Auth Proxy — HTTP server (docs/SPEC-mcp-auth-proxy.md § Route Map, rows 1–11).
 *
 * Loopback-only transparent proxy: streams MCP traffic to upstreams untouched (design
 * D1: raw node:http + pipeline — no buffering, no body-parsing middleware) and serves
 * per-route OAuth endpoints whose only job is the surgical rewrites in rewrites.ts.
 * Stateless w.r.t. auth: no tokens, codes, or client records are ever held.
 *
 * Uniform log rule: method, route id, endpoint kind, status, duration, and rewritten
 * field NAMES only — never headers, bodies, or query strings on OAuth routes.
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { ConfigurationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { sanitizeLogArgs } from '../../utils/security.js';
import { MetadataCache, MetadataDiscoveryError } from './metadata-cache.js';
import {
  rewriteAsMetadata,
  rewriteAuthorizeQuery,
  rewriteChallengeHeader,
  rewritePrm,
  rewriteRegistrationBody,
  rewriteTokenBody,
} from './rewrites.js';
import { UpstreamClient } from './upstream-client.js';
import type { AuthProxyConfig, JsonObject, RewriteContext, RouteConfig } from './types.js';

// Bind to the literal IPv4 loopback, never 'localhost' (repo ADR: macOS resolves
// 'localhost' to ::1 only) and never a configurable host — the proxy relays bearer
// tokens and must not be network-exposed.
export const BIND_HOST = '127.0.0.1';

const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;

/** Hop-by-hop headers (RFC 9110 §7.6.1) — never forwarded in either direction. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

class BodyTooLargeError extends Error {}
class InvalidRequestTargetError extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

async function readBodyLimited(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(incoming: http.IncomingHttpHeaders, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') {
      continue;
    }
    if (value !== undefined) {
      headers[lower] = value;
    }
  }
  headers.host = target.host;
  return headers;
}

function copyResponseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

function isUpstreamNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined || error.message.includes('Timed out') || error.message.includes('socket hang up');
}

export class McpAuthProxy {
  private server?: http.Server;
  private port: number;
  private readonly sockets = new Set<Socket>();
  private readonly client: UpstreamClient;
  private readonly metadata: MetadataCache;

  constructor(private readonly config: AuthProxyConfig) {
    this.port = config.port;
    this.client = new UpstreamClient();
    this.metadata = new MetadataCache((url) => this.client.fetchJson(url));
  }

  get origin(): string {
    return `http://${BIND_HOST}:${this.port}`;
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.server) {
      throw new ConfigurationError('mcp-auth-proxy server is already running');
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(
          error.code === 'EADDRINUSE'
            ? new ConfigurationError(
                `Port ${this.port} is already in use — stop the other process or set a different "port" in mcp-auth-proxy.json`
              )
            : error
        );
      });
      server.listen(this.port, BIND_HOST, () => resolve());
    });

    const address = server.address();
    if (address !== null && typeof address === 'object') {
      this.port = address.port;
    }
    this.server = server;
    logger.debug(
      `[mcp-auth-proxy] Listening on ${this.origin} (routes: ${Object.keys(this.config.servers).join(', ')})`
    );
    return { port: this.port, url: this.origin };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Long-lived SSE sockets would otherwise keep close() pending forever.
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
    this.client.close();
  }

  /** Own-property route lookup — prototype-inherited keys ('constructor', …) are not routes. */
  private getRoute(id: string): RouteConfig | undefined {
    return Object.hasOwn(this.config.servers, id) ? this.config.servers[id] : undefined;
  }

  private ctx(routeId: string): RewriteContext {
    return {
      proxyOrigin: this.origin,
      routeId,
      scopes: this.getRoute(routeId)?.scopes,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    let kind = 'unknown';
    let routeId = '';

    try {
      // Parse inside the try: a request-target WHATWG URL rejects (e.g. absolute-form
      // "http://[") must yield a 400, not an unhandled rejection that kills the daemon.
      let url: URL;
      try {
        url = new URL(req.url ?? '/', this.origin);
      } catch {
        throw new InvalidRequestTargetError();
      }
      const segments = url.pathname.split('/').filter((segment) => segment.length > 0);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        kind = 'healthz';
        this.serveHealth(res);
      } else if (segments[0] === '.well-known') {
        [kind, routeId] = await this.handleWellKnown(req, res, segments);
      } else if (segments[0] === 'as' && segments.length >= 2) {
        routeId = segments[1];
        kind = await this.handleOAuth(req, res, url, segments);
      } else if (segments.length >= 1 && this.getRoute(segments[0]) !== undefined) {
        routeId = segments[0];
        kind = 'mcp';
        await this.passThrough(req, res, url, routeId);
      } else {
        sendJson(res, 404, { error: 'unknown_route' });
      }
    } catch (error) {
      this.handleError(res, routeId, error);
    }

    logger.debug(
      '[mcp-auth-proxy] request',
      ...sanitizeLogArgs({
        method: req.method,
        route: routeId || undefined,
        kind,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      })
    );
  }

  // ── Route map rows 2–6: well-known documents ─────────────────────────────

  private async handleWellKnown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    segments: string[]
  ): Promise<[string, string]> {
    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'unknown_route' });
      return ['unknown', ''];
    }
    const doc = segments[1];

    if (doc === 'oauth-protected-resource') {
      if (segments.length === 3) {
        await this.servePrm(res, segments[2]);
        return ['prm', segments[2]];
      }
      // Row 3: root alias only when exactly one route is configured.
      const routeIds = Object.keys(this.config.servers);
      if (segments.length === 2 && routeIds.length === 1) {
        await this.servePrm(res, routeIds[0]);
        return ['prm', routeIds[0]];
      }
      sendJson(res, 404, { error: 'unknown_route' });
      return ['unknown', ''];
    }

    if (
      (doc === 'oauth-authorization-server' || doc === 'openid-configuration') &&
      segments[2] === 'as' &&
      segments.length === 4
    ) {
      await this.serveAsMetadata(res, segments[3]);
      return ['as-metadata', segments[3]];
    }

    sendJson(res, 404, { error: 'unknown_route' });
    return ['unknown', ''];
  }

  private async servePrm(res: http.ServerResponse, routeId: string): Promise<void> {
    const route = this.getRoute(routeId);
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewritePrm(meta.prm, this.ctx(routeId));
    sendJson(res, 200, value);
    this.logRewrites('prm', routeId, rewrote);
  }

  private async serveAsMetadata(res: http.ServerResponse, routeId: string): Promise<void> {
    const route = this.getRoute(routeId);
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewriteAsMetadata(meta.asMetadata, {
      ...this.ctx(routeId),
      upstreamHasRevocation: meta.revocationEndpoint !== undefined,
    });
    sendJson(res, 200, value);
    this.logRewrites('as-metadata', routeId, rewrote);
  }

  // ── Route map rows 7–10: OAuth endpoints under /as/<id>/* ────────────────

  private async handleOAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    segments: string[]
  ): Promise<string> {
    const routeId = segments[1];
    const route = this.getRoute(routeId);
    if (!route) {
      sendJson(res, 404, { error: 'unknown_route' });
      return 'unknown';
    }
    const action = segments.slice(2).join('/');

    if (req.method === 'GET' && action === '.well-known/openid-configuration') {
      await this.serveAsMetadata(res, routeId);
      return 'as-metadata';
    }
    if (req.method === 'POST' && action === 'register') {
      await this.handleRegister(req, res, routeId, route);
      return 'register';
    }
    if (req.method === 'GET' && action === 'authorize') {
      await this.handleAuthorize(res, url, routeId, route);
      return 'authorize';
    }
    if (req.method === 'POST' && action === 'token') {
      await this.handleToken(req, res, routeId, route);
      return 'token';
    }
    if (req.method === 'POST' && action === 'revoke') {
      await this.handleRevoke(req, res, routeId, route);
      return 'revoke';
    }
    sendJson(res, 404, { error: 'unknown_route' });
    return 'unknown';
  }

  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const { value, rewrote } = rewriteRegistrationBody(parsed as JsonObject, {
      clientName: route.clientName,
      scopes: route.scopes,
    });
    await this.relay(req, res, new URL(meta.registrationEndpoint), Buffer.from(JSON.stringify(value), 'utf-8'), 'application/json');
    this.logRewrites('register', routeId, rewrote);
  }

  private async handleAuthorize(
    res: http.ServerResponse,
    url: URL,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const { value, rewrote } = rewriteAuthorizeQuery(url.searchParams, {
      scopes: route.scopes,
      upstreamResource: meta.upstreamResource,
    });
    const location = new URL(meta.authorizationEndpoint);
    for (const [key, param] of value) {
      location.searchParams.set(key, param);
    }
    res.writeHead(302, { location: location.toString() });
    res.end();
    this.logRewrites('authorize', routeId, rewrote);
  }

  private async handleToken(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    const { value, rewrote } = rewriteTokenBody(new URLSearchParams(body.toString('utf-8')), {
      scopes: route.scopes,
      upstreamResource: meta.upstreamResource,
    });
    // NEVER log request or response bodies on this route.
    await this.relay(
      req,
      res,
      new URL(meta.tokenEndpoint),
      Buffer.from(value.toString(), 'utf-8'),
      'application/x-www-form-urlencoded'
    );
    this.logRewrites('token', routeId, rewrote);
  }

  private async handleRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routeId: string,
    route: RouteConfig
  ): Promise<void> {
    const meta = await this.metadata.getMetadata(routeId, route);
    if (meta.revocationEndpoint === undefined) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const body = await this.readOAuthBody(req, res);
    if (body === null) {
      return;
    }
    const contentType =
      typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']
        : 'application/x-www-form-urlencoded';
    await this.relay(req, res, new URL(meta.revocationEndpoint), body, contentType);
  }

  /** Reads a 64 KB-limited OAuth body; answers 413 and returns null when oversized. */
  private async readOAuthBody(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<Buffer | null> {
    try {
      return await readBodyLimited(req, OAUTH_BODY_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return null;
      }
      throw error;
    }
  }

  /** Forwards a buffered OAuth payload upstream and relays status + body verbatim. */
  private async relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: URL,
    payload: Buffer,
    contentType: string
  ): Promise<void> {
    const headers = forwardHeaders(req.headers, target);
    headers['content-type'] = contentType;
    headers['content-length'] = String(payload.length);
    const { request, response } = this.client.begin(target, { method: 'POST', headers, body: payload });
    res.on('close', () => {
      if (!res.writableEnded) {
        request.destroy();
      }
    });
    const upstream = await response;
    res.writeHead(upstream.statusCode ?? 502, copyResponseHeaders(upstream));
    await pipeline(upstream, res);
  }

  // ── Route map row 1: MCP streaming pass-through ───────────────────────────

  private async passThrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    routeId: string
  ): Promise<void> {
    const route = this.getRoute(routeId);
    if (route === undefined) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    const target = new URL(route.upstreamUrl);
    target.pathname = target.pathname.replace(/\/+$/, '') + url.pathname.slice(`/${routeId}`.length);
    target.search = url.search;

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const { request, response } = this.client.begin(target, {
      method: req.method ?? 'GET',
      headers: forwardHeaders(req.headers, target),
      ...(hasBody ? { bodyStream: req } : {}),
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        request.destroy();
      }
    });

    const upstream = await response;
    const status = upstream.statusCode ?? 502;
    const outHeaders = copyResponseHeaders(upstream);

    const challenge = upstream.headers['www-authenticate'];
    const challengeText = typeof challenge === 'string' ? challenge : undefined;
    const needsChallengeRewrite =
      status === 401 ||
      (status === 403 &&
        challengeText !== undefined &&
        /error\s*=\s*"?insufficient_scope"?/i.test(challengeText));

    if (needsChallengeRewrite) {
      if (challengeText !== undefined) {
        const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challengeText);
        if (match) {
          this.metadata.notePrmUrl(routeId, match[1], route.upstreamUrl);
        }
      }
      const { value, rewrote } = rewriteChallengeHeader(challengeText, this.ctx(routeId));
      outHeaders['www-authenticate'] = value;
      this.logRewrites('mcp', routeId, rewrote);
    }

    res.writeHead(status, outHeaders);
    try {
      await pipeline(upstream, res);
    } catch {
      // Client disconnected mid-stream (normal for aborted SSE) — tear both sides down.
      upstream.destroy();
      res.destroy();
    }
  }

  // ── Health + errors ───────────────────────────────────────────────────────

  private serveHealth(res: http.ServerResponse): void {
    const routes = Object.entries(this.config.servers).map(([id, route]) => ({
      id,
      upstreamUrl: route.upstreamUrl,
      status: this.metadata.getStatus(id),
    }));
    sendJson(res, 200, { status: 'ok', routes });
  }

  private handleError(res: http.ServerResponse, routeId: string, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof InvalidRequestTargetError) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (error instanceof MetadataDiscoveryError || isUpstreamNetworkError(error)) {
      // Spec log rule: upstream host only — we log the route id, never full URLs.
      logger.warn(
        '[mcp-auth-proxy] Upstream unreachable',
        ...sanitizeLogArgs({ route: routeId || 'unknown' })
      );
      sendJson(
        res,
        502,
        routeId ? { error: 'upstream_unreachable', route: routeId } : { error: 'upstream_unreachable' }
      );
      return;
    }
    logger.error('[mcp-auth-proxy] Request handling failed', error);
    sendJson(res, 500, { error: 'internal_error' });
  }

  private logRewrites(kind: string, routeId: string, rewrote: string[]): void {
    if (rewrote.length === 0) {
      return;
    }
    logger.debug(
      '[mcp-auth-proxy] rewrote',
      ...sanitizeLogArgs({ route: routeId, kind, fields: rewrote.join(', ') })
    );
  }
}
