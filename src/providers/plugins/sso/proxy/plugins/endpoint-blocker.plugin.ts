/**
 * Endpoint Blocker Plugin
 * Priority: 5 (runs very early, before auth)
 *
 * SOLID: Single responsibility = block unwanted endpoints
 * KISS: Simple pattern matching, always returns 200 OK for blocked endpoints
 *
 * Blocks unwanted telemetry/logging endpoints that we don't want to forward upstream.
 * Returns 200 OK immediately to prevent client retries and errors.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

interface BlockedPattern {
  pattern: RegExp;
  responseBody?: string;
}

/**
 * Blocked endpoint patterns
 * Add patterns here to block specific endpoints.
 * Optionally set responseBody to return a custom JSON string instead of the default {"success":true}.
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
];

export class EndpointBlockerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-endpoint-blocker';
  name = 'Endpoint Blocker';
  version = '1.0.0';
  priority = 5; // Run early, before auth

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

  async onRequest(context: ProxyContext): Promise<void> {
    const url = context.url;

    // Check if URL matches any blocked pattern
    for (const { pattern, responseBody } of BLOCKED_PATTERNS) {
      if (pattern.test(url)) {
        this.blockedCount++;
        logger.debug(`[${this.name}] Blocking request to: ${url} (matched pattern: ${pattern.toString()})`);

        context.metadata.blocked = true;
        context.metadata.blockedReason = `Matched pattern: ${pattern.toString()}`;
        if (responseBody !== undefined) {
          context.metadata.blockedResponseBody = responseBody;
        }

        break;
      }
    }
  }
}
