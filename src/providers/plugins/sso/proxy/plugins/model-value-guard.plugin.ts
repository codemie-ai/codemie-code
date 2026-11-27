import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { describeModelValueViolation, validateModelValue } from '../../../../../utils/model-value.js';
import { CLAUDE_PATH_CLIENTS } from '../proxy-clients.js';

const OPENING_BRACE = 0x7b;
const BLANK_BYTES = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** True when the first non-blank byte is `{`: only then can the body be a JSON object. No string copy is made. */
function startsWithObject(body: Buffer): boolean {
  for (const byte of body) {
    if (BLANK_BYTES.has(byte)) continue;
    return byte === OPENING_BRACE;
  }
  return false;
}

/** The `model` of a JSON-object body: `{ found: false }` for anything else (not an object, unparsable, no key). */
function modelOf(body: Buffer | null): { found: true; model: unknown } | { found: false } {
  if (!body || body.length === 0 || !startsWithObject(body)) return { found: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    // Not ours to judge: the request goes on and the upstream answers a malformed body as it does today.
    return { found: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(parsed, 'model')) return { found: false };
  return { found: true, model: (parsed as Record<string, unknown>).model };
}

/**
 * Answers a 400 in the Anthropic error envelope to a Claude-path request whose `model` field is not a plain model
 * name (the shared rule in `utils/model-value.ts`), before it is routed or logged any further. Shape only: no
 * catalog lookup, and the value never appears in the response or the log. Runs for every content type, so a
 * request cannot dodge the check by lying about its `content-type`.
 */
export class ModelValueGuardPlugin implements ProxyPlugin {
  id = '@codemie/proxy-model-value-guard';
  name = 'Model Value Guard';
  version = '1.0.0';
  // After the client attribution (8), which settles the request's client; before the Desktop models answer (9).
  priority = 8.5;
  clients = CLAUDE_PATH_CLIENTS;

  createInterceptor(_context: PluginContext): ProxyInterceptor {
    return {
      name: this.name,

      async handleRequest(
        ctx: ProxyContext,
        _req: IncomingMessage,
        res: ServerResponse,
        _httpClient: ProxyHTTPClient
      ): Promise<boolean> {
        const body = modelOf(ctx.requestBody);
        if (!body.found) return false;

        const violation = validateModelValue(body.model);
        if (!violation) return false;

        logger.warn(
          '[model-value-guard] Rejected request with invalid model value',
          ...sanitizeLogArgs({
            rule: violation.rule,
            client: ctx.agentName,
            ...(violation.length !== undefined ? { length: violation.length } : { type: violation.jsonType }),
          })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: describeModelValueViolation(violation) },
        }));
        return true;
      },
    };
  }
}
