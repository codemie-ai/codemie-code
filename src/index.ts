// Main exports for CodeMie package

// Utils
export { logger } from './utils/logger.js';

// Configuration
export { ConfigLoader } from './utils/config.js';

// Session Management (for external proxy usage)
export { SessionStore } from './agents/core/session/SessionStore.js';

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
export { getPluginRegistry } from './providers/plugins/sso/proxy/plugins/index.js';
export type {
  ProxyPlugin,
  ProxyInterceptor,
  PluginContext,
  ResponseMetadata
} from './providers/plugins/sso/proxy/plugins/types.js';