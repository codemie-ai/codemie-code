/**
 * Azure OpenAI request routing.
 *
 * Converts OpenAI-compatible request paths into classic Azure deployment URLs
 * without requiring one provider configuration entry per deployment.
 */

import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import { ConfigurationError } from '../../../../../utils/errors.js';

const AZURE_OPENAI_PROVIDER = 'azure-openai';
const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';
const LOCAL_URL_BASE = 'http://127.0.0.1';
const NATIVE_CLAUDE_CLIENTS = new Set(['codemie-claude', 'codemie-claude-acp']);

const SUPPORTED_OPERATIONS = new Set([
  'chat/completions',
  'completions',
  'embeddings',
  'images/generations',
  'audio/transcriptions',
  'audio/speech',
]);

interface AzureRoutingConfig {
  endpoint: string;
  apiKey?: string;
  apiVersion: string;
  deployment?: string;
}

interface AzureRequestRoute {
  operation?: string;
  pathDeployment?: string;
  isModelList: boolean;
}

export class AzureOpenAIRoutingPlugin implements ProxyPlugin {
  id = '@codemie/proxy-azure-openai-routing';
  name = 'Azure OpenAI Routing';
  version = '1.0.0';
  priority = 13;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (
      context.config.provider !== AZURE_OPENAI_PROVIDER
      || NATIVE_CLAUDE_CLIENTS.has(context.config.clientType || '')
    ) {
      return new NoOpInterceptor('azure-openai-routing');
    }

    const profile = context.profileConfig;
    const endpoint = profile?.baseUrl || context.config.targetApiUrl;
    const config: AzureRoutingConfig = {
      endpoint,
      apiKey: profile?.apiKey,
      apiVersion: profile?.azureApiVersion || DEFAULT_AZURE_API_VERSION,
      deployment: profile?.azureDeployment || context.config.model,
    };

    return new AzureOpenAIRoutingInterceptor(config);
  }
}

class NoOpInterceptor implements ProxyInterceptor {
  constructor(public name: string) {}
}

class AzureOpenAIRoutingInterceptor implements ProxyInterceptor {
  name = 'azure-openai-routing';

  constructor(private readonly config: AzureRoutingConfig) {}

  async onRequest(context: ProxyContext): Promise<void> {
    const requestUrl = new URL(context.url, LOCAL_URL_BASE);
    const route = resolveRoute(requestUrl.pathname);

    if (route.isModelList) {
      context.targetUrl = buildModelListUrl(this.config, requestUrl);
      applyAzureHeaders(context, this.config);
      return;
    }

    if (!route.operation) {
      return;
    }

    const requestModel = readRequestModel(context.requestBody);
    const deployment = route.pathDeployment || requestModel || this.config.deployment;
    if (!deployment) {
      throw new ConfigurationError(
        'Azure OpenAI deployment is missing. Configure azureDeployment or provide model in the request.'
      );
    }

    context.targetUrl = buildDeploymentUrl(this.config, route.operation, deployment, requestUrl);
    context.metadata.azureDeployment = deployment;
    applyAzureHeaders(context, this.config);
  }
}

function resolveRoute(pathname: string): AzureRequestRoute {
  const normalized = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const deploymentMatch = normalized.match(/^openai\/deployments\/([^/]+)\/(.+)$/i);

  if (deploymentMatch) {
    const operation = normalizeOperation(deploymentMatch[2]);
    return {
      operation,
      pathDeployment: decodeURIComponent(deploymentMatch[1]),
      isModelList: false,
    };
  }

  if (isModelListPath(normalized)) {
    return { isModelList: true };
  }

  return {
    operation: normalizeOperation(normalized),
    isModelList: false,
  };
}

function normalizeOperation(pathname: string): string | undefined {
  const operation = pathname.replace(/^openai\/v1\//i, '').replace(/^v1\//i, '');
  return SUPPORTED_OPERATIONS.has(operation) ? operation : undefined;
}

function isModelListPath(pathname: string): boolean {
  return /^(?:openai\/)?(?:v1\/)?models$/i.test(pathname)
    || /^openai\/(?:models|deployments)$/i.test(pathname);
}

function readRequestModel(requestBody: Buffer | null): string | undefined {
  if (!requestBody) return undefined;

  try {
    const parsed = JSON.parse(requestBody.toString('utf-8')) as { model?: unknown };
    if (typeof parsed.model !== 'string') return undefined;

    const model = parsed.model.trim();
    if (!model) return undefined;
    if (model.toLowerCase().startsWith(`${AZURE_OPENAI_PROVIDER}/`)) {
      return model.slice(AZURE_OPENAI_PROVIDER.length + 1);
    }
    return model;
  } catch {
    return undefined;
  }
}

function buildDeploymentUrl(
  config: AzureRoutingConfig,
  operation: string,
  deployment: string,
  requestUrl: URL,
): string {
  const target = createEndpointUrl(config.endpoint);
  target.pathname = `${getEndpointRoot(target.pathname)}/openai/deployments/${encodeURIComponent(deployment)}/${operation}`;
  copyQuery(requestUrl, target);
  // DIAL uses the classic Azure API; send the dated api-version in both header and query.
  target.searchParams.set('api-version', config.apiVersion);
  return target.toString();
}

function buildModelListUrl(config: AzureRoutingConfig, requestUrl: URL): string {
  const target = createEndpointUrl(config.endpoint);
  target.pathname = `${getEndpointRoot(target.pathname)}/openai/deployments`;
  copyQuery(requestUrl, target);
  target.searchParams.set('api-version', config.apiVersion);
  return target.toString();
}

function createEndpointUrl(endpoint: string): URL {
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new ConfigurationError(`Invalid Azure OpenAI endpoint: ${endpoint}`);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ConfigurationError('Azure OpenAI endpoint must use http or https.');
  }

  return target;
}

function getEndpointRoot(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  for (const suffix of ['/openai/v1', '/openai', '/v1']) {
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

function copyQuery(source: URL, target: URL): void {
  for (const [key, value] of source.searchParams) {
    target.searchParams.set(key, value);
  }
}

function applyAzureHeaders(context: ProxyContext, config: AzureRoutingConfig): void {
  if (config.apiKey) {
    context.headers['api-key'] = config.apiKey;
    delete context.headers.authorization;
    delete context.headers.Authorization;
  }

  context.headers['api-version'] = config.apiVersion;
}
