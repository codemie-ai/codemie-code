/**
 * Responses User Normalizer
 * Priority: 17 (after request sanitizers, before header injection)
 *
 * Azure-backed OpenAI routes reject `user` identifiers longer than 64
 * characters. The CodeMie Responses path can namespace the supplied value,
 * so keep the client portion at or below 32 characters. Longer identifiers
 * become a stable truncated SHA-256 digest. When a supported client omits the
 * field, send its short client type to prevent the upstream from deriving an
 * overlength default identity.
 *
 * Scope: CodeMie-managed clients that send OpenAI Responses API traffic.
 */

import { createHash } from 'node:crypto';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const SUPPORTED_CLIENT_TYPES = new Set([
  'codemie-codex',
  'codemie-opencode',
  'codemie-code',
  'vscode-byok',
]);
const MAX_CLIENT_USER_LENGTH = 32;

export class ResponsesUserNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-responses-user-normalizer';
  name = 'Responses User Normalizer';
  version = '1.0.0';
  priority = 17;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !SUPPORTED_CLIENT_TYPES.has(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new ResponsesUserNormalizerInterceptor(clientType);
  }
}

/**
 * Compatibility wrapper for callers that instantiate the former VS Code-only
 * plugin directly. Core registration uses ResponsesUserNormalizerPlugin.
 */
export class VsCodeRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-vscode-request-normalizer';
  name = 'VS Code Request Normalizer';
  version = '1.0.0';
  priority = 17;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (clientType !== 'vscode-byok') {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new ResponsesUserNormalizerInterceptor(clientType, 'vscode-request-normalizer');
  }
}

class ResponsesUserNormalizerInterceptor implements ProxyInterceptor {
  constructor(
    private readonly clientType: string,
    readonly name = 'responses-user-normalizer'
  ) {}

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    try {
      const path = context.url.split('?')[0].replace(/\/+$/, '');
      if (!path.endsWith('/responses')) {
        return;
      }

      const body = JSON.parse(context.requestBody.toString('utf-8')) as Record<string, unknown>;
      const existingUser = typeof body.user === 'string' ? body.user : '';
      const normalizedUser = existingUser.length === 0
        ? this.clientType
        : existingUser.length <= MAX_CLIENT_USER_LENGTH
          ? existingUser
          : createHash('sha256')
            .update(existingUser, 'utf-8')
            .digest('hex')
            .slice(0, MAX_CLIENT_USER_LENGTH);

      if (body.user === normalizedUser) {
        return;
      }

      body.user = normalizedUser;

      const normalizedBody = JSON.stringify(body);
      context.requestBody = Buffer.from(normalizedBody, 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);

      logger.debug(
        `[${this.name}] Normalized Responses user identifier`,
        {
          clientType: this.clientType,
          originalLength: existingUser.length,
          normalizedLength: normalizedUser.length,
        }
      );
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }
}
