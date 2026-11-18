/**
 * Header Injection Plugin
 * Priority: 20 (runs after auth)
 *
 * SOLID: Single responsibility = inject CodeMie headers
 * KISS: Straightforward header injection
 *
 * Repository and branch attribution for Claude Desktop is derived by
 * DesktopRepositoryResolver in the telemetry layer and put into the request's metadata by the
 * client-attribution plugin. This interceptor only writes the resolved values into headers —
 * it performs no discovery of its own.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProviderRegistry } from '../../../../core/registry.js';
import { CODEMIE_ENDPOINTS } from '../../sso.http-client.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { encodeAttributionHeader, rawProjectHeader } from '../../../../../utils/header-value.js';
import { CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE } from '../proxy-clients.js';
import { DESKTOP_ATTRIBUTION_KEY, type ResolvedDesktopAttribution } from './client-attribution.plugin.js';

import { CONSENT_HEADER, CONSENT_VALUE, CONTRACT_HEADER, FUNDING_HEADER, PUBLICATION_CONTRACT, stripAnalyticsOnlyHeaders } from '../../../../../agents/core/evidence/publication-contract.js';
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
  /** New publication contract request: the frozen funding claim, and whether explicit work consent currently holds. */
  contract?: { fundingRoute: string; consent: boolean };
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
  if (input.contract) {
    headers[CONTRACT_HEADER] = PUBLICATION_CONTRACT;
    headers[FUNDING_HEADER] = input.contract.fundingRoute;
    // Consent is only ever sent together with a non-blank project.
    if (input.contract.consent && project) headers[CONSENT_HEADER] = CONSENT_VALUE;
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
    // Analytics-only headers are built by the forwarder from the frozen record; a model request never carries them.
    stripAnalyticsOnlyHeaders(context.headers);
    const resolved = context.metadata[DESKTOP_ATTRIBUTION_KEY] as ResolvedDesktopAttribution | undefined;
    const repository = resolved?.repository
      ?? (config.repository || undefined)
      ?? (context.agentName === CLAUDE_DESKTOP ? 'Cowork' : undefined);
    const branch = config.branch || resolved?.branch || undefined;
    // The extension's requests keep the Desktop label; a proxy with no client type (`unknown`) sends none.
    const clientType = context.agentName === VSCODE_CLAUDE_CODE
      ? CLAUDE_DESKTOP
      : context.agentName === 'unknown' ? undefined : context.agentName;
    // A metric may belong to another session or agent than this launch: MetricsApiClient sets these from its record.
    const isMetricsRequest = context.url.split('?')[0] === CODEMIE_ENDPOINTS.METRICS;
    Object.assign(context.headers, buildAttributionHeaders({
      destination: 'model',
      requestId: context.requestId,
      sessionId: context.sessionId,
      cliVersion: config.version,
      sessionAffinity: ['codemie-codex', 'codemie-codex-acp', 'codemie-copilot'].includes(context.agentName),
      integrationId: requiresIntegration ? config.integrationId : undefined,
      model: config.model,
      timeout: config.timeout,
      ...(!isMetricsRequest && { clientType, repository, branch, project: config.project }),
    }).headers);
    // Attribution values (a repository path, a branch, the client label) never reach the log: only whether each is set.
    logger.info('[header-injection] Request headers', ...sanitizeLogArgs({
      cliSessionId: context.headers['x-claude-code-session-id'] ?? null,
      hasRepository: Boolean(context.headers['X-CodeMie-Repository'] ?? context.headers['x-codemie-repository']),
      hasBranch: Boolean(context.headers['X-CodeMie-Branch'] ?? context.headers['x-codemie-branch']),
      hasClient: Boolean(context.headers['X-CodeMie-Client'] ?? context.headers['x-codemie-client']),
      remotePort: context.remotePort,
    }));
  }
}
