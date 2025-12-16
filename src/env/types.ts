/**
 * Configuration types for CodeMie Code
 */

/**
 * Minimal CodeMie integration info for config storage
 */
export interface CodeMieIntegrationInfo {
  id: string;
  alias: string;
}

/**
 * Provider profile configuration
 */
export interface ProviderProfile {
  name?: string;  // Optional - set during save
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  debug?: boolean;
  allowedDirs?: string[];
  ignorePatterns?: string[];

  // SSO-specific fields
  authMethod?: 'manual' | 'sso';
  codeMieUrl?: string;
  codeMieProject?: string;  // Selected project/application name
  codeMieIntegration?: CodeMieIntegrationInfo;
  ssoConfig?: {
    apiUrl?: string;
    cookiesEncrypted?: string;
  };

  // AWS Bedrock-specific fields
  awsProfile?: string;
  awsRegion?: string;
  awsSecretAccessKey?: string;

  // Token configuration (for Claude Code with Bedrock)
  maxOutputTokens?: number;
  maxThinkingTokens?: number;

  // Metrics configuration
  metrics?: {
    enabled?: boolean;  // Enable metrics collection (default: true)
    sync?: {
      enabled?: boolean;  // Enable metrics sync (default: true for SSO)
      interval?: number;  // Sync interval in ms (default: 300000 = 5 min)
      maxRetries?: number; // Max retry attempts (default: 3)
      dryRun?: boolean;   // Dry-run mode: log metrics without sending (default: false)
    };
  };
}

/**
 * Legacy single-provider configuration (version 1)
 */
export interface LegacyConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  debug?: boolean;
  allowedDirs?: string[];
  ignorePatterns?: string[];
  authMethod?: 'manual' | 'sso';
  codeMieUrl?: string;
  codeMieProject?: string;  // Selected project/application name
  codeMieIntegration?: CodeMieIntegrationInfo;
  ssoConfig?: {
    apiUrl?: string;
    cookiesEncrypted?: string;
  };
}

/**
 * Multi-provider configuration (version 2)
 */
export interface MultiProviderConfig {
  version: 2;
  activeProfile: string;
  profiles: Record<string, ProviderProfile>;
}

/**
 * Configuration with source tracking
 */
export interface ConfigWithSource {
  value: any;
  source: 'default' | 'global' | 'project' | 'env' | 'cli';
}

/**
 * Unified configuration options (for runtime use)
 */
export type CodeMieConfigOptions = ProviderProfile;

/**
 * Type guard to check if config is multi-provider format
 */
export function isMultiProviderConfig(config: any): config is MultiProviderConfig {
  return Boolean(
    config && config.version === 2 && config.profiles && config.activeProfile
  );
}

/**
 * Type guard to check if config is legacy format
 */
export function isLegacyConfig(config: any): config is LegacyConfig {
  return Boolean(
    config && !config.version && (config.provider || config.baseUrl || config.apiKey)
  );
}
