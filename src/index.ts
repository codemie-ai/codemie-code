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

// Hook Event Processing (for programmatic usage)
export { HookEventProcessor } from './hooks/api.js';
export type { HookProcessingConfig } from './hooks/api.js';
export type {
  SessionStartEvent,
  SessionEndEvent,
  SubagentStopEvent
} from './cli/commands/hook.js';

// Hook Event Types
export type {
  BaseHookEvent,
  HookTransformer
} from './agents/core/types.js';

// Session Processing
export type { ProcessingContext } from './agents/core/session/BaseProcessor.js';
export type { SessionAdapter } from './agents/core/session/BaseSessionAdapter.js';

// Session Syncer (for manual sync)
export { SessionSyncer } from './providers/plugins/sso/session/SessionSyncer.js';
export type { SessionSyncResult } from './providers/plugins/sso/session/SessionSyncer.js';

// Agent Registry (for getting session adapters)
export { AgentRegistry } from './agents/registry.js';