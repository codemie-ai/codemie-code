/**
 * Routing Header Injector Plugin
 * Priority: 55 (after logging at 50, before session-sync at 100)
 *
 * The upstream router (CodeMie Switchyard or the LiteLLM router) reports which model
 * tier it picked, and why, in HTTP *response headers*. Headers are forwarded downstream
 * but agents do not persist them, so the decision is lost the moment the turn ends.
 *
 * This plugin copies those headers onto the response *body*, where the agent stores them
 * verbatim in its own transcript alongside `usage`. The analytics pipeline
 * (cost/usage-readers.ts) then reads routing metadata per turn with no join and no
 * sidecar file.
 *
 * Two response paths:
 *   JSON (non-streaming) — buffer the body, merge fields at the top level (which is the
 *                          message object for the Messages API), return a new response.
 *   SSE  (streaming)     — stash headers in `context.metadata` during onUpstreamResponse,
 *                          then merge them into the first `message_start` event's nested
 *                          `message` object as it streams past.
 *
 * Header → body key mapping (matches what the analytics reader expects):
 *   x-litellm-*  → key keeps its hyphens        (`x-litellm-router-tier`)
 *   x-codemie-*  → key converts hyphens to `_`  (`x_codemie_routing_tier`)
 *
 * Only one family is ever present: a deployment routes through Switchyard or the LiteLLM
 * router, not both. Capturing by prefix means a new field in either family is recorded
 * without a code change here.
 */

import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const LITELLM_PREFIX = 'x-litellm-';
const CODEMIE_ROUTING_PREFIXES = ['x-codemie-routing-', 'x-codemie-requested-'];
const METADATA_HEADERS_KEY = '_routingInjectionHeaders';
const METADATA_INJECTED_KEY = '_routingInjected';

/** Fields extracted from routing headers, keyed as they will appear in the body. */
export type RoutingInjections = Record<string, string>;

/**
 * Extract routing-relevant upstream response headers into a flat body-key → value map.
 * Returns an empty object when the response carries no routing metadata, which is the
 * common case for non-routed deployments and for requests that name a literal model ID.
 */
export function extractRoutingHeaders(headers: IncomingHttpHeaders): RoutingInjections {
  const out: RoutingInjections = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw == null) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith(LITELLM_PREFIX)) {
      out[lower] = raw;
    } else if (CODEMIE_ROUTING_PREFIXES.some((p) => lower.startsWith(p))) {
      out[lower.replace(/-/g, '_')] = raw;
    }
  }
  return out;
}

/**
 * Merge fields into the top-level JSON object of a body buffer. Returns the buffer
 * unchanged when there is nothing to inject, the payload is not a JSON object, or
 * parsing fails — a routing annotation must never corrupt a response.
 */
export function injectIntoJsonBody(body: Buffer, injections: RoutingInjections): Buffer {
  if (Object.keys(injections).length === 0) return body;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return body;
    }
    return Buffer.from(JSON.stringify({ ...parsed, ...injections }), 'utf-8');
  } catch {
    return body;
  }
}

/**
 * Merge fields into the `message` object of a `message_start` SSE event.
 *
 * Rewrites only whole `data:` lines that parse as a `message_start` event; every other
 * line — including partial trailing lines at a chunk boundary — is passed through byte
 * for byte. Returns the original buffer when no event was modified.
 */
export function injectIntoSseChunk(chunk: Buffer, injections: RoutingInjections): Buffer {
  if (Object.keys(injections).length === 0) return chunk;
  const lines = chunk.toString('utf-8').split('\n');
  let modified = false;
  const outLines: string[] = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      outLines.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      // Not JSON (e.g. `[DONE]`) or a line split across chunks — pass through untouched.
      outLines.push(line);
      continue;
    }
    const event = parsed as { type?: unknown; message?: unknown };
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      event.type === 'message_start' &&
      typeof event.message === 'object' &&
      event.message !== null
    ) {
      const message = { ...(event.message as Record<string, unknown>), ...injections };
      outLines.push('data: ' + JSON.stringify({ ...event, message }));
      modified = true;
    } else {
      outLines.push(line);
    }
  }

  return modified ? Buffer.from(outLines.join('\n'), 'utf-8') : chunk;
}

export class RoutingHeaderInjectorPlugin implements ProxyPlugin {
  id = '@codemie/proxy-routing-header-injector';
  name = 'Routing Header Injector';
  version = '1.0.0';
  priority = 55; // After logging (50), before session-sync (100)

  async createInterceptor(_context: PluginContext): Promise<ProxyInterceptor> {
    return new RoutingHeaderInjectorInterceptor();
  }
}

class RoutingHeaderInjectorInterceptor implements ProxyInterceptor {
  name = 'routing-header-injector';

  async onUpstreamResponse(
    context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    const injections = extractRoutingHeaders(response.headers);
    if (Object.keys(injections).length === 0) {
      return response;
    }

    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      // Streaming: defer to onResponseChunk so the stream is never buffered.
      context.metadata[METADATA_HEADERS_KEY] = injections;
      logger.debug(
        `[${this.name}] Captured ${Object.keys(injections).length} routing header(s) for SSE injection`
      );
      return response;
    }

    try {
      const body = await tools.readBody(response);
      const modified = injectIntoJsonBody(body, injections);
      if (modified !== body) {
        logger.debug(
          `[${this.name}] Injected ${Object.keys(injections).length} routing header(s) into JSON response`
        );
      }
      return tools.fromBuffer(response, modified);
    } catch (error) {
      logger.debug(`[${this.name}] JSON injection failed, forwarding original response:`, error);
      return response;
    }
  }

  async onResponseChunk(context: ProxyContext, chunk: Buffer): Promise<Buffer> {
    if (context.metadata[METADATA_INJECTED_KEY]) {
      return chunk;
    }
    const injections = context.metadata[METADATA_HEADERS_KEY] as RoutingInjections | undefined;
    if (!injections || Object.keys(injections).length === 0) {
      return chunk;
    }

    const modified = injectIntoSseChunk(chunk, injections);
    if (modified !== chunk) {
      context.metadata[METADATA_INJECTED_KEY] = true;
      logger.debug(`[${this.name}] Injected routing headers into SSE message_start`);
    }
    return modified;
  }
}
