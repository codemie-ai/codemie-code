/**
 * Analytics Plugins
 *
 * Export all analytics plugins for easy registration.
 *
 * Default plugins track API request/response patterns:
 * - APIMetricsPlugin: Overall API success/failure rates, latency
 * - ModelMetricsPlugin: Metrics per model (Claude, GPT, Gemini)
 * - ProviderMetricsPlugin: Metrics per provider (ai-run-sso, litellm, etc.)
 */

export { AnalyticsPlugin, AnalyticsPluginRegistry } from './types.js';
export { APIMetricsPlugin } from './api-metrics.plugin.js';
export { ModelMetricsPlugin } from './model-metrics.plugin.js';
export { ProviderMetricsPlugin } from './provider-metrics.plugin.js';
