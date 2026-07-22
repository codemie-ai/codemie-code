/**
 * Profile Model Override Plugin
 * Priority: 13 (after authentication, before model-specific normalizers)
 *
 * Replaces only the model field for the OpenAI-compatible inference endpoints
 * used by VS Code BYOK. All other request fields remain protocol-transparent.
 */

import type { ProxyContext } from '../proxy-types.js';
import type { PluginContext, ProxyInterceptor, ProxyPlugin } from './types.js';

const SUPPORTED_PATH = '/v1/chat/completions';

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function isSupportedPath(rawUrl: string): boolean {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname === SUPPORTED_PATH;
  } catch {
    return rawUrl.split('?')[0] === SUPPORTED_PATH;
  }
}

function replaceBodyHeaders(context: ProxyContext): void {
  for (const key of Object.keys(context.headers)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'content-length' || normalizedKey === 'transfer-encoding') {
      delete context.headers[key];
    }
  }
  context.headers['content-length'] = String(context.requestBody?.length ?? 0);
}

class ProfileModelOverrideInterceptor implements ProxyInterceptor {
  name = 'profile-model-override';

  constructor(
    private readonly profileModel: string,
    private readonly pluginLogger: PluginContext['logger']
  ) {}

  async onRequest(context: ProxyContext): Promise<void> {
    const contentType = getHeader(context.headers, 'content-type');
    if (
      context.method.toUpperCase() !== 'POST' ||
      !isSupportedPath(context.url) ||
      !contentType?.toLowerCase().includes('application/json') ||
      !context.requestBody
    ) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(context.requestBody.toString('utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.pluginLogger.debug('[profile-model-override] Request body is not a JSON object', {
          requestId: context.requestId,
          url: context.url,
        });
        return;
      }

      const body = parsed as Record<string, unknown>;
      const originalModel = body.model;
      body.model = this.profileModel;

      context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
      context.model = this.profileModel;
      context.metadata.originalRequestedModel = originalModel;
      context.metadata.profileModelApplied = true;
      replaceBodyHeaders(context);
    } catch (error) {
      this.pluginLogger.debug('[profile-model-override] Request body is not valid JSON', {
        requestId: context.requestId,
        url: context.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class ProfileModelOverridePlugin implements ProxyPlugin {
  id = '@codemie/proxy-profile-model-override';
  name = 'Profile Model Override';
  version = '1.0.0';
  priority = 13;

  createInterceptor(context: PluginContext): ProxyInterceptor {
    const profileModel = context.config.model?.trim();
    if (context.config.enforceProfileModel !== true || !profileModel) {
      throw new Error('Plugin disabled: profile-model enforcement is not enabled');
    }

    return new ProfileModelOverrideInterceptor(profileModel, context.logger);
  }
}
