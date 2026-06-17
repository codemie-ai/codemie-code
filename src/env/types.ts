/**
 * Configuration types for CodeMie Code
 */

import type { HooksConfiguration } from '../hooks/types.js';
import type { CanonicalReasoningEffort } from '../agents/core/types.js';

export enum StorageScope {
  GLOBAL = 'global',
  LOCAL = 'local',
}

/**
 * Minimal CodeMie integration info for config storage
 */
export interface CodeMieIntegrationInfo {
  id: string;
  alias: string;
}

/**
 * CodeMie assistant information
 */
export interface CodemieAssistant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  project?: string;
  registeredAt: string;
  registrationMode?: 'agent' | 'skill';
  agentTargets?: Array<'claude' | 'codex' | 'gemini'>;
}

/**
 * CodeMie skill information
 */
export interface CodemieSkill {
  id: string;
  name: string;
  slug: string;
  description: string;
  project?: string;
  registeredAt: string;
  agentTargets?: Array<'claude' | 'codex' | 'gemini'>;
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
  /** Reasoning/thinking effort level. Persisted profile default; CLI flag overrides. */
  reasoningEffort?: CanonicalReasoningEffort;

  // Claude model tier configuration (maps to ANTHROPIC_DEFAULT_*_MODEL)
  haikuModel?: string;
  sonnetModel?: string;
  opusModel?: string;

  timeout?: number;
  debug?: boolean;
  allowedDirs?: string[];
  ignorePatterns?: string[];

  // SSO-specific fields
  authMethod?: 'manual' | 'sso' | 'jwt' | 'api-key';
  codeMieUrl?: string;
  codeMieProject?: string;  // Selected project/application name
  userEmail?: string;       // Authenticated user's email
  codeMieIntegration?: CodeMieIntegrationInfo;
  ssoConfig?: {
    apiUrl?: string;
    cookiesEncrypted?: string;
  };

  // JWT-specific fields
  jwtConfig?: {
    token?: string;
    tokenEnvVar?: string;
    expiresAt?: number;
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

  // Hooks configuration
  hooks?: HooksConfiguration;

  // Plugin configuration
  plugins?: {
    enabled?: string[];
    disabled?: string[];
    dirs?: string[];
  };

  // Assistants chat configuration
  assistants?: {
    maxHistoryMessages?: number; // Maximum conversation turns to load (default: 10, which loads 20 messages = 10 user + 10 AI)
  };

  // In-memory assistants/skills state (not persisted here; stored at MultiProviderConfig level)
  codemieAssistants?: CodemieAssistant[];

  // Skills search — internal catalog endpoint used by `codemie skills find`.
  // Overridden by the CODEMIE_SKILLS_SEARCH_URL env var. When unset, the
  // `find` command shows a friendly placeholder for the internal section
  // and does not make an internal HTTP call.
  skillsSearchUrl?: string;

  // Claude Code-specific settings
  claudeAutocompactPct?: number; // Auto-compact threshold percentage (sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, default: 70)

  // Statusline budget tracking
  statuslineBudgetName?: string; // Budget row name selected during statusline install
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
  authMethod?: 'manual' | 'sso' | 'jwt' | 'api-key';
  codeMieUrl?: string;
  codeMieProject?: string;  // Selected project/application name
  codeMieIntegration?: CodeMieIntegrationInfo;
  ssoConfig?: {
    apiUrl?: string;
    cookiesEncrypted?: string;
  };
  jwtConfig?: {
    token?: string;
    tokenEnvVar?: string;
    expiresAt?: number;
  };
}

/**
 * Multi-provider configuration (version 2)
 */
export interface MultiProviderConfig {
  version: 2;
  activeProfile: string;
  codemieSkills?: CodemieSkill[];
  codemieAssistants?: CodemieAssistant[];
  userEmail?: string;
  profiles: Record<string, ProviderProfile>;
}

/**
 * Configuration with source tracking (single field)
 */
export interface ConfigWithSource {
  value: any;
  source: 'default' | 'global' | 'project' | 'env' | 'cli';
}

/**
 * Configuration with source tracking (full config)
 */
export interface ConfigWithSources {
  config: CodeMieConfigOptions;    // Merged configuration
  hasLocalConfig: boolean;         // Whether local .codemie/ exists
  sources: Record<string, ConfigWithSource>;  // Track source of each field
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
    config?.version === 2 && config.profiles && config.activeProfile
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
