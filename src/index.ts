// Main exports for CodeMie package

// Agents
export { AgentRegistry } from './agents/registry.js';
export type { AgentAdapter } from './agents/registry.js';

// Utils
export { logger } from './utils/logger.js';
export { exec } from './utils/processes.js';
export * from './utils/errors.js';

// Environment
export { EnvManager } from './env/manager.js';

// SSO Authentication
export { CodeMieSSO } from './providers/plugins/sso/sso.auth.js';

// Proxy
export { CodeMieProxy } from './providers/plugins/sso/proxy/sso.proxy.js';

// Proxy Plugins (for external plugin registration)
export { getPluginRegistry } from './providers/plugins/sso/proxy/plugins/index.js';

// Hook Event Processing (for programmatic usage)
export { processEvent, HookProcessingConfig } from './cli/commands/hook.js';

// Configuration
export { ConfigLoader } from './utils/config.js';
