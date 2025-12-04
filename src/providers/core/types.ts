/**
 * Core Types for Provider Plugin Architecture
 *
 * Defines all TypeScript interfaces and types for the provider plugin system.
 */

import type { CodeMieConfigOptions } from '../../env/types.js';

/**
 * Provider capabilities
 */
export type ProviderCapability =
  | 'streaming'          // Supports streaming
  | 'tools'              // Supports function calling
  | 'vision'             // Supports image inputs
  | 'embeddings'         // Supports embeddings
  | 'model-management'   // Can install/uninstall models
  | 'fine-tuning'        // Supports fine-tuning
  | 'function-calling'   // Supports function/tool calling
  | 'json-mode'          // Supports JSON mode
  | 'sso-auth';          // Requires SSO authentication

/**
 * Model metadata for enriched display
 */
export interface ModelMetadata {
  name: string;                      // Display name
  description?: string;              // Model description
  popular?: boolean;                 // Mark as popular/recommended
  contextWindow?: number;            // Token context window
  pricing?: {                        // Pricing information (optional)
    input: number;
    output: number;
  };
}

/**
 * Authentication type for providers
 */
export type AuthenticationType = 'api-key' | 'sso' | 'oauth' | 'none';

/**
 * Provider template - declarative metadata
 *
 * Auto-registers with ProviderRegistry via @registerProvider decorator
 */
export interface ProviderTemplate {
  // Identity
  name: string;                      // Internal ID (e.g., 'ollama', 'ai-run-sso')
  displayName: string;               // User-facing name (e.g., 'Ollama', 'CodeMie SSO')
  description: string;               // Short description for UI

  // Connectivity
  defaultPort?: number;              // Default port (e.g., 11434 for Ollama)
  defaultBaseUrl: string;            // Default API endpoint
  requiresAuth?: boolean;            // Whether authentication is required (default: false)
  authType?: AuthenticationType;     // Authentication method (default: 'api-key')

  // UI & UX
  priority?: number;                 // Display priority (0=highest, used for sorting)
  defaultProfileName?: string;       // Suggested profile name in setup wizard

  // Model Configuration
  recommendedModels: string[];       // Default recommended models
  modelMetadata?: Record<string, ModelMetadata>; // Enriched model information

  // Capabilities
  capabilities: ProviderCapability[]; // Supported features
  supportsModelInstallation: boolean; // Can install models locally
  supportsStreaming?: boolean;       // Supports streaming responses (default: true)

  // Environment Variable Mapping
  envMapping?: {                     // Environment variable mapping for external agents
    baseUrl?: string[];              // ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']
    apiKey?: string[];               // ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
    model?: string[];                // ['OPENAI_MODEL', 'ANTHROPIC_MODEL']
  };

  // Health & Setup
  healthCheckEndpoint?: string;      // Endpoint for health check
  setupInstructions?: string;        // Markdown installation guide

  // Custom Extensions
  customProperties?: Record<string, unknown>; // Provider-specific metadata
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;                        // Model ID
  name: string;                      // Display name
  description?: string;              // Model description
  size?: number;                     // Model size in bytes
  contextWindow?: number;            // Token context window
  popular?: boolean;                 // Mark as popular/recommended
  metadata?: Record<string, unknown>; // Additional metadata
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  provider: string;                  // Provider name
  status: 'healthy' | 'unhealthy' | 'unreachable'; // Status
  message: string;                   // Status message
  version?: string;                  // Provider version
  models?: ModelInfo[];              // Available models
  remediation?: string;              // Instructions to fix issues
  details?: HealthCheckDetail[];     // Detailed check results
}

/**
 * Health check detail
 */
export interface HealthCheckDetail {
  status: 'ok' | 'warning' | 'error'; // Status
  message: string;                   // Detail message
  hint?: string;                     // Actionable hint
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  provider: string;                  // Provider name
  baseUrl: string;                   // Base URL to check
  timeout?: number;                  // Timeout in milliseconds (default: 5000)
  headers?: Record<string, string>;  // Additional headers
}

/**
 * Provider health check interface
 *
 * Extends base implementation for common patterns
 */
export interface ProviderHealthCheck {
  /**
   * Check if this health check supports the given provider
   */
  supports(provider: string): boolean;

  /**
   * Run health check against provider
   */
  check(config: CodeMieConfigOptions): Promise<HealthCheckResult>;
}

/**
 * Installation progress callback
 */
export interface InstallProgress {
  status: 'downloading' | 'installing' | 'complete' | 'error';
  progress?: number;                 // 0-100
  message?: string;                  // Progress message
}

/**
 * Model installer interface
 *
 * For providers that support local model installation (Ollama, LM Studio)
 */
export interface ModelInstallerProxy {
  /**
   * Check if installation is supported
   */
  supportsInstallation(): boolean;

  /**
   * List installed models
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Install model with progress tracking
   */
  installModel(modelName: string, onProgress?: (status: InstallProgress) => void): Promise<void>;

  /**
   * Remove model
   */
  removeModel(modelName: string): Promise<void>;

  /**
   * Get detailed model information
   */
  getModelInfo(modelName: string): Promise<ModelInfo | null>;
}

/**
 * Provider model fetcher interface
 *
 * For setup wizard - discover available models
 */
export interface ProviderModelFetcher {
  /**
   * Check if this fetcher supports the given provider
   */
  supports(provider: string): boolean;

  /**
   * Fetch available models for setup wizard
   *
   * Returns installed models if available, otherwise recommended models
   */
  fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]>;
}

/**
 * Provider credentials result
 */
export interface ProviderCredentials {
  baseUrl?: string;
  apiKey?: string;
  additionalConfig?: Record<string, unknown>;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Provider setup steps interface
 *
 * Defines interactive setup flow for a provider
 *
 * Note: name should match the provider template name
 * Display name and other metadata come from the template
 */
export interface ProviderSetupSteps {
  // Identity (matches provider template)
  name: string;

  /**
   * Step 1: Gather credentials/configuration
   *
   * Interactive prompts for API keys, URLs, etc.
   */
  getCredentials(isUpdate?: boolean): Promise<ProviderCredentials>;

  /**
   * Step 2: Fetch available models
   *
   * Query provider API to discover models
   */
  fetchModels(credentials: ProviderCredentials): Promise<string[]>;

  /**
   * Step 3: Build final configuration
   *
   * Transform credentials + model selection into CodeMieConfigOptions
   */
  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions>;

  /**
   * Optional: Install model during setup
   *
   * For providers that support model installation (e.g., Ollama)
   */
  installModel?(
    credentials: ProviderCredentials,
    selectedModel: string,
    availableModels: string[]
  ): Promise<void>;

  /**
   * Optional: Custom validation
   */
  validate?(config: Partial<CodeMieConfigOptions>): Promise<ValidationResult>;

  /**
   * Optional: Post-setup actions
   */
  postSetup?(config: Partial<CodeMieConfigOptions>): Promise<void>;
}

/**
 * SSO Authentication Types
 */

/**
 * SSO authentication configuration
 */
export interface SSOAuthConfig {
  codeMieUrl: string;
  timeout?: number;
}

/**
 * SSO authentication result
 */
export interface SSOAuthResult {
  success: boolean;
  apiUrl?: string;
  cookies?: Record<string, string>;
  error?: string;
}

/**
 * CodeMie model metadata
 */
export interface CodeMieModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
  label?: string;
  name?: string;
  description?: string;
  context_length?: number;
  provider?: string;
  multimodal?: boolean;
  react_agent?: boolean;
  enabled?: boolean;
  default?: boolean;
}

/**
 * SSO credentials for storage
 */
export interface SSOCredentials {
  cookies: Record<string, string>;
  apiUrl: string;
  expiresAt?: number;
}

/**
 * CodeMie integration metadata
 */
export interface CodeMieIntegration {
  id: string;
  alias: string;
  project_name: string;
  credential_type: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * CodeMie integrations API response
 */
export interface CodeMieIntegrationsResponse {
  integrations?: CodeMieIntegration[];
  // Allow for flexible response structure
  [key: string]: any;
}
