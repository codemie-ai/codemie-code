/**
 * Providers Module - Main Entry Point
 *
 * Imports all provider plugins to trigger auto-registration with ProviderRegistry.
 * Exports core types and registry for external use.
 */

// Core exports
export { ProviderRegistry } from './core/registry.js';
export type {
  ProviderTemplate,
  ProviderCapability,
  ModelMetadata,
  ModelInfo,
  HealthCheckResult,
  HealthCheckDetail,
  HealthCheckConfig,
  ProviderHealthCheck,
  InstallProgress,
  ModelInstallerProxy,
  ProviderModelFetcher,
  ProviderCredentials,
  ValidationResult,
  ProviderSetupSteps
} from './core/types.js';
export { registerProvider } from './core/decorators.js';
export { BaseHealthCheck } from './core/base/BaseHealthCheck.js';
export { BaseModelProxy } from './core/base/BaseModelProxy.js';
export { HTTPClient } from './core/base/http-client.js';
export type { HTTPClientConfig, HTTPResponse } from './core/base/http-client.js';

// Import plugins to trigger auto-registration
// Plugin imports execute their auto-registration code on import
import './plugins/ollama/index.js';
import './plugins/sso/index.js';
import './plugins/litellm/index.js';

// Re-export plugin modules for direct access if needed
export * as Ollama from './plugins/ollama/index.js';
export * as SSO from './plugins/sso/index.js';
export * as LiteLLM from './plugins/litellm/index.js';
