import { AzureOpenAIModelProxy } from '../providers/plugins/azure-openai/azure-openai.models.js';
import type { CodeMieConfigOptions } from './config.js';
import chalk from 'chalk';
import { logger } from './logger.js';
import { sanitizeLogArgs } from './security.js';

// Long.MAX_VALUE sentinel used by DIAL to indicate "no limit"
const DIAL_UNLIMITED_SENTINEL = 9223372036854775808;

interface DialTokenStats {
  total: number;
  used: number;
}

interface DialLimits {
  dayTokenStats?: DialTokenStats;
  monthTokenStats?: DialTokenStats;
}

interface DialModelPricing {
  unit?: string;
  prompt?: string;
  completion?: string;
}

/** Maps modelId → pricing info fetched from /openai/models */
type PricingMap = Map<string, DialModelPricing>;

/**
 * Formats a raw token count into a human-readable string.
 * Uses M (million) suffix rounded to 1 decimal place when appropriate.
 * Returns '∞' for the DIAL unlimited sentinel value.
 */
function formatTokens(n: number): string {
  if (n >= DIAL_UNLIMITED_SENTINEL * 0.99) return '∞';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? m.toString() : m.toFixed(1)) + 'M';
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return (Number.isInteger(k) ? k.toString() : k.toFixed(1)) + 'K';
  }
  return String(n);
}

/**
 * Formats a per-token price string (e.g. "0.000002") into a $/1M display string (e.g. "$2.00/M").
 * Returns null if the price string is missing or zero.
 */
function formatPricePerMillion(pricePerToken: string | undefined): string | null {
  if (!pricePerToken) return null;
  const v = parseFloat(pricePerToken);
  if (!isFinite(v) || v === 0) return null;
  const perMillion = v * 1_000_000;
  const formatted = perMillion < 1 ? perMillion.toPrecision(2) : perMillion.toFixed(2);
  return `$${formatted}/M`;
}

/**
 * Fetches pricing information for all deployments from the /openai/models endpoint.
 * Returns a map from deployment id to pricing object.
 */
async function fetchAllModelPricing(baseUrl: string, apiKey: string): Promise<PricingMap> {
  const map: PricingMap = new Map();
  try {
    const url = new URL('/openai/models', baseUrl).toString();
    const resp = await fetch(url, {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) {
      logger.warn('[dial-integrity] Failed to fetch /openai/models for pricing', ...sanitizeLogArgs({ status: resp.status }));
      return map;
    }
    const data = await resp.json() as { data?: Array<Record<string, unknown>> };
    for (const entry of (data.data ?? [])) {
      const id = String(entry.id ?? '').trim();
      if (id && entry.pricing && typeof entry.pricing === 'object') {
        map.set(id, entry.pricing as DialModelPricing);
      }
    }
  } catch (e: any) {
    logger.warn('[dial-integrity] Error fetching /openai/models pricing', ...sanitizeLogArgs({ error: e?.message || String(e) }));
  }
  return map;
}

/**
 * Fetches token limits for a single deployment from /v1/deployments/{id}/limits.
 * Returns null on any error (network, 4xx, etc.) so the caller can gracefully omit the field.
 */
async function fetchDeploymentLimits(baseUrl: string, apiKey: string, deploymentId: string): Promise<DialLimits | null> {
  try {
    const url = new URL(`/v1/deployments/${encodeURIComponent(deploymentId)}/limits`, baseUrl).toString();
    const resp = await fetch(url, {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) return null;
    return await resp.json() as DialLimits;
  } catch (e: any) {
    logger.warn('[dial-integrity] Error fetching limits', ...sanitizeLogArgs({ deployment: deploymentId, error: e?.message || String(e) }));
    return null;
  }
}

function apiLabel(modelId: string) {
  const id = modelId.toLowerCase();
  if (id.startsWith('openai') || id.startsWith('gpt') || id.startsWith('tts-') || id.startsWith('audio-') || id.includes('embedding')) {
    return 'full api features';
  }
  // "limited api features" = compatibility mode: advanced reasoning/thinking parameters
  // (e.g. reasoning_effort, thinking, budget_tokens) are not forwarded by the sanitizer.
  // If the model has built-in default thinking/reasoning, it still works — it just cannot
  // be configured via API parameters.
  return 'limited api features';
}

/**
 * Determines whether a model requires `max_completion_tokens` instead of `max_tokens`.
 * Applies to OpenAI reasoning/o-series models and gpt-5* variants that rejected `max_tokens`.
 */
function needsMaxCompletionTokens(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // o1 / o3 / o4 family (non-reasoning proxy variants still reject max_tokens)
  if (/^o[0-9]/.test(id)) return true;
  // gpt-5 and newer OpenAI generations that dropped max_tokens support
  if (/^gpt-5/.test(id)) return true;
  return false;
}

/**
 * Returns true for models that use extended thinking with a budget_tokens parameter.
 * These models require max_tokens > budget_tokens (default budget is typically 1024),
 * so the test payload must use a higher max_tokens value.
 */
function isThinkingModel(modelId: string): boolean {
  return modelId.toLowerCase().endsWith('-with-thinking');
}

/**
 * Builds a minimal test payload for the given model, accounting for models that:
 *  - require `max_completion_tokens` instead of `max_tokens` (OpenAI o-series, gpt-5+)
 *  - require an explicit `thinking` block with `max_tokens > budget_tokens` (extended-thinking models)
 *
 * For `-with-thinking` models, DIAL applies a large default `budget_tokens` when
 * no `thinking` block is provided, causing `max_tokens must be greater than
 * thinking.budget_tokens` errors even with high `max_tokens` values. The fix is
 * to always supply an explicit `thinking: { type: "enabled", budget_tokens: 1024 }`
 * alongside `max_tokens: 2048` so the invariant `max_tokens > budget_tokens` is met.
 */
function buildTestPayload(modelId: string): Record<string, unknown> {
  const base = { model: modelId, messages: [{ role: 'user', content: 'ping' }] };
  if (needsMaxCompletionTokens(modelId)) {
    return { ...base, max_completion_tokens: 16 };
  }
  if (isThinkingModel(modelId)) {
    // Explicit thinking block required: DIAL's default budget_tokens exceeds max_tokens
    // when no thinking block is specified, causing HTTP 400. budget_tokens: 1024 with
    // max_tokens: 2048 satisfies the invariant max_tokens > budget_tokens.
    return { ...base, max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } };
  }
  return { ...base, max_tokens: 16 };
}

export async function runDialIntegrationTest(config: CodeMieConfigOptions): Promise<boolean> {
  const { baseUrl, apiKey, azureApiVersion = '2024-06-01' } = config;
  if (!baseUrl || !apiKey) {
    logger.warn('[dial-integrity] Missing DIAL baseUrl or apiKey.');
    console.log(chalk.red('Missing DIAL baseUrl or apiKey.'));
    return false;
  }
  const proxy = new AzureOpenAIModelProxy(baseUrl, apiKey, azureApiVersion);
  let models;
  try {
    models = await proxy.fetchModels({ baseUrl, apiKey, azureApiVersion });
  } catch (err: any) {
    logger.error('[dial-integrity] Failed to list DIAL models', ...sanitizeLogArgs({ error: err?.message || String(err) }));
    console.log(chalk.red('Failed to list DIAL models: ' + (err?.message || err)));
    return false;
  }
  if (!models || models.length === 0) {
    logger.warn('[dial-integrity] No DIAL models found.');
    console.log(chalk.yellow('No DIAL models found.'));
    return false;
  }
  console.log(`\nFound ${models.length} models to test. Fetching pricing...\n`);

  // Fetch pricing map once upfront (single request, no per-model parallelism needed)
  const pricingMap = await fetchAllModelPricing(baseUrl, apiKey);

  let success = true;
  let stats = { full: 0, fullOk: 0, limited: 0, limitedOk: 0, errors: 0 };

  for (let idx = 0; idx < models.length; idx++) {
    const m = models[idx];
    const pricing = pricingMap.get(m.id);

    const labelStr = apiLabel(m.id);
    const isLimited = labelStr === 'limited api features';
    if (isLimited) stats.limited++;
    else stats.full++;

    const payload = buildTestPayload(m.id);
    const url = `${baseUrl}/openai/deployments/${encodeURIComponent(m.id)}/chat/completions?api-version=${azureApiVersion}`;
    const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
    const t0 = Date.now();
    let status = 'ok';
    let msg = '';
    let errLong = '';
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      const body = await resp.text();
      if (resp.ok) {
        msg = chalk.green(`OK (${Date.now() - t0} ms)`);
        if (isLimited) stats.limitedOk++;
        else stats.fullOk++;
      } else {
        status = 'error';
        success = false;
        errLong = body;
        msg = chalk.red(`HTTP ${resp.status}`);
        stats.errors++;
      }
    } catch (e: any) {
      status = 'error';
      success = false;
      errLong = String(e?.message || e);
      msg = chalk.red('ERROR');
      stats.errors++;
      logger.error('[dial-integrity] Request error for model', ...sanitizeLogArgs({ model: m.id, error: errLong }));
    }

    // Fetch limits sequentially (one per model, together with the test call above)
    const limits = await fetchDeploymentLimits(baseUrl, apiKey, m.id);

    // Build limits annotation: day/month token caps; show n/a if data unavailable
    const na = chalk.gray('n/a');
    let limitsStr: string;
    if (limits) {
      const day = limits.dayTokenStats?.total;
      const month = limits.monthTokenStats?.total;
      const dayFmt = day !== undefined ? chalk.cyan(formatTokens(day)) : na;
      const monthFmt = month !== undefined ? chalk.cyan(formatTokens(month)) : na;
      limitsStr = `day:${dayFmt} mo:${monthFmt}`;
    } else {
      limitsStr = `day:${na} mo:${na}`;
    }

    // Build pricing annotation: prompt+completion in $/1M tokens; show n/a if data unavailable
    let priceStr: string;
    if (pricing) {
      const promptPrice = formatPricePerMillion(pricing.prompt);
      const completionPrice = formatPricePerMillion(pricing.completion);
      const inFmt = promptPrice ? chalk.yellow(promptPrice) : na;
      const outFmt = completionPrice ? chalk.yellow(completionPrice) : na;
      priceStr = `in:${inFmt} out:${outFmt}`;
    } else {
      priceStr = `in:${na} out:${na}`;
    }

    const icon = status === 'ok' ? chalk.green('✓') : chalk.red('✗');
    const idxStr = chalk.gray(`[${idx + 1}/${models.length}]`);
    const featureStr = chalk.gray(labelStr);
    console.log(`${icon} ${idxStr} ${m.name} | ${featureStr} | ${msg}`);
    console.log(`    ${chalk.gray('Limits')} ${limitsStr} | ${priceStr}`);
    if (status === 'error' && errLong) {
      console.log(chalk.redBright('    Error details: ') + chalk.gray(errLong));
    }
  }
  // Summary finisher
  const statLine = `\n${chalk.gray('[full api features]')}: total ${stats.full}, OK: ${stats.fullOk}` +
                   chalk.gray(' | ') +
                   `${chalk.gray('[limited api features]')}: total ${stats.limited}, OK: ${stats.limitedOk}, errors: ${stats.errors}`;
  console.log(statLine);
  return success;
}
