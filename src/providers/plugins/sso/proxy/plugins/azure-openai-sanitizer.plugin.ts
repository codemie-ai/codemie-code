/**
 * Azure OpenAI Request Sanitizer
 * Priority: 15 (request-body transformation stage)
 *
 * Azure OpenAI exposes an OpenAI-compatible Chat Completions schema. This
 * proxy plugin preserves the existing Azure sanitizer behavior for requests
 * that are routed through CodeMieProxy: provider-specific fields are removed
 * from the request root, messages, content items, and tool calls.
 */

import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const AZURE_OPENAI_PROVIDER = 'azure-openai';

const UNSUPPORTED_TOP_LEVEL_FIELDS = [
  'reasoningSummary',
  'reasoning_summary',
  'reasoning',
  'reasoning_effort',
  'include_reasoning',
  'reasoning_content',
  'thinking',
  'cache_control',
  'betas',
  'anthropic_beta',
  'anthropic_version',
  'store',
  'metadata',
  'prediction',
  'modalities',
  'service_tier',
  'parallel_tool_calls',
  'prompt_cache_key',
] as const;

const UNSUPPORTED_NESTED_FIELDS = [
  'cache_control',
  'reasoning_content',
  'reasoningContent',
  'thinking',
  'citations',
  'signature',
  'redacted_thinking',
] as const;

const ALLOWED_MESSAGE_FIELDS = new Set([
  'role',
  'content',
  'name',
  'tool_call_id',
  'tool_calls',
  'function_call',
]);

const ALLOWED_TOOL_CALL_FIELDS = new Set(['id', 'type', 'function']);
const ALLOWED_FUNCTION_FIELDS = new Set(['name', 'arguments']);

interface SanitizationResult {
  value: unknown;
  modified: boolean;
}

export class AzureOpenAISanitizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-azure-openai-sanitizer';
  name = 'Azure OpenAI Sanitizer';
  version = '1.0.0';
  priority = 15;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (context.config.provider !== AZURE_OPENAI_PROVIDER) {
      return new NoOpInterceptor('azure-openai-sanitizer');
    }

    return new AzureOpenAISanitizerInterceptor();
  }
}

class NoOpInterceptor implements ProxyInterceptor {
  constructor(public name: string) {}
}

class AzureOpenAISanitizerInterceptor implements ProxyInterceptor {
  name = 'azure-openai-sanitizer';

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8')) as unknown;
      const sanitized = sanitizeRequest(body);

      if (!sanitized.modified) {
        return;
      }

      context.requestBody = Buffer.from(JSON.stringify(sanitized.value), 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(`[${this.name}] Removed unsupported Azure OpenAI request fields`);
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }
}

function sanitizeRequest(value: unknown): SanitizationResult {
  if (!isPlainObject(value)) {
    return { value, modified: false };
  }

  const input = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...input };
  let modified = false;

  modified = removeFields(cleaned, UNSUPPORTED_TOP_LEVEL_FIELDS) || modified;

  if (Array.isArray(input.messages)) {
    const messages = input.messages.map(sanitizeMessage);
    cleaned.messages = messages.map(result => result.value);
    modified = messages.some(result => result.modified) || modified;
  }

  if (isPlainObject(input.options)) {
    const options = { ...input.options };
    const optionsModified = removeFields(options, UNSUPPORTED_TOP_LEVEL_FIELDS);
    cleaned.options = options;
    modified = optionsModified || modified;
  }

  return { value: cleaned, modified };
}

function sanitizeMessage(value: unknown): SanitizationResult {
  if (!isPlainObject(value)) {
    return { value, modified: false };
  }

  const input = value as Record<string, unknown>;
  const message: Record<string, unknown> = {};
  let modified = false;

  for (const [key, childValue] of Object.entries(input)) {
    if (!ALLOWED_MESSAGE_FIELDS.has(key)) {
      modified = true;
      continue;
    }

    if (key === 'tool_calls' && Array.isArray(childValue)) {
      const toolCalls = childValue.map(sanitizeToolCall);
      message[key] = toolCalls.map(result => result.value);
      modified = toolCalls.some(result => result.modified) || modified;
      continue;
    }

    const nested = sanitizeNested(childValue);
    message[key] = nested.value;
    modified = nested.modified || modified;
  }

  modified = removeFields(message, [
    'cache_control',
    'reasoning_content',
    'reasoningContent',
    'thinking',
  ]) || modified;

  return { value: message, modified };
}

function sanitizeToolCall(value: unknown): SanitizationResult {
  if (!isPlainObject(value)) {
    return { value, modified: false };
  }

  const input = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  let modified = false;

  for (const [key, childValue] of Object.entries(input)) {
    if (!ALLOWED_TOOL_CALL_FIELDS.has(key)) {
      modified = true;
      continue;
    }

    if (key === 'function' && isPlainObject(childValue)) {
      const fn: Record<string, unknown> = {};
      for (const [fnKey, fnValue] of Object.entries(childValue)) {
        if (!ALLOWED_FUNCTION_FIELDS.has(fnKey)) {
          modified = true;
          continue;
        }
        fn[fnKey] = fnValue;
      }
      cleaned[key] = fn;
    } else {
      const nested = sanitizeNested(childValue);
      cleaned[key] = nested.value;
      modified = nested.modified || modified;
    }
  }

  return { value: cleaned, modified };
}

function sanitizeNested(value: unknown): SanitizationResult {
  if (Array.isArray(value)) {
    const items = value.map(sanitizeNested);
    return {
      value: items.map(item => item.value),
      modified: items.some(item => item.modified),
    };
  }

  if (!isPlainObject(value)) {
    return { value, modified: false };
  }

  const cleaned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  let modified = removeFields(cleaned, UNSUPPORTED_NESTED_FIELDS);

  for (const [key, childValue] of Object.entries(cleaned)) {
    const nested = sanitizeNested(childValue);
    cleaned[key] = nested.value;
    modified = nested.modified || modified;
  }

  return { value: cleaned, modified };
}

function removeFields(
  value: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  let modified = false;
  for (const field of fields) {
    if (field in value) {
      delete value[field];
      modified = true;
    }
  }
  return modified;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
