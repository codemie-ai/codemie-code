/**
 * Core types for the plugin-based agent architecture
 */

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

  // === Proxy Configuration ===
  ssoConfig?: {
    enabled: boolean;              // Enable proxy support
    clientType: string;            // 'codemie-claude'
    envOverrides: {                // Which env vars to override
      baseUrl: string;             // 'ANTHROPIC_BASE_URL'
      apiKey: string;              // 'ANTHROPIC_AUTH_TOKEN'
    };
  };

  // === CLI Options ===
  customOptions?: Array<{
    flags: string;                 // '--plan'
    description: string;
  }>;

  // === Runtime Behavior ===
  argumentTransform?: (args: string[], config: AgentConfig) => string[];

  lifecycle?: {
    beforeRun?: (env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
    afterRun?: (exitCode: number) => Promise<void>;
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
  };

  // === Analytics Support ===
  analyticsAdapter?: AgentAnalyticsAdapter;  // Optional analytics adapter
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
}
