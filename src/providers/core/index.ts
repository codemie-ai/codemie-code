/**
 * Provider Core Module
 *
 * Main exports for provider plugin architecture
 */

// Types
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
} from './types.js';

// Registry
export { ProviderRegistry } from './registry.js';

// Decorators
export { registerProvider } from './decorators.js';

// Base Classes
export { BaseHealthCheck } from './base/BaseHealthCheck.js';
export { BaseModelProxy } from './base/BaseModelProxy.js';
export { HTTPClient } from './base/http-client.js';
export type { HTTPClientConfig, HTTPResponse } from './base/http-client.js';
