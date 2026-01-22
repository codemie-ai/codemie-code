// Main exports for CodeMie package

// Agents
export { AgentRegistry } from './agents/registry.js';
export type { AgentAdapter } from './agents/registry.js';

// Utils
export { logger } from './utils/logger.js';
export { exec } from './utils/processes.js';
export * from './utils/errors.js';
export { CredentialStore } from './utils/security.js';

// Environment
export { EnvManager } from './env/manager.js';
export type { CodeMieConfigOptions } from './env/types.js';

// Configuration
export { ConfigLoader } from './utils/config.js';
export type { ProviderProfile, MultiProviderConfig } from './env/types.js';

// Session Management (for external proxy usage)
export { SessionStore } from './agents/core/session/SessionStore.js';
export type { Session } from './agents/core/session/types.js';

// Metrics Writer (for external metrics collection)
export { MetricsWriter } from './providers/plugins/sso/session/processors/metrics/MetricsWriter.js';

// SSO Authentication
export { CodeMieSSO } from './providers/plugins/sso/sso.auth.js';
export type {
  SSOAuthConfig,
  SSOAuthResult,
  SSOCredentials
} from './providers/core/types.js';

// Proxy
export { CodeMieProxy } from './providers/plugins/sso/proxy/sso.proxy.js';
export type {
  ProxyConfig,
  ProxyContext
} from './providers/plugins/sso/proxy/proxy-types.js';

// Proxy Plugins (for external plugin registration)
export { getPluginRegistry, resetPluginRegistry } from './providers/plugins/sso/proxy/plugins/index.js';
export type {
  ProxyPlugin,
  ProxyInterceptor,
  PluginContext,
  ResponseMetadata
} from './providers/plugins/sso/proxy/plugins/types.js';
