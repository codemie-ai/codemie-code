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
import { encodeAttributionHeader, rawProjectHeader } from '../../../../../utils/header-value.js';

import type { ClassResult } from '../../../../../agents/core/evidence/classify.js';
import { ORG_ENCODED_HEADER, encodeOrganization, needsOrganizationEncoding } from '../../../../../agents/core/evidence/org-encoding.js';

export interface ModelAttribution {
  destination: 'model';
  requestId: string;
  sessionId: string;
  cliVersion?: string;
  sessionAffinity?: boolean;
  integrationId?: string;
  model?: string;
  timeout?: number;
  clientType?: string;
  repository?: string;
  branch?: string;
  project?: string;
}

export interface AnalyticsAttribution {
  destination: 'analytics';
  sessionId: string;
  routedViaCodemie: boolean;
  subscriptionType: ClassResult['class'];
  routingUnproven: boolean;
  organization?: string;
  policyVersion?: string;
  repoKey?: string;
  project?: string;
  projectSource: 'linked_folder' | 'profile' | 'none';
}

export interface AttributionHeaders {
  headers: Record<string, string>;
  /** Names only; callers may log the omission reason, never the rejected values. */
  omitted: string[];
}

/**
 * Single attribution-header owner for model and analytics requests. Inputs are already resolved:
 * no filesystem discovery, classification, policy lookup or auth mutation belongs here.
 * The destination discriminant keeps analytics evidence out of model-request headers.
 */
export function buildAttributionHeaders(input: ModelAttribution | AnalyticsAttribution): AttributionHeaders {
  if (input.destination === 'analytics') return analyticsAttributionHeaders(input);
  const headers: Record<string, string> = {
    'X-CodeMie-Request-ID': input.requestId,
    'X-CodeMie-CLI': `codemie-cli/${input.cliVersion || '0.0.0'}`,
  };
  if (input.sessionId && input.sessionId !== 'unknown') headers['X-CodeMie-Session-ID'] = input.sessionId;
  if (input.sessionAffinity) headers['x-litellm-session-id'] = input.sessionId;
  if (input.integrationId) headers['X-CodeMie-Integration'] = input.integrationId;
  if (input.model) headers['X-CodeMie-CLI-Model'] = input.model;
  if (input.timeout) headers['X-CodeMie-CLI-Timeout'] = String(input.timeout);
  if (input.clientType) headers['X-CodeMie-Client'] = input.clientType;
  if (input.repository !== undefined) headers['X-CodeMie-Repository'] = encodeAttributionHeader(input.repository);
  if (input.branch) headers['X-CodeMie-Branch'] = encodeAttributionHeader(input.branch);
  const project = input.project ? rawProjectHeader(input.project) : undefined;
  if (project) headers['X-CodeMie-Project'] = project;
  return { headers, omitted: [] };
}

function analyticsAttributionHeaders(input: AnalyticsAttribution): AttributionHeaders {
  const headers: Record<string, string> = {
    'X-CodeMie-Session-Id': input.sessionId,
    'X-CodeMie-Routed-Via-CodeMie': String(input.routedViaCodemie),
    'X-CodeMie-Subscription-Type': input.subscriptionType,
  };
  const omitted: string[] = [];
  const put = (name: string, value: string | undefined): void => {
    const raw = value ? rawProjectHeader(value) : undefined;
    if (raw) headers[name] = raw;
    else if (value) omitted.push(name);
  };
  // An unproven route cannot reveal an organization that the backend would classify Personal.
  // Encoding capability is checked by the analytics caller before constructing this contract.
  const org = input.organization;
  if (!input.routingUnproven && org) {
    if (!needsOrganizationEncoding(org)) put('X-CodeMie-Organization', org);
    else if (!input.routedViaCodemie) {
      const encoded = encodeOrganization(org);
      if (encoded) headers[ORG_ENCODED_HEADER] = encoded;
    }
  }
  put('X-CodeMie-Policy-Version', input.policyVersion);
  put('X-CodeMie-Repo-Remote', input.repoKey);
  const project = input.project ? rawProjectHeader(input.project) : undefined;
  if (project) {
    headers['X-CodeMie-Project'] = project;
    if (input.projectSource !== 'none') headers['X-CodeMie-Project-Source'] = input.projectSource;
  }
  return { headers, omitted };
}

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
    const config = this.context.config;
    const provider = ProviderRegistry.getProvider(config.provider || '');
    const requiresIntegration = provider?.customProperties?.requiresIntegration === true;
    let repository = config.repository || undefined;
    let branch = config.branch;
    let clientType = config.clientType;
    const resolver = config.desktopRepositoryResolver;
    if (resolver) {
      const attribution = await resolver.resolveForRequest(
        context.headers['x-claude-code-session-id'],
        { remotePort: context.remotePort, url: context.url }
      );
      repository = attribution.repository ?? config.repository ?? 'Cowork';
      branch = config.branch || attribution.branch || undefined;
      if (attribution.isCowork) clientType = 'claude-desktop';
    }
    Object.assign(context.headers, buildAttributionHeaders({
      destination: 'model',
      requestId: context.requestId,
      sessionId: context.sessionId,
      cliVersion: config.version,
      sessionAffinity: ['codemie-codex', 'codemie-codex-acp', 'codemie-copilot'].includes(config.clientType ?? ''),
      integrationId: requiresIntegration ? config.integrationId : undefined,
      model: config.model,
      timeout: config.timeout,
      clientType,
      repository,
      branch,
      project: config.project,
    }).headers);
    logger.info('[header-injection] Request headers', {
      cliSessionId: context.headers['x-claude-code-session-id'] ?? null,
      repository: context.headers['X-CodeMie-Repository'] ?? null,
      branch: context.headers['X-CodeMie-Branch'] ?? null,
      client: context.headers['X-CodeMie-Client'] ?? null,
      remotePort: context.remotePort,
    });
  }
}
