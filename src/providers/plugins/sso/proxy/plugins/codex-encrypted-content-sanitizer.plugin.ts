/**
 * Encrypted Content Sanitizer
 * Priority: 16 (after generic request sanitizer, before header injection)
 *
 * Responses API reasoning items are bound to the deployment that produced them:
 * `encrypted_content` is decryptable only by the API key that created it, and a
 * bare `rs_...` id is unresolvable under `store: false`. Replaying either one
 * against the wrong deployment fails the turn.
 *
 * The gateway now runs LiteLLM `encrypted_content_affinity`, which routes a
 * follow-up carrying encrypted content back to its originating deployment. So
 * the default path is pass-through: reasoning state is forwarded untouched and
 * agents keep full cross-turn reasoning continuity.
 *
 * Affinity pins expire (`deployment_affinity_ttl_seconds`), and a session
 * resumed after expiry replays state no deployment can resolve. Because clients
 * replay their whole history every turn, that first failure would otherwise
 * repeat forever. This interceptor therefore watches upstream responses for the
 * two failure signatures and, once either is seen, strips reasoning state from
 * every subsequent request for the life of the proxy. The failing turn surfaces
 * its error; the session then self-heals with degraded continuity instead of
 * staying stuck.
 *
 * Stripping is the same trade as before: reasoning effort, visible messages,
 * tool calls, and tool outputs survive; prior hidden reasoning does not.
 *
 * Scope: codemie-codex, codemie-code, codemie-opencode, codemie-pi, and
 * vscode-byok.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = [
  'codemie-codex',
  'codemie-code',
  'codemie-opencode',
  'codemie-pi',
  'vscode-byok',
];
const ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content';
const RESPONSES_PATH_SUFFIX = '/responses';

/**
 * Upstream signatures that mean replayed reasoning state was rejected:
 * affinity miss or expired pin, and a bare reasoning id under `store: false`.
 * Kept short so LiteLLM's nested JSON escaping cannot break the match.
 */
const UNUSABLE_REASONING_STATE_MARKERS = [
  'invalid_encrypted_content',
  'Items are not persisted when',
];
const MARKER_OVERLAP_BYTES = Math.max(...UNUSABLE_REASONING_STATE_MARKERS.map(m => m.length)) - 1;
const MARKER_CARRY_KEY = 'encryptedContentSanitizerMarkerCarry';

interface SanitizeResult {
  value: unknown;
  modified: boolean;
  removedCount: number;
}

export class CodexEncryptedContentSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-codex-encrypted-content-sanitizer';
  name = 'Codex Encrypted Content Sanitizer';
  version = '1.0.0';
  priority = 16;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new CodexEncryptedContentSanitizerInterceptor(clientType);
  }
}

class CodexEncryptedContentSanitizerInterceptor implements ProxyInterceptor {
  name = 'codex-encrypted-content-sanitizer';

  /** Set once upstream rejects replayed reasoning state; never cleared for this proxy. */
  private reasoningStateUnusable = false;

  constructor(private readonly clientType: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!this.reasoningStateUnusable) {
      return;
    }

    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8')) as unknown;
      const sanitized = sanitizeValue(body);

      if (!sanitized.modified) {
        return;
      }

      const newBodyStr = JSON.stringify(sanitized.value);
      context.requestBody = Buffer.from(newBodyStr, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(
        `[${this.name}] Removed encrypted reasoning content from ${this.clientType} request: ${sanitized.removedCount} item(s)`
      );
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }

  /**
   * Read-only scan of the upstream stream. Returns the chunk untouched; the only
   * effect is latching `reasoningStateUnusable` so later requests get stripped.
   */
  async onResponseChunk(context: ProxyContext, chunk: Buffer): Promise<Buffer | null> {
    if (this.reasoningStateUnusable || !context.url.includes(RESPONSES_PATH_SUFFIX)) {
      return chunk;
    }

    // Carry lives on the per-request context: concurrent streams must not share it.
    const carry = context.metadata[MARKER_CARRY_KEY];
    const searchable = Buffer.isBuffer(carry) ? Buffer.concat([carry, chunk]) : chunk;
    const marker = UNUSABLE_REASONING_STATE_MARKERS.find(m => searchable.includes(m));

    if (marker) {
      this.reasoningStateUnusable = true;
      delete context.metadata[MARKER_CARRY_KEY];
      logger.warn(
        `[${this.name}] Upstream rejected replayed reasoning state for ${this.clientType} ("${marker}"). ` +
        'Stripping reasoning state from subsequent requests — cross-turn reasoning continuity is degraded ' +
        'for the rest of this session. Expected after an encrypted_content_affinity pin expires; ' +
        'a rising rate means deployment_affinity_ttl_seconds is too short.'
      );
      return chunk;
    }

    context.metadata[MARKER_CARRY_KEY] = searchable.subarray(
      Math.max(0, searchable.length - MARKER_OVERLAP_BYTES)
    );
    return chunk;
  }
}

function sanitizeValue(value: unknown): SanitizeResult {
  if (Array.isArray(value)) {
    let modified = false;
    let removedCount = 0;
    const sanitizedItems: unknown[] = [];

    for (const item of value) {
      if (isReasoningInputItem(item)) {
        modified = true;
        removedCount++;
        continue;
      }

      const sanitized = sanitizeValue(item);
      modified = modified || sanitized.modified;
      removedCount += sanitized.removedCount;
      sanitizedItems.push(sanitized.value);
    }

    return { value: sanitizedItems, modified, removedCount };
  }

  if (!isPlainObject(value)) {
    return { value, modified: false, removedCount: 0 };
  }

  let modified = false;
  let removedCount = 0;
  const result: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (key === 'encrypted_content') {
      modified = true;
      removedCount++;
      continue;
    }

    if (key === 'include' && Array.isArray(childValue)) {
      const filteredInclude = childValue.filter(item => item !== ENCRYPTED_CONTENT_INCLUDE);
      if (filteredInclude.length !== childValue.length) {
        modified = true;
        removedCount += childValue.length - filteredInclude.length;
      }
      result[key] = filteredInclude;
      continue;
    }

    const sanitized = sanitizeValue(childValue);
    modified = modified || sanitized.modified;
    removedCount += sanitized.removedCount;
    result[key] = sanitized.value;
  }

  return { value: result, modified, removedCount };
}

/**
 * Any replayed reasoning item is deployment-bound state, not just the encrypted ones.
 * Once `include: ["reasoning.encrypted_content"]` is stripped the upstream response
 * carries reasoning items without `encrypted_content`; clients that persist and replay
 * them (pi) then send a bare `rs_...` id, which `store: false` requests cannot resolve
 * ("Item with id 'rs_...' not found"). Drop the whole item in both shapes.
 */
function isReasoningInputItem(value: unknown): boolean {
  return isPlainObject(value) && value.type === 'reasoning';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
