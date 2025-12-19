/**
 * Core types for the plugin-based agent architecture
 */

/**
 * Mapping types for flag transformation
 */
export type FlagMappingType = 'flag' | 'subcommand' | 'positional';

/**
 * Declarative mapping configuration for a single flag
 */
export interface FlagMapping {
  /** How to transform this flag */
  type: FlagMappingType;

  /** Target flag or subcommand name (null for positional) */
  target: string | null;

  /** For subcommands: where to place value relative to other args */
  position?: 'before' | 'after';
}

/**
 * Multiple flag mappings (key = source flag, value = transformation)
 * Similar to envMapping pattern
 *
 * @example
 * flagMappings: {
 *   '--task': { type: 'flag', target: '-p' },
 *   '--profile': { type: 'flag', target: '--workspace' },
 *   '--timeout': { type: 'flag', target: '-t' }
 * }
 */
export interface FlagMappings {
  [sourceFlag: string]: FlagMapping;
}

/**
 * Provider-specific lifecycle hooks
 * Allows agents to customize behavior per provider
 */
export interface ProviderLifecycleHooks {
  /**
   * Called before agent execution (provider-specific)
   * Can modify environment variables before agent starts
   */
  beforeRun?: (this: any, env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;

  /**
   * Called after agent execution (provider-specific)
   * Can perform cleanup or post-processing
   */
  afterRun?: (this: any, exitCode: number, env: NodeJS.ProcessEnv) => Promise<void>;

  /**
   * Called to enrich CLI arguments (provider-specific)
   * Can inject additional flags or modify existing ones
   */
  enrichArgs?: (args: string[], config: AgentConfig) => string[];

  /**
   * Called when agent session starts (provider-specific)
   * Early initialization before env transformation
   */
  onSessionStart?: (this: any, sessionId: string, env: NodeJS.ProcessEnv) => Promise<void>;

  /**
   * Called when agent session ends (provider-specific)
   * Late cleanup after lifecycle hooks
   */
  onSessionEnd?: (this: any, exitCode: number, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Agent lifecycle hooks (provider-agnostic)
 *
 * Agents define DEFAULT behavior only - no provider-specific logic!
 * Provider plugins register their own hooks via ProviderTemplate.agentHooks
 *
 * Execution order:
 * 1. onSessionStart (provider hook OR agent default)
 * 2. beforeRun (provider hook OR agent default)
 * 3. enrichArgs (provider hook OR agent default)
 * 4. [Agent execution]
 * 5. onSessionEnd (provider hook OR agent default)
 * 6. afterRun (provider hook OR agent default)
 *
 * Hook Resolution Priority (Loose Coupling):
 * 1. Provider plugin's agent hook (ProviderTemplate.agentHooks[agentName])
 * 2. Agent's default hook (AgentMetadata.lifecycle)
 *
 * @example Agent stays provider-agnostic
 * ```typescript
 * lifecycle: {
 *   // ONLY default hooks - no provider knowledge!
 *   beforeRun: async (env, config) => {
 *     env.AGENT_DISABLE_TELEMETRY = '1';
 *     return env;
 *   }
 * }
 * ```
 *
 * @example Provider registers hooks for agent
 * ```typescript
 * // In provider plugin (src/providers/plugins/bedrock/)
 * export const BedrockTemplate: ProviderTemplate = {
 *   agentHooks: {
 *     'claude': {
 *       beforeRun: async (env) => {
 *         env.CLAUDE_CODE_USE_BEDROCK = '1';
 *         return env;
 *       }
 *     }
 *   }
 * };
 * ```
 */
export interface AgentLifecycle {
  /**
   * Default hooks (provider-agnostic)
   */
  beforeRun?: (this: any, env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
  afterRun?: (this: any, exitCode: number, env: NodeJS.ProcessEnv) => Promise<void>;
  enrichArgs?: (args: string[], config: AgentConfig) => string[];
  onSessionStart?: (this: any, sessionId: string, env: NodeJS.ProcessEnv) => Promise<void>;
  onSessionEnd?: (this: any, exitCode: number, env: NodeJS.ProcessEnv) => Promise<void>;
}

// Forward declaration for circular dependency
// Full interface defined in src/analytics/aggregation/core/adapter.interface.ts
export interface AgentAnalyticsAdapter {
  agentName: string;
  displayName: string;
  version: string;
  findSessions(options?: any): Promise<any[]>;
  extractSession(descriptor: any): Promise<any>;
  extractMessages(descriptor: any): Promise<any[]>;
  extractToolCalls(descriptor: any): Promise<any[]>;
  extractFileModifications(descriptor: any): Promise<any[]>;
  extractRawEvents(descriptor: any): Promise<{ messages: any[]; toolCalls: any[]; fileModifications: any[] }>;
  validateSource(): Promise<boolean>;
}

/**
 * Agent metadata schema - declarative configuration for agents
 */
export interface AgentMetadata {
  // === Identity ===
  name: string;                    // 'claude', 'codex', 'gemini'
  displayName: string;             // 'Claude Code'
  description: string;

  // === Installation ===
  npmPackage: string | null;       // '@anthropic-ai/claude-code' or null for built-in
  cliCommand: string | null;       // 'claude' or null for built-in

  // === Environment Variable Mapping ===
  envMapping: {
    baseUrl?: string[];            // ['ANTHROPIC_BASE_URL']
    apiKey?: string[];             // ['ANTHROPIC_AUTH_TOKEN']
    model?: string[];              // ['ANTHROPIC_MODEL']
  };

  // === Compatibility Rules ===
  supportedProviders: string[];    // ['openai', 'litellm', 'ai-run-sso']
  blockedModelPatterns?: RegExp[]; // [/^claude/i] for Codex
  recommendedModels?: string[];    // ['gpt-4.1', 'gpt-4o'] - suggested models for error messages

  // === Proxy Configuration ===
  ssoConfig?: {
    enabled: boolean;              // Enable proxy support
    clientType: string;            // 'codemie-claude'
  };

  // === CLI Options ===
  customOptions?: Array<{
    flags: string;                 // '--plan'
    description: string;
  }>;

  // === Runtime Behavior ===
  /** Declarative mapping for multiple CLI flags */
  flagMappings?: FlagMappings;

  lifecycle?: AgentLifecycle;

  // === Built-in Agent Support ===
  isBuiltIn?: boolean;
  customRunHandler?: (args: string[], options: Record<string, unknown>, config: AgentConfig) => Promise<void>;
  customHealthCheck?: () => Promise<boolean>;

  // === Data Paths ===
  dataPaths?: {
    home: string;           // Main directory: '~/.gemini', '~/.claude', '~/.codex'
    sessions?: string;      // Session logs path (relative to home or absolute)
    settings?: string;      // Settings file path (relative to home or absolute)
    cache?: string;         // Cache directory (relative to home or absolute)
    user_prompts?: string;  // User prompt history file (relative to home or absolute)
  };

  // === Analytics Support ===
  analyticsAdapter?: AgentAnalyticsAdapter;  // Optional analytics adapter

  // === Metrics Configuration ===
  /**
   * Metrics collection configuration for this agent
   * Controls which tool errors are excluded from metrics sent to API
   */
  metricsConfig?: AgentMetricsConfig;
}

/**
 * Agent-specific metrics configuration
 * Used by post-processor to filter/sanitize metrics before API transmission
 */
export interface AgentMetricsConfig {
  /**
   * List of tool names whose errors should be excluded from metrics
   * Example: ['Bash', 'Execute', 'Shell']
   * This prevents sensitive command output from being sent to the API
   */
  excludeErrorsFromTools?: string[];
}

/**
 * Global metrics collection configuration
 * Controls how agents collect and process metrics
 */
export interface MetricsConfig {
  // Provider filter
  enabled: (provider: string) => boolean;

  // Agent-specific init delays
  initDelay: Record<string, number>;

  // Retry configuration
  retry: {
    attempts: number;
    delays: number[]; // Exponential backoff delays
  };

  // Monitoring configuration
  monitoring: {
    pollInterval: number; // Polling fallback interval (ms)
    debounceDelay: number; // Debounce delay before collection (ms)
  };

  // Watermark configuration
  watermark: {
    ttl: number; // Time-to-live (ms) - 24h
  };

  // Post-processing configuration
  /**
   * Global list of tool names whose errors should be excluded from metrics
   * Agents can override this via their metricsConfig.excludeErrorsFromTools
   * Example: ['Bash', 'Execute', 'Shell']
   */
  excludeErrorsFromTools?: string[];
}

/**
 * Agent configuration passed to runtime handlers
 */
export interface AgentConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  profileName?: string;
}

/**
 * Agent adapter interface - implemented by BaseAgentAdapter
 */
export interface AgentAdapter {
  name: string;
  displayName: string;
  description: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  isInstalled(): Promise<boolean>;
  run(args: string[], env?: Record<string, string>): Promise<void>;
  getVersion(): Promise<string | null>;
  getMetricsConfig(): AgentMetricsConfig | undefined;
}
