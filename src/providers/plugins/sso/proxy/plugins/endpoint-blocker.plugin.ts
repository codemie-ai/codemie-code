/**
 * Endpoint Blocker Plugin
 * Priority: 5 (runs very early, before the gateway key check (7) and auth (10))
 *
 * Answers a fixed set of endpoints locally instead of forwarding them upstream:
 * telemetry we don't want to forward, and endpoints that clients probe before
 * they send the gateway key.
 *
 * Runs in the handleRequest phase on purpose. GatewayKeyPlugin rejects requests
 * without the gateway key in that same phase, and every handleRequest hook runs
 * before any onRequest hook — an onRequest blocker would never see a request the
 * client sends without the key.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';

interface BlockedPattern {
  pattern: RegExp;
  /** HTTP status to answer with. Defaults to 200. */
  statusCode?: number;
  /** JSON string to answer with. Defaults to {"success":true}. */
  responseBody?: string;
}

const DEFAULT_RESPONSE_BODY = JSON.stringify({ success: true });

/**
 * Blocked endpoint patterns, matched against the request URL (path + query).
 * The first matching pattern wins.
 */
const BLOCKED_PATTERNS: BlockedPattern[] = [
  { pattern: /^\/api\/event_logging\/batch$/i },
  { pattern: /^\/\/api\/event_logging\/batch$/i },
  // Claude for Mac queries these before any LLM traffic, without the gateway key.
  // Returning {} lets the desktop client start cleanly without requiring auth.
  { pattern: /^\/managed-settings(?:[/?#]|$)/i, responseBody: '{}' },
  { pattern: /^\/v1\/managed-settings(?:[/?#]|$)/i, responseBody: '{}' },
  { pattern: /^\/api\/claude\/managed-settings(?:[/?#]|$)/i, responseBody: '{}' },
  { pattern: /^\/api\/v1\/managed-settings(?:[/?#]|$)/i, responseBody: '{}' },
  // Claude Desktop's "Sign in with your organization" probes the gateway base URL
  // for OAuth / OIDC discovery (RFC 8414, RFC 9728, OIDC), without the gateway key.
  // The proxy is not an authorization server: answer 404 ("no metadata here")
  // rather than 401, which the client reports as a failed SSO login.
  // Well-known URLs built over /mcp_relay/ belong to McpAuthPlugin (priority 3),
  // which handles any URL containing "/mcp_relay/" first; the lookahead mirrors
  // that test so they stay out of here regardless.
  {
    pattern: /^(?!.*\/mcp_relay\/)\/\.well-known\//i,
    statusCode: 404,
    responseBody: JSON.stringify({
      error: 'not_found',
      error_description: 'The CodeMie proxy is not an OAuth authorization server',
    }),
  },
];

export class EndpointBlockerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-endpoint-blocker';
  name = 'Endpoint Blocker';
  version = '1.0.0';
  priority = 5; // Run early, before the gateway key check and auth

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    return new EndpointBlockerInterceptor(context);
  }
}

class EndpointBlockerInterceptor implements ProxyInterceptor {
  name = 'endpoint-blocker';
  private blockedCount = 0;

  constructor(private context: PluginContext) {}

  async onProxyStart(): Promise<void> {
    logger.debug(`[${this.name}] Initialized with ${BLOCKED_PATTERNS.length} blocked patterns`);
    this.blockedCount = 0;
  }

  async onProxyStop(): Promise<void> {
    if (this.blockedCount > 0) {
      logger.debug(`[${this.name}] Blocked ${this.blockedCount} requests during session`);
    }
  }

  async handleRequest(
    context: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    const url = context.url;
    const match = BLOCKED_PATTERNS.find(({ pattern }) => pattern.test(url));
    if (!match) return false;

    this.blockedCount++;
    const statusCode = match.statusCode ?? 200;
    logger.debug(
      `[${this.name}] Answering ${context.method} ${url} locally with ${statusCode} (matched pattern: ${match.pattern.toString()})`
    );

    context.metadata.blocked = true;
    context.metadata.blockedReason = `Matched pattern: ${match.pattern.toString()}`;

    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(match.responseBody ?? DEFAULT_RESPONSE_BODY);
    return true;
  }
}
