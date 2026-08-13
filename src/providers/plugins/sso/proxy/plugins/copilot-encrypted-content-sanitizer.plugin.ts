/**
 * Copilot Encrypted Content Sanitizer
 * Priority: 16 (after generic request sanitizer, before header injection)
 *
 * GitHub Copilot CLI can replay Responses API reasoning items whose
 * `encrypted_content` is deployment-bound. If LiteLLM/Azure rejects a replayed
 * item before the response is streamed downstream, retry the same request once
 * after stripping replayed reasoning state so the Copilot session can continue.
 *
 * Scope: codemie-copilot only. The Codex sanitizer intentionally keeps its
 * original latch-only behavior in codex-encrypted-content-sanitizer.plugin.ts.
 */

import type { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const ALLOWED_AGENTS = ['codemie-copilot'];
const ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content';
const RESPONSES_PATH_SUFFIX = '/responses';
const UNUSABLE_REASONING_STATE_MARKERS = [
  'invalid_encrypted_content',
  'Items are not persisted when',
];

interface SanitizeResult {
  value: unknown;
  modified: boolean;
  removedCount: number;
}

export class CopilotEncryptedContentSanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-copilot-encrypted-content-sanitizer';
  name = 'Copilot Encrypted Content Sanitizer';
  version = '1.0.0';
  priority = 16;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new CopilotEncryptedContentSanitizerInterceptor(clientType);
  }
}

class CopilotEncryptedContentSanitizerInterceptor implements ProxyInterceptor {
  name = 'copilot-encrypted-content-sanitizer';

  constructor(private readonly clientType: string) {}

  async onUpstreamResponse(
    context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    if (!this.isResponsesRequest(context) || (response.statusCode ?? 200) < 400) {
      return response;
    }

    const responseBody = await tools.readBody(response);
    const marker = UNUSABLE_REASONING_STATE_MARKERS.find(m => responseBody.includes(m));
    if (!marker) {
      return tools.fromBuffer(response, responseBody);
    }

    const sanitizedRequest = this.sanitizeRequestBody(context);
    if (!sanitizedRequest) {
      return tools.fromBuffer(response, responseBody);
    }

    logger.warn(
      `[${this.name}] Upstream rejected replayed reasoning state for ${this.clientType} ("${marker}"). ` +
      `Retrying once without reasoning state: ${sanitizedRequest.removedCount} item(s) removed.`
    );

    return tools.retry(sanitizedRequest.body);
  }

  private isResponsesRequest(context: ProxyContext): boolean {
    const path = context.url.split('?')[0].replace(/\/+$/, '');
    return path.endsWith(RESPONSES_PATH_SUFFIX);
  }

  private sanitizeRequestBody(context: ProxyContext): { body: Buffer; removedCount: number } | null {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return null;
    }

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8')) as unknown;
      const sanitized = sanitizeValue(body);
      if (!sanitized.modified) {
        return null;
      }

      const newBody = Buffer.from(JSON.stringify(sanitized.value), 'utf-8');
      context.requestBody = newBody;
      context.headers['content-length'] = String(newBody.length);

      return { body: newBody, removedCount: sanitized.removedCount };
    } catch {
      return null;
    }
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

function isReasoningInputItem(value: unknown): boolean {
  return isPlainObject(value) && value.type === 'reasoning';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
