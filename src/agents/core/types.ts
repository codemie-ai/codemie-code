/**
 * Core types for the plugin-based agent architecture
 */

/**
 * Post-install hint - simple text lines shown after installation
 * Used to show custom setup instructions (e.g., IDE configuration)
 */
export type PostInstallHint = string;

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
 * Result of version compatibility check
 * Used to compare installed version against supported version
 */
export interface VersionCompatibilityResult {
  compatible: boolean;             // true if installed version is compatible
  installedVersion: string | null; // null if not installed
  supportedVersion: string;        // version from metadata
  isNewer: boolean;                // true if installed > supported (requires warning)
  hasUpdate: boolean;              // true if newer supported version available (for info prompt)
}

/**
 * Agent metadata schema - declarative configuration for agents
 */
export interface AgentMetadata {
  // === Identity ===
  name: string;                    // 'claude', 'gemini'
  displayName: string;             // 'Claude Code'
  description: string;

  // === Installation ===
  npmPackage: string | null;       // '@anthropic-ai/claude-code' or null for built-in
  cliCommand: string | null;       // 'claude' or null for built-in

  /**
   * Latest supported version tested with CodeMie backend
   * Used for version compatibility checks
   *
   * Format: Semantic version string (e.g., '2.0.30')
   * Special values: 'latest', 'stable' (channels)
   */
  supportedVersion?: string;

  /**
   * Native installer URLs for platform-specific installation
   * Optional: Only needed for agents using native installers (not npm)
   */
  installerUrls?: {
    macOS: string;
    windows: string;
    linux: string;
  };

  // === Environment Variable Mapping ===
  envMapping: {
    baseUrl?: string[];            // ['ANTHROPIC_BASE_URL']
    apiKey?: string[];             // ['ANTHROPIC_AUTH_TOKEN']
    model?: string[];              // ['ANTHROPIC_MODEL']
    haikuModel?: string[];         // ['ANTHROPIC_DEFAULT_HAIKU_MODEL']
    sonnetModel?: string[];        // ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
    opusModel?: string[];          // ['ANTHROPIC_DEFAULT_OPUS_MODEL']
  };

  // === Compatibility Rules ===
  supportedProviders: string[];    // ['openai', 'litellm', 'ai-run-sso']
  blockedModelPatterns?: RegExp[]; // Optional: Block certain model patterns
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

  /**
   * Silent mode - skip welcome/goodbye messages in console
   * Used by ACP adapters where stdout is JSON-RPC protocol
   */
  silentMode?: boolean;

  /**
   * Custom post-install hints for IDE configuration
   * Used instead of default "Interactive mode" / "Single task" hints
   * For ACP adapters, shows IDE configuration examples
   */
  postInstallHints?: PostInstallHint[];

  lifecycle?: AgentLifecycle;

  // === Built-in Agent Support ===
  isBuiltIn?: boolean;
  customRunHandler?: (args: string[], options: Record<string, unknown>, config: AgentConfig) => Promise<void>;
  customHealthCheck?: () => Promise<boolean>;

  // === Data Paths ===
  dataPaths?: {
    home: string;        // Main directory: '~/.gemini', '~/.claude'
    settings?: string;   // Settings file path (relative to home, agent-specific)
  };

  // === Analytics Support ===
  analyticsAdapter?: AgentAnalyticsAdapter;  // Optional analytics adapter

  // === Metrics Configuration ===
  /**
   * Metrics collection configuration for this agent
   * Controls which tool errors are excluded from metrics sent to API
   */
  metricsConfig?: AgentMetricsConfig;

  // === MCP Configuration ===
  /**
   * MCP (Model Context Protocol) server configuration paths
   * Agent-specific locations for MCP config files
   */
  mcpConfig?: AgentMCPConfig;
}

/**
 * MCP configuration source definition
 * Describes where to find MCP servers in a config file
 */
export interface MCPConfigSource {
  /**
   * Path to config file
   * - Absolute: starts with '~/' (resolved to home dir)
   * - Relative: resolved from cwd
   */
  path: string;

  /**
   * JSON path to mcpServers object
   * Supports nested paths like 'projects.{cwd}.mcpServers'
   * {cwd} is replaced with actual working directory
   */
  jsonPath: string;
}

/**
 * Agent-specific MCP configuration
 * Defines where this agent stores MCP server configs
 */
export interface AgentMCPConfig {
  /**
   * Local scope: Project-specific, private to user
   * Example: Claude uses ~/.claude.json → projects[cwd].mcpServers
   */
  local?: MCPConfigSource;

  /**
   * Project scope: Shared with team (version controlled)
   * Example: .mcp.json in project root
   */
  project?: MCPConfigSource;

  /**
   * User scope: Available across all projects
   * Example: Gemini uses ~/.gemini/settings.json → mcpServers
   */
  user?: MCPConfigSource;
}

/**
 * MCP configuration summary for metrics
 * Contains counts and server names per scope
 */
export interface MCPConfigSummary {
  /** Total server count across all scopes */
  totalServers: number;
  /** Server count in local scope */
  localServers: number;
  /** Server count in project scope */
  projectServers: number;
  /** Server count in user scope */
  userServers: number;
  /** All unique server names */
  serverNames: string[];
  /** Server names in local scope */
  localServerNames: string[];
  /** Server names in project scope */
  projectServerNames: string[];
  /** Server names in user scope */
  userServerNames: string[];
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

  // Retry configuration
  retry: {
    attempts: number;
    delays: number[]; // Exponential backoff delays
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
  agent?: string;           // Agent name ('claude', 'gemini', etc.)
  agentDisplayName?: string; // Display name ('Claude Code', 'Gemini CLI', etc.)
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  profileName?: string;
}

/**
 * Hook transformer interface for agent-specific payload transformation
 * Transforms agent-specific hook events to internal BaseHookEvent format
 *
 * Agents implement this interface to convert their hook payloads to the
 * internal format expected by CodeMie CLI hook handlers.
 *
 * @example Gemini transformer
 * ```typescript
 * class GeminiHookTransformer implements HookTransformer {
 *   readonly agentName = 'gemini';
 *
 *   transform(event: unknown): BaseHookEvent {
 *     const geminiEvent = event as GeminiHookEvent;
 *     return {
 *       ...geminiEvent,
 *       permission_mode: 'default' // Add default value
 *     };
 *   }
 * }
 * ```
 */
export interface HookTransformer {
  /**
   * Transform agent-specific hook event to internal format
   * @param event - Raw hook event from agent
   * @returns Transformed event in internal BaseHookEvent format
   */
  transform(event: unknown): BaseHookEvent;

  /**
   * Agent name for this transformer
   */
  readonly agentName: string;
}

/**
 * Base hook event structure - all hooks include these fields
 * This is the internal format used by CodeMie CLI hook handlers
 *
 * See Claude Code hook documentation: https://code.claude.com/docs/en/hooks#hook-input
 */
export interface BaseHookEvent {
  session_id: string;              // Agent's session ID
  transcript_path: string;         // Path to conversation file (agent session file)
  permission_mode: string;         // "default", "plan", "acceptEdits", "dontAsk", or "bypassPermissions"
  hook_event_name: string;         // Event identifier (SessionStart, SessionEnd, etc.)
  cwd?: string;                    // Current working directory (not present in all hooks)
  source?: string;                 // SessionStart only: "startup", "resume", "clear"
  reason?: string;                 // SessionEnd only: "exit", "logout", "clear", etc.
  agent_id?: string;               // SubagentStop only: Sub-agent ID
  agent_transcript_path?: string;  // SubagentStop only: Path to agent's transcript
  stop_hook_active?: boolean;      // SubagentStop only: Whether stop hook is active
}

// Forward declaration for extension installer
export interface BaseExtensionInstaller {
  getTargetPath(): string;
  install(): Promise<any>;
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

  /**
   * Get hook transformer for this agent (optional)
   * Returns a transformer to convert agent-specific hook payloads to internal format
   *
   * Agents that use different hook payload structures should implement this.
   * Agents using Claude-compatible payloads can omit this.
   *
   * @returns Hook transformer instance or undefined
   */
  getHookTransformer?(): HookTransformer | undefined;

  /**
   * Get extension installer for this agent (optional)
   * Returns installer to handle plugin/extension installation
   *
   * Agents that require extensions/plugins should implement this.
   * Installer will be called automatically by provider lifecycle hooks.
   *
   * @returns BaseExtensionInstaller instance or undefined
   */
  getExtensionInstaller?(): BaseExtensionInstaller | undefined;

  /**
   * Get MCP configuration summary for this agent
   * Returns counts and server names for session metrics
   *
   * @param cwd - Current working directory
   * @returns MCP configuration summary
   */
  getMCPConfigSummary?(cwd: string): Promise<MCPConfigSummary>;

  /**
   * Install specific version of agent (optional, for version-managed agents)
   * @param version - Version string or channel ('latest', 'stable', 'supported')
   */
  installVersion?(version: string): Promise<void>;

  /**
   * Check version compatibility (optional, for version-managed agents)
   * @returns Version compatibility result
   */
  checkVersionCompatibility?(): Promise<VersionCompatibilityResult>;

  /**
   * Detect installation method (optional, for installation-aware agents)
   * Returns how the agent was installed (npm vs native installer)
   * Used to warn users about deprecated installation methods
   *
   * @returns Installation method: 'npm', 'native', or 'unknown'
   */
  getInstallationMethod?(): Promise<'npm' | 'native' | 'unknown'>;
}
