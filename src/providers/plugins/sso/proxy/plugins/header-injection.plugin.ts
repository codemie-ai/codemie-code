/**
 * Header Injection Plugin
 * Priority: 20 (runs after auth)
 *
 * SOLID: Single responsibility = inject CodeMie headers
 * KISS: Straightforward header injection
 *
 * Repository and branch attribution for Claude Desktop is derived by
 * DesktopRepositoryResolver in the telemetry layer. This interceptor only writes the
 * resolved values into headers — it performs no discovery of its own.
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
    // Omit the session header entirely when there is no real session id, rather
    // than forwarding the 'unknown' sentinel that context.sessionId defaults to.
    if (context.sessionId && context.sessionId !== 'unknown') {
      context.headers['X-CodeMie-Session-ID'] = context.sessionId;
    }

    // LiteLLM can use these headers for Responses API session affinity when
    // its router is configured with session-aware pre-call checks.
    if (this.context.config.clientType === 'codemie-codex' || this.context.config.clientType === 'codemie-copilot') {
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

    // Desktop mode: ask the resolver what this session maps to. Claude Desktop sends
    // x-claude-code-session-id as a plain UUID, which is the key the resolver is keyed by.
    const resolver = config.desktopRepositoryResolver;
    if (resolver) {
      const attribution = await resolver.resolveForRequest(
        context.headers['x-claude-code-session-id'],
        { remotePort: context.remotePort, url: context.url }
      );

      context.headers['X-CodeMie-Repository'] = attribution.repository ?? config.repository ?? 'Cowork';

      if (attribution.branch) {
        context.headers['X-CodeMie-Branch'] = attribution.branch;
      }

      // Cowork sessions report as claude-desktop so orchestrator and subprocess metrics
      // share one (repo, branch, client) bucket instead of splitting into CLI and Desktop rows.
      if (attribution.isCowork) {
        context.headers['X-CodeMie-Client'] = 'claude-desktop';
      }
    } else if (config.repository) {
      // Non-Desktop mode: use static config values
      context.headers['X-CodeMie-Repository'] = config.repository;
    }

    if (config.branch) {
      context.headers['X-CodeMie-Branch'] = config.branch;
    }
    if (config.project) {
      context.headers['X-CodeMie-Project'] = config.project;
    }

    logger.info('[header-injection] Request headers', {
      cliSessionId: context.headers['x-claude-code-session-id'] ?? null,
      repository: context.headers['X-CodeMie-Repository'] ?? null,
      branch: context.headers['X-CodeMie-Branch'] ?? null,
      client: context.headers['X-CodeMie-Client'] ?? null,
      remotePort: context.remotePort,
    });
  }
}
