/**
 * SSO HTTP Client
 *
 * CodeMie-specific HTTP client with SSO cookie handling
 */

import type { CodeMieModel, CodeMieIntegration, CodeMieIntegrationsResponse } from '../../core/types.js';
import { HTTPClient } from '../../core/base/http-client.js';
import {
  fetchCodeMieUserInfo,
  buildAuthHeaders
} from '../../core/codemie-auth-helpers.js';
export { fetchCodeMieUserInfo };
export type { CodeMieUserInfo } from '../../core/codemie-auth-helpers.js';

/**
 * CodeMie API endpoints
 */
export const CODEMIE_ENDPOINTS = {
  MODELS: '/v1/llm_models?include_all=true',
  USER_SETTINGS: '/v1/settings/user',
  USER: '/v1/user',
  ADMIN_APPLICATIONS: '/v1/admin/applications',
  METRICS: '/v1/metrics',
  AUTH_LOGIN: '/v1/auth/login',
  CLI_ANALYTICS_EVENT_HOOKS: '/v1/analytics/cli-analytics/event-hooks',
  CLI_ANALYTICS_METRICS: '/v1/analytics/cli-analytics/metrics',
  CLI_ANALYTICS_LOGS: '/v1/analytics/cli-analytics/logs',
  CLI_ANALYTICS_TRACES: '/v1/analytics/cli-analytics/traces'
} as const;


/**
 * One tier's target model within a router's `tiers` map — mirrors the backend's `RouterTier`
 * (src/codemie/configs/llm_config.py).
 */
export interface RouterTier {
  model: string;
  label?: string;
}

/**
 * The platform's fixed 4-tier shape every router option carries (backend's `RouterTiers`),
 * regardless of how many distinct models actually back it — a 2-model router maps onto all
 * 4 keys, so several tiers commonly share the same target model.
 */
export interface RouterTiers {
  simple: RouterTier;
  medium: RouterTier;
  complex: RouterTier;
  reasoning: RouterTier;
}

const TIER_ORDER: (keyof RouterTiers)[] = ['simple', 'medium', 'complex', 'reasoning'];

/**
 * Render a router's tier map as e.g. `"simple/medium: GPT-5.6 Luna · complex/reasoning:
 * GPT-5.6 Terra"` — tiers pointing at the same model are grouped under one label instead of
 * repeating it, and each group shows the target's own catalog label (falling back to its id
 * when the backend didn't send one) rather than the router's own name, which says nothing
 * about what it actually resolves to per tier.
 */
export function describeRouterTiers(tiers: RouterTiers): string {
  const firstTierByModel = new Map<string, keyof RouterTiers>();
  for (const tierName of TIER_ORDER) {
    const model = tiers[tierName]?.model;
    if (model && !firstTierByModel.has(model)) firstTierByModel.set(model, tierName);
  }

  const parts: string[] = [];
  for (const tierName of TIER_ORDER) {
    const tier = tiers[tierName];
    if (!tier) continue;
    if (firstTierByModel.get(tier.model) !== tierName) continue; // grouped under an earlier tier

    const groupedTierNames = TIER_ORDER.filter((name) => tiers[name]?.model === tier.model);
    parts.push(`${groupedTierNames.join('/')}: ${tier.label || tier.model}`);
  }
  return parts.join(' · ');
}

/** `RoutingMode` on the backend (llm_config.py): the router's dispatch strategy. */
export type RouterStrategy = 'signal' | 'classifier';

const ROUTER_TYPE_LABELS: Record<string, string> = {
  litellm_auto: 'LiteLLM',
  switchyard: 'Switchyard',
};

/**
 * Every id (deployment_name, base_name) a catalog entry's own label can be looked up by.
 * Used to resolve a bare id referenced elsewhere in the catalog — a router's
 * `classifier_model`, say — back to the human label CodeMie configured for it, the same way
 * `modelIdentifiers`-style lookups already resolve a routed-to id for the statusline.
 */
export function buildModelLabelIndex(models: LlmModel[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const model of models) {
    if (!model.label) continue;
    for (const id of [model.deployment_name, model.base_name]) {
      if (id && !labels.has(id)) labels.set(id, model.label);
    }
  }
  return labels;
}

/**
 * Full router description for a model/agent picker, e.g. `"LiteLLM (classifier -> Claude
 * Haiku 4.5): simple/medium: GPT-5.6 Luna · complex/reasoning: GPT-5.6 Terra"`, or
 * `"Switchyard (signal): ..."` when the router has no classifier model. `labelIndex` (see
 * {@link buildModelLabelIndex}, built from the FULL catalog — a classifier model may belong
 * to a family a caller otherwise filters out, e.g. a Claude classifier gating a GPT router)
 * resolves `classifier_model` to its own label instead of showing a bare id. `''` when the
 * entry isn't a router or the backend hasn't populated a tier map for it yet — there is
 * nothing more specific to add beyond the id/label already shown elsewhere.
 */
export function describeRouter(model: LlmModel, labelIndex: Map<string, string>): string {
  const tiers = model.tiers ?? model.litellm_router?.tiers;
  if (!tiers) return '';

  const typeLabel = model.router_type
    ? (ROUTER_TYPE_LABELS[model.router_type] ?? model.router_type)
    : model.litellm_router
      ? 'LiteLLM'
      : model.is_router
        ? 'Switchyard'
        : undefined;

  const strategy = model.strategy ?? model.litellm_router?.strategy;
  const classifierModel = model.classifier_model ?? model.litellm_router?.classifier_model;
  const classifierLabel = classifierModel ? (labelIndex.get(classifierModel) ?? classifierModel) : undefined;

  const strategyNote = strategy
    ? ` (${classifierLabel ? `${strategy} -> ${classifierLabel}` : strategy})`
    : '';

  const prefix = typeLabel ? `${typeLabel}${strategyNote}: ` : '';
  return `${prefix}${describeRouterTiers(tiers)}`;
}

/**
 * Full model descriptor returned by GET /v1/llm_models?include_all=true
 */
export interface LlmModel {
  base_name: string;
  deployment_name: string;
  label: string;
  multimodal?: boolean;
  react_agent?: boolean;
  enabled: boolean;
  provider?: string;
  default?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
  };
  features?: {
    streaming?: boolean;
    tools?: boolean;
    temperature?: boolean;
    parallel_tool_calls?: boolean;
    system_prompt?: boolean;
    max_tokens?: boolean;
    top_p?: boolean;
  };
  forbidden_for_web?: boolean;
  /**
   * Present (and `true`) on a Switchyard-generated virtual router entry (`LlmRouterOption` in
   * the backend's `Union[LLMModel, LlmRouterOption]` response) — a `base_name` that itself
   * dispatches to a capable/efficient pair rather than naming a concrete deployment.
   */
  is_router?: boolean;
  /**
   * Present on a Switchyard virtual router (`LlmRouterOption.router_type` on the backend):
   * `"switchyard"` or `"litellm_auto"` — a client display badge only, never a behavioral
   * branch on the backend.
   */
  router_type?: string;
  /** `"signal"` or `"classifier"` — the router's dispatch strategy. */
  strategy?: RouterStrategy;
  /**
   * The classifier model this router's classifier-mode strategy scores requests with (bare
   * id — resolve via {@link buildModelLabelIndex} for display). Absent for a signal-mode router.
   */
  classifier_model?: string;
  /**
   * Present on a Switchyard virtual router (`LlmRouterOption.tiers` on the backend): the
   * model+label it resolves to for each of the platform's 4 fixed tiers. See {@link RouterTiers}.
   */
  tiers?: RouterTiers;
  /**
   * Present on a regular `LLMModel` entry that is declared as a LiteLLM auto-router
   * (`LiteLLMRouterConfig` on the backend) — LiteLLM exposes no reliable API signal for this,
   * so the backend declares it explicitly. `is_router` is nested here rather than top-level
   * because this object exists purely to carry it (see the backend's own comment on
   * `LiteLLMRouterConfig`), unlike the Switchyard case above where it lives on the model itself.
   */
  litellm_router?: {
    is_router?: boolean;
    /**
     * The concrete deployment id this auto-router currently resolves to by default (e.g.
     * `claude-sonnet-5`, `gpt-5.6-terra-2026-07-09`). The router's own alias name is
     * family-agnostic by convention (`claude-smart-router` and `gpt-smart-router` are both
     * named like routers, not like their target), so this is the one reliable signal for
     * which backend family a consumer restricted to one family (e.g. codemie-codex, which
     * can only drive GPT/Codex over the Responses API) should judge it by.
     */
    counterfactual_model?: string;
    /** Same 4-tier shape as the top-level `tiers` field above, for a declared LiteLLM auto-router. */
    tiers?: RouterTiers;
    /** Same semantics as the top-level `strategy`/`classifier_model` fields above. */
    strategy?: RouterStrategy;
    classifier_model?: string;
  };
}

/**
 * Fetch full model objects from /v1/llm_models?include_all=true (supports both cookies and JWT)
 *
 * Unlike fetchCodeMieModels (which returns only IDs), this returns the complete model
 * descriptor including cost, features, and provider metadata.
 *
 * Overload 1: SSO cookies
 * Overload 2: JWT token string
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieLlmModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<LlmModel[]>;
export function fetchCodeMieLlmModels(
  apiUrl: string,
  jwtToken: string
): Promise<LlmModel[]>;
export async function fetchCodeMieLlmModels(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<LlmModel[]> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false,
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
    }
    throw new Error(`Failed to fetch models: ${response.statusCode} ${response.statusMessage}`);
  }

  const parsed = JSON.parse(response.data);
  if (!Array.isArray(parsed)) return [];
  return parsed as LlmModel[];
}

/**
 * Fetch models from CodeMie API (supports both cookies and JWT)
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]>;
export function fetchCodeMieModels(
  apiUrl: string,
  jwtToken: string
): Promise<string[]>;
export async function fetchCodeMieModels(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<string[]> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

  const client = new HTTPClient({
    timeout: 30000,
    maxRetries: 5,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
    }
    throw new Error(`Failed to fetch models: ${response.statusCode} ${response.statusMessage}`);
  }

  // Parse the response
  const models: CodeMieModel[] = JSON.parse(response.data) as CodeMieModel[];

  if (!Array.isArray(models)) {
    return [];
  }

  // Filter and map models based on the actual API response structure
  const filteredModels = models
    .filter(model => {
      if (!model) return false;
      // Check for different possible model ID fields
      const hasId = model.id && model.id.trim() !== '';
      const hasBaseName = model.base_name && model.base_name.trim() !== '';
      const hasDeploymentName = model.deployment_name && model.deployment_name.trim() !== '';

      return hasId || hasBaseName || hasDeploymentName;
    })
    .map(model => {
      // Use the most appropriate identifier field
      return model.id || model.base_name || model.deployment_name || model.label || 'unknown';
    })
    .filter(id => id !== 'unknown')
    .sort();

  return filteredModels;
}

/**
 * Fetch application details (non-blocking, best-effort) - supports both cookies and JWT
 *
 * @param apiUrl - CodeMie API base URL
 * @param auth - SSO session cookies or JWT token
 * @returns Application names array (same as /v1/user for now)
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchApplicationDetails(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]>;
export function fetchApplicationDetails(
  apiUrl: string,
  jwtToken: string
): Promise<string[]>;
export async function fetchApplicationDetails(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<string[]> {
  try {
    const headers = buildAuthHeaders(auth);
    const url = `${apiUrl}${CODEMIE_ENDPOINTS.ADMIN_APPLICATIONS}?limit=1000`;

    const client = new HTTPClient({
      timeout: 5000,
      maxRetries: 1,
      rejectUnauthorized: false
    });

    const response = await client.getRaw(url, headers);

    if (response.statusCode !== 200) {
      return [];
    }

    const data = JSON.parse(response.data) as { applications: string[] };
    return data.applications || [];
  } catch {
    // Non-blocking: return empty array on error
    return [];
  }
}
/* eslint-enable no-redeclare */

/**
 * Fetch integrations from CodeMie API (paginated) - supports both cookies and JWT
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieIntegrations(
  apiUrl: string,
  cookies: Record<string, string>,
  endpointPath?: string
): Promise<CodeMieIntegration[]>;
export function fetchCodeMieIntegrations(
  apiUrl: string,
  jwtToken: string,
  endpointPath?: string
): Promise<CodeMieIntegration[]>;
export async function fetchCodeMieIntegrations(
  apiUrl: string,
  auth: Record<string, string> | string,
  endpointPath: string = CODEMIE_ENDPOINTS.USER_SETTINGS
): Promise<CodeMieIntegration[]> {
  const allIntegrations: CodeMieIntegration[] = [];
  let currentPage = 0;
  const perPage = 50;
  const maxPages = 20; // Safety limit to prevent infinite loops if API ignores pagination params
  let hasMorePages = true;
  let lastError: Error | undefined;
  const seenIds = new Set<string>();

  while (hasMorePages && currentPage < maxPages) {
    try {
      // Build URL with query parameters to filter by LiteLLM type
      const filters = JSON.stringify({ type: ['LiteLLM'] });
      const queryParams = new URLSearchParams({
        page: currentPage.toString(),
        per_page: perPage.toString(),
        filters: filters
      });

      const fullUrl = `${apiUrl}${endpointPath}?${queryParams.toString()}`;

      if (process.env.CODEMIE_DEBUG) {
        console.log(`[DEBUG] Fetching integrations from: ${fullUrl}`);
      }

      const pageIntegrations = await fetchIntegrationsPage(fullUrl, auth);

      if (pageIntegrations.length === 0) {
        hasMorePages = false;
      } else {
        // Deduplicate: detect when API returns same items on every page (no real pagination)
        const newIntegrations = pageIntegrations.filter(i => !seenIds.has(i.id));
        if (newIntegrations.length === 0) {
          // All items already seen - API does not support pagination, stop here
          hasMorePages = false;
        } else {
          newIntegrations.forEach(i => seenIds.add(i.id));
          allIntegrations.push(...newIntegrations);

          // If we got fewer items than requested, we've reached the last page
          if (pageIntegrations.length < perPage) {
            hasMorePages = false;
          } else {
            currentPage++;
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      hasMorePages = false;
    }
  }

  if (lastError && allIntegrations.length === 0) {
    throw lastError;
  }

  return allIntegrations;
}
/* eslint-enable no-redeclare */

/**
 * Fetch single page of integrations - supports both cookies and JWT
 */
async function fetchIntegrationsPage(fullUrl: string, auth: Record<string, string> | string): Promise<CodeMieIntegration[]> {
  const headers = buildAuthHeaders(auth);

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(fullUrl, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
    }
    if (response.statusCode === 404) {
      throw new Error(`Integrations endpoint not found. Response: ${response.data}`);
    }
    throw new Error(`Failed to fetch integrations: ${response.statusCode} ${response.statusMessage}`);
  }

  // Parse the response - handle flexible response structure
  if (process.env.CODEMIE_DEBUG) {
    console.log('[DEBUG] Integration API response:', response.data.substring(0, 500));
  }

  const responseData = JSON.parse(response.data) as CodeMieIntegrationsResponse;

  // Extract integrations from response - try all possible locations
  let integrations: CodeMieIntegration[] = [];

  // Try different possible property names and structures
  const possibleArrays = [
    responseData, // Direct array
    responseData.data,
    responseData.integrations,
    responseData.credentials,
    responseData.items,
    responseData.results,
    responseData.user_integrations,
    responseData.personal_integrations,
    responseData.available_integrations
  ].filter(arr => Array.isArray(arr));

  if (possibleArrays.length > 0) {
    integrations = possibleArrays[0] as CodeMieIntegration[];
  } else {
    // Try to find nested objects that might contain arrays
    for (const value of Object.values(responseData)) {
      if (typeof value === 'object' && value !== null) {
        const nestedArrays = Object.values(value).filter(Array.isArray);
        if (nestedArrays.length > 0) {
          integrations = nestedArrays[0] as CodeMieIntegration[];
          break;
        }
      }
    }
  }

  // Filter and validate integrations: must be LiteLLM type with a non-empty alias
  const validIntegrations = integrations
    .filter(integration => {
      return integration &&
             integration.alias &&
             integration.alias.trim() !== '' &&
             integration.credential_type === 'LiteLLM';
    })
    .sort((a, b) => a.alias.localeCompare(b.alias));

  return validIntegrations;
}
