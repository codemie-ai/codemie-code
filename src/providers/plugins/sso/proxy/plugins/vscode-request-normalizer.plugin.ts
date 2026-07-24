/**
 * VS Code Request Normalizer
 * Priority: 17 (after request sanitizers, before header injection)
 *
 * Azure-backed OpenAI routes reject `user` identifiers longer than 64
 * characters. The CodeMie Responses path can namespace the supplied value,
 * so keep the client portion at or below 32 characters. Longer identifiers
 * become a stable truncated SHA-256 digest. When VS Code omits the field, send
 * a short explicit fallback to prevent the upstream from deriving an
 * overlength default identity.
 *
 * Scope: VS Code BYOK Responses API traffic only.
 */

import { createHash } from 'node:crypto';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const VS_CODE_CLIENT_TYPE = 'vscode-byok';
const MAX_CLIENT_USER_LENGTH = 32;
const FALLBACK_USER = 'vscode-byok';

export class VsCodeRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-vscode-request-normalizer';
  name = 'VS Code Request Normalizer';
  version = '1.0.0';
  priority = 17;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (context.config.clientType !== VS_CODE_CLIENT_TYPE) {
      throw new Error(`Plugin disabled for agent: ${context.config.clientType}`);
    }

    return new VsCodeRequestNormalizerInterceptor();
  }
}

class VsCodeRequestNormalizerInterceptor implements ProxyInterceptor {
  name = 'vscode-request-normalizer';

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
        ? FALLBACK_USER
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
          originalLength: existingUser.length,
          normalizedLength: normalizedUser.length,
        }
      );
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }
}
