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

  lifecycle?: {
    beforeRun?: (env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
    afterRun?: (exitCode: number, env: NodeJS.ProcessEnv) => Promise<void>;
    enrichArgs?: (args: string[], config: AgentConfig) => string[];
  };

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
    history?: string;       // User prompt history file (relative to home or absolute)
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
