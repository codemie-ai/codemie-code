/**
 * Encrypted Content Sanitizer
 * Priority: 16 (after generic request sanitizer, before header injection)
 *
 * LiteLLM/Azure can reject Responses API follow-up requests when encrypted
 * reasoning content is load-balanced to a different deployment/API key than
 * the one that created it. Server-side encrypted_content_affinity is the
 * correct fix. This client-side sanitizer is a defensive fallback:
 * it removes encrypted reasoning state so the session can continue instead of
 * failing with invalid_encrypted_content.
 *
 * Scope: codemie-codex, codemie-code, codemie-opencode. Widened from codex-only
 * to cover all Responses-API sessions — affects gpt-5.2, gpt-5.3-codex, gpt-5.5,
 * and any other Responses-path models. Tradeoff: drops cross-turn reasoning
 * continuity (encrypted state stripped) to avoid hard invalid_encrypted_content
 * failures — the same tradeoff already accepted for Codex. If server-side
 * encrypted_content_affinity becomes available, this client strip becomes redundant.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = ['codemie-codex', 'codemie-code', 'codemie-opencode'];
const ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content';

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

  constructor(private readonly clientType: string) {}

  async onRequest(context: ProxyContext): Promise<void> {
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
}

function sanitizeValue(value: unknown): SanitizeResult {
  if (Array.isArray(value)) {
    let modified = false;
    let removedCount = 0;
    const sanitizedItems: unknown[] = [];

    for (const item of value) {
      if (isEncryptedReasoningItem(item)) {
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

function isEncryptedReasoningItem(value: unknown): boolean {
  return isPlainObject(value) &&
    value.type === 'reasoning' &&
    typeof value.encrypted_content === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
