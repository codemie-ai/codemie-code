/**
 * CodeMie CLI Public API
 * 
 * This module exports APIs for external integrations (e.g., VSCode plugins)
 * 
 * Usage:
 *   import * as codemie from '@codemieai/code/api';
 *   // or
 *   const codemie = require('@codemieai/code/api');
 * 
 * IMPORTANT: This file imports provider plugins to trigger auto-registration
 * of setup steps, health checks, and model proxies.
 */

// Import providers index to trigger auto-registration of all provider plugins
// This ensures ProviderRegistry has all setup steps, health checks, etc. registered
import '../providers/index.js';

// Configuration Management
export { ConfigLoader } from '../utils/config.js';
export type { 
  CodeMieConfigOptions, 
  ProviderProfile,
  CodeMieIntegrationInfo,
  ConfigWithSource
} from '../env/types.js';

// SSO Authentication
export { CodeMieSSO } from '../providers/plugins/sso/sso.auth.js';
export type { 
  SSOAuthConfig, 
  SSOAuthResult,
  SSOCredentials
} from '../providers/core/types.js';

// Agent Management
export { AgentRegistry } from '../agents/registry.js';
export type { AgentAdapter } from '../agents/registry.js';

// Provider Management
// Note: ProviderRegistry is exported from providers/index.js which also triggers
// auto-registration of all provider plugins
export { ProviderRegistry } from '../providers/index.js';
export type { 
  ProviderTemplate,
  ProviderSetupSteps,
  ProviderCredentials,
  AuthValidationResult,
  AuthStatus
} from '../providers/core/types.js';

// SSO Setup Steps (for programmatic setup)
// Note: Importing this file also triggers auto-registration via side-effect
export { SSOSetupSteps } from '../providers/plugins/sso/sso.setup-steps.js';

// SSO HTTP Client utilities (for direct model fetching)
export { 
  fetchCodeMieModels,
  fetchCodeMieUserInfo,
  fetchCodeMieIntegrations
} from '../providers/plugins/sso/sso.http-client.js';
export type { CodeMieUserInfo } from '../providers/plugins/sso/sso.http-client.js';

// Agent Execution
export { AgentCLI } from '../agents/core/AgentCLI.js';
export { BaseAgentAdapter } from '../agents/core/BaseAgentAdapter.js';
// Note: BaseAgentAdapter.runWithOutput() is available for programmatic execution with output capture

// Utilities
export { logger } from '../utils/logger.js';
export * from '../utils/errors.js';
export { getCommandPath, commandExists } from '../utils/processes.js';
