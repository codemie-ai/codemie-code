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
 *   JSON (compressed)    — `br`, `gzip`, `deflate` bodies are decompressed first and sent on
 *                          uncompressed; a body that cannot be decoded passes on as received.
 *   SSE  (streaming)     — stash headers in `context.metadata` during onUpstreamResponse,
 *                          then merge them into the first `message_start` event's nested
 *                          `message` object as it streams past. Until the first whole `data:`
 *                          line of the stream has passed, the unfinished last line of a chunk is
 *                          held back, so a `message_start` that opens the stream is rewritten even
 *                          when a chunk boundary cuts it; one that comes later is rewritten only
 *                          when it arrives whole in a chunk. A compressed stream passes untouched.
 *
 * Header → body key mapping (matches what the analytics reader / statusline domain layer
 * expects — see routing-headers.mjs): the body key is the lowercased header name,
 * hyphens intact (`x-litellm-router-tier`, `x-codemie-routing-tier`). Neither family is
 * transformed — a header name is a valid JS property via bracket access either way, and
 * keeping it verbatim means there is exactly one place (the header name itself) a new field
 * needs to be named.
 *
 * Only one family is ever present: a deployment routes through Switchyard or the LiteLLM
 * router, not both. Capturing by prefix means a new field in either family is recorded
 * without a code change here.
 */

import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { brotliDecompress, gunzip, inflate } from 'zlib';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const LITELLM_PREFIX = 'x-litellm-';
// x-codemie-routed-model is a real Switchyard response header (confirmed against live traffic —
// it always matches the response body's own `model`, i.e. the actually-dispatched model) that
// does NOT share a prefix with x-codemie-routing-*/x-codemie-requested-*, so it needs its own
// entry or it silently never reaches the body (see routing-headers.mjs's `routedModel`).
const CODEMIE_ROUTING_PREFIXES = ['x-codemie-routing-', 'x-codemie-requested-', 'x-codemie-routed-'];
const METADATA_HEADERS_KEY = '_routingInjectionHeaders';
const METADATA_INJECTED_KEY = '_routingInjected';
const METADATA_HOLD_ENDED_KEY = '_routingHoldEnded';
const METADATA_HELD_TAIL_KEY = '_routingHeldTail';

/** Caps the memory a held unfinished line may take; a `message_start` event is about 0.5 KB. */
export const MAX_HELD_TAIL_BYTES = 65536;
const MAX_DECODED_BODY_BYTES = MAX_HELD_TAIL_BYTES * 256;
const DECODABLE_ENCODINGS = new Set(['br', 'gzip', 'x-gzip', 'deflate']);

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
    if (lower.startsWith(LITELLM_PREFIX) || CODEMIE_ROUTING_PREFIXES.some((p) => lower.startsWith(p))) {
      out[lower] = raw;
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

const NEWLINE = Buffer.from('\n', 'utf-8');

/** Splits a buffer on the `\n` byte without decoding it, so lines that are untouched below keep their exact original bytes. */
function splitBufferLines(chunk: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0x0a) {
      lines.push(chunk.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(chunk.subarray(start));
  return lines;
}

/**
 * Merge fields into the `message` object of a `message_start` SSE event.
 *
 * Rewrites only whole `data:` lines that parse as a `message_start` event; every other
 * line — including partial trailing lines at a chunk boundary — is passed through as the
 * original bytes, never decoded to UTF-8 and re-encoded. A chunk boundary can cut a later,
 * unrelated line mid multi-byte character; round-tripping the whole chunk through
 * `toString('utf-8')` would replace those truncated bytes with U+FFFD and then bake that
 * corruption in permanently once any line in the chunk was modified. Returns the original
 * buffer when no event was modified.
 */
export function injectIntoSseChunk(chunk: Buffer, injections: RoutingInjections): Buffer {
  if (Object.keys(injections).length === 0) return chunk;
  const lines = splitBufferLines(chunk);
  let modified = false;
  const outLines: Buffer[] = [];

  for (const lineBuf of lines) {
    const line = lineBuf.toString('utf-8');
    if (!line.startsWith('data: ')) {
      outLines.push(lineBuf);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      // Not JSON (e.g. `[DONE]`) or a line split across chunks — pass through untouched.
      outLines.push(lineBuf);
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
      outLines.push(Buffer.from('data: ' + JSON.stringify({ ...event, message }), 'utf-8'));
      modified = true;
    } else {
      outLines.push(lineBuf);
    }
  }

  if (!modified) return chunk;
  const parts: Buffer[] = [];
  outLines.forEach((lineBuf, i) => {
    if (i > 0) parts.push(NEWLINE);
    parts.push(lineBuf);
  });
  return Buffer.concat(parts);
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
      const encoding = compressionOf(response.headers);
      if (encoding) {
        logger.debug(`[${this.name}] Not injecting into "${encoding}" SSE response: the stream is compressed`);
        return response;
      }
      // Streaming: defer to onResponseChunk so the stream is never buffered.
      context.metadata[METADATA_HEADERS_KEY] = injections;
      logger.debug(
        `[${this.name}] Captured ${Object.keys(injections).length} routing header(s) for SSE injection`
      );
      return response;
    }

    let body: Buffer;
    try {
      body = await tools.readBody(response);
    } catch (error) {
      logger.debug(`[${this.name}] Reading the JSON response failed, forwarding original response:`, error);
      return response;
    }

    // The body is drained from here on: every path answers with a response built from a buffer.
    try {
      return await this.injectIntoBufferedJson(response, body, injections, tools);
    } catch (error) {
      logger.debug(`[${this.name}] JSON injection failed, forwarding original body:`, error);
      return tools.fromBuffer(response, body);
    }
  }

  /**
   * Holds back the unfinished last line of each chunk until the first whole `data:` line of the
   * stream has passed, so a `message_start` event cut by a chunk boundary is rewritten once whole.
   * After that, each chunk is rewritten whole until a `message_start` has been rewritten.
   * Returns `null` while everything received so far is held.
   */
  async onResponseChunk(context: ProxyContext, chunk: Buffer): Promise<Buffer | null> {
    if (context.metadata[METADATA_INJECTED_KEY]) {
      return chunk;
    }
    const injections = context.metadata[METADATA_HEADERS_KEY] as RoutingInjections | undefined;
    if (!injections || Object.keys(injections).length === 0) {
      return chunk;
    }

    if (context.metadata[METADATA_HOLD_ENDED_KEY]) {
      const result = injectIntoSseChunk(chunk, injections);
      if (result !== chunk) {
        context.metadata[METADATA_INJECTED_KEY] = true;
        logger.debug(`[${this.name}] Injected routing headers into SSE message_start`);
      }
      return result;
    }

    const held = context.metadata[METADATA_HELD_TAIL_KEY] as Buffer | undefined;
    const data = held ? Buffer.concat([held, chunk]) : chunk;
    const cut = data.lastIndexOf(0x0a) + 1;
    const head = data.subarray(0, cut);
    const tail = data.subarray(cut);
    const rewrite = rewriteSseLines(head, injections);

    if (rewrite.modified) {
      logger.debug(`[${this.name}] Injected routing headers into SSE message_start`);
    }
    if (rewrite.hasDataLine) {
      context.metadata[METADATA_HOLD_ENDED_KEY] = true;
      if (rewrite.modified) context.metadata[METADATA_INJECTED_KEY] = true;
      delete context.metadata[METADATA_HELD_TAIL_KEY];
      return rewrite.modified ? Buffer.concat([rewrite.buffer, tail]) : data;
    }
    if (tail.length > MAX_HELD_TAIL_BYTES) {
      context.metadata[METADATA_INJECTED_KEY] = true;
      delete context.metadata[METADATA_HELD_TAIL_KEY];
      logger.debug(
        `[${this.name}] Gave up SSE injection: an unfinished line exceeded ${MAX_HELD_TAIL_BYTES} bytes`
      );
      return data;
    }

    context.metadata[METADATA_HELD_TAIL_KEY] = tail;
    return head.length > 0 ? head : null;
  }

  /** Releases the held unfinished line, rewritten if it is a whole `message_start` event. */
  async onResponseStreamEnd(context: ProxyContext): Promise<Buffer | null> {
    const held = context.metadata[METADATA_HELD_TAIL_KEY] as Buffer | undefined;
    delete context.metadata[METADATA_HELD_TAIL_KEY];
    if (!held || held.length === 0) {
      return null;
    }
    const injections = context.metadata[METADATA_HEADERS_KEY] as RoutingInjections;
    return rewriteSseLines(held, injections).buffer;
  }

  private async injectIntoBufferedJson(
    response: IncomingMessage,
    body: Buffer,
    injections: RoutingInjections,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    const encoding = compressionOf(response.headers);
    let plain = body;
    if (encoding) {
      if (!DECODABLE_ENCODINGS.has(encoding)) {
        logger.debug(`[${this.name}] Not injecting into "${encoding}" JSON response: unknown encoding`);
        return tools.fromBuffer(response, body);
      }
      try {
        plain = await decompressBody(encoding, body);
      } catch (error) {
        logger.debug(
          `[${this.name}] Not injecting into "${encoding}" JSON response: decompression failed (${String(error)})`
        );
        return tools.fromBuffer(response, body);
      }
    }

    const modified = injectIntoJsonBody(plain, injections);
    if (modified === plain) {
      if (encoding) {
        logger.debug(`[${this.name}] Not injecting into "${encoding}" JSON response: not a JSON object`);
      }
      return tools.fromBuffer(response, body);
    }

    logger.debug(
      `[${this.name}] Injected ${Object.keys(injections).length} routing header(s) into JSON response`
    );
    const rewritten = tools.fromBuffer(response, modified);
    if (encoding) {
      delete rewritten.headers['content-encoding'];
    }
    return rewritten;
  }
}

/** The response's `content-encoding`, trimmed and lowercased; `''` for none or `identity`. */
function compressionOf(headers: IncomingHttpHeaders): string {
  const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
  return encoding === 'identity' ? '' : encoding;
}

/** Decompresses a body of a decodable `content-encoding`, failing past `MAX_DECODED_BODY_BYTES`. */
function decompressBody(encoding: string, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => (error ? reject(error) : resolve(result));
    const options = { maxOutputLength: MAX_DECODED_BODY_BYTES };
    if (encoding === 'br') brotliDecompress(body, options, done);
    else if (encoding === 'deflate') inflate(body, options, done);
    else gunzip(body, options, done);
  });
}

/**
 * Runs `injectIntoSseChunk` line by line, keeping a trailing `\r` of each line, and reports
 * whether the buffer holds a whole `data:` line (one followed by `\n`).
 */
function rewriteSseLines(
  buffer: Buffer,
  injections: RoutingInjections
): { buffer: Buffer; modified: boolean; hasDataLine: boolean } {
  const lines = splitBufferLines(buffer);
  let modified = false;
  let hasDataLine = false;
  const parts: Buffer[] = [];
  lines.forEach((line, i) => {
    const whole = i < lines.length - 1;
    if (whole && line.subarray(0, 5).toString('utf-8') === 'data:') {
      hasDataLine = true;
    }
    const crLength = line.length > 0 && line[line.length - 1] === 0x0d ? 1 : 0;
    const content = line.subarray(0, line.length - crLength);
    const rewritten = injectIntoSseChunk(content, injections);
    if (rewritten !== content) modified = true;
    if (i > 0) parts.push(NEWLINE);
    parts.push(rewritten, line.subarray(line.length - crLength));
  });
  return { buffer: modified ? Buffer.concat(parts) : buffer, modified, hasDataLine };
}
