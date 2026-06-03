/**
 * Header Injection Plugin
 * Priority: 20 (runs after auth)
 *
 * SOLID: Single responsibility = inject CodeMie headers
 * KISS: Straightforward header injection
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProviderRegistry } from '../../../../core/registry.js';
import { logger } from '../../../../../utils/logger.js';

export class HeaderInjectionPlugin implements ProxyPlugin {
  id = '@codemie/proxy-headers';
  name = 'Header Injection';
  version = '1.0.0';
  priority = 20;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    return new HeaderInjectionInterceptor(context);
  }
}

class HeaderInjectionInterceptor implements ProxyInterceptor {
  name = 'header-injection';

  constructor(private context: PluginContext) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Request and session ID headers
    context.headers['X-CodeMie-Request-ID'] = context.requestId;
    context.headers['X-CodeMie-Session-ID'] = context.sessionId;

    // LiteLLM can use these headers for Responses API session affinity when
    // its router is configured with session-aware pre-call checks.
    if (this.context.config.clientType === 'codemie-codex') {
      context.headers['x-litellm-session-id'] = context.sessionId;
    }

    // Add CLI version header
    const cliVersion = this.context.config.version || '0.0.0';
    context.headers['X-CodeMie-CLI'] = `codemie-cli/${cliVersion}`;

    const config = this.context.config;

    // Check if provider requires integration header
    const provider = ProviderRegistry.getProvider(config.provider || '');
    const requiresIntegration = provider?.customProperties?.requiresIntegration === true;

    // Add integration header for providers that require it
    if (requiresIntegration && config.integrationId) {
      context.headers['X-CodeMie-Integration'] = config.integrationId;
    }

    // Add model header if configured (for all providers)
    if (config.model) {
      context.headers['X-CodeMie-CLI-Model'] = config.model;
    }

    // Add timeout header if configured (for all providers)
    if (config.timeout) {
      context.headers['X-CodeMie-CLI-Timeout'] = String(config.timeout);
    }

    // Add client type header
    if (config.clientType) {
      context.headers['X-CodeMie-Client'] = config.clientType;
    }

    // Per-request repository resolution for Desktop mode.
    // Claude Desktop sends x-claude-code-session-id with a plain UUID (no local_ prefix).
    // The shared map is keyed by externalSessionId = local_<uuid>, so prepend 'local_'.
    // Await-poll once (max 1.5s) when the session is not yet in the map.
    if (config.sessionRepositoryMap) {
      const claudeSessionId = context.headers['x-claude-code-session-id'];
      const externalSessionId = claudeSessionId ? `local_${claudeSessionId}` : undefined;
      if (externalSessionId && !config.sessionRepositoryMap.has(externalSessionId)) {
        await Promise.race([
          config.triggerPoll?.() ?? Promise.resolve(),
          new Promise<void>(resolve => setTimeout(resolve, 1500))
        ]);
      }
      const resolvedRepository = externalSessionId
        ? (config.sessionRepositoryMap.get(externalSessionId) ?? config.repository ?? 'Default')
        : (config.repository ?? 'Default');
      context.headers['X-CodeMie-Repository'] = resolvedRepository;
    } else {
      // Non-Desktop mode: use static config values
      if (config.repository) {
        context.headers['X-CodeMie-Repository'] = config.repository;
      }
    }

    if (config.branch) {
      context.headers['X-CodeMie-Branch'] = config.branch;
    }
    if (config.project) {
      context.headers['X-CodeMie-Project'] = config.project;
    }

    logger.debug(`[${this.name}] Injected CodeMie headers`);
  }
}
