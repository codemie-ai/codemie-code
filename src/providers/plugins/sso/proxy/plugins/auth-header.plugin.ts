/**
 * Auth Header Plugin
 * Priority: 15 (runs after SSO auth, before other headers)
 *
 * Handles custom authorization header injection for:
 * - LiteLLM provider with custom auth header configuration
 * - Any provider that needs non-standard auth header format
 *
 * SOLID: Single responsibility = inject authorization header
 * KISS: Simple header injection with customizable format
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';
import { buildAuthHeader } from '../../../../../utils/auth-header.js';

export class AuthHeaderPlugin implements ProxyPlugin {
  id = '@codemie/proxy-auth-header';
  name = 'Auth Header';
  version = '1.0.0';
  priority = 15; // After SSO auth (10), before general headers (20)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Only create interceptor if:
    // 1. We have an API key AND
    // 2. This is NOT SSO auth (SSO uses cookies, not API key header)
    if (!context.config.apiKey) {
      throw new Error('Auth header plugin disabled: no API key configured');
    }

    if (context.credentials) {
      throw new Error('Auth header plugin disabled: SSO credentials present (using cookie auth)');
    }

    return new AuthHeaderInterceptor(context);
  }
}

class AuthHeaderInterceptor implements ProxyInterceptor {
  name = 'auth-header';

  constructor(private context: PluginContext) {}

  async onRequest(context: ProxyContext): Promise<void> {
    const { apiKey, authHeader, authValue } = this.context.config;

    if (!apiKey) {
      return;
    }

    // Build auth header using utility (supports custom header name and value format)
    const header = buildAuthHeader({
      apiKey,
      headerName: authHeader,
      valueFormat: authValue
    });

    // Inject the authorization header
    context.headers[header.name] = header.value;

    logger.debug(`[${this.name}] Injected auth header: ${header.name}`);
  }
}
