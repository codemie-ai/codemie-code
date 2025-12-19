/**
 * SSO Provider - Complete Provider Implementation
 *
 * All SSO-related code in one place for easy maintenance.
 * Auto-registers with ProviderRegistry on import.
 */

export { SSOTemplate } from './sso.template.js';
export { CodeMieSSO } from './sso.auth.js';
export { SSOModelProxy } from './sso.models.js';
export { SSOHealthCheck } from './sso.health.js';
export { SSOSetupSteps } from './sso.setup-steps.js';

// SSO Capabilities (metrics transmission)
export { MetricsSender } from './metrics/sync/sso.metrics-sender.js';

// SSO Proxy (HTTP proxy with plugins)
export { CodeMieProxy } from './proxy/sso.proxy.js';
export type { ProxyConfig } from './proxy/proxy-types.js';
