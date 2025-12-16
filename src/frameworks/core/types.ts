/**
 * Framework System Types
 *
 * Defines the core interfaces for framework integration in CodeMie CLI.
 * Frameworks (like SpecKit, BMAD) can be initialized from agent shortcuts.
 */

/**
 * Framework Metadata - Configuration and capabilities
 */
export interface FrameworkMetadata {
  /** Internal framework identifier (e.g., 'speckit', 'bmad') */
  name: string;

  /** User-facing display name (e.g., 'SpecKit', 'BMAD Method') */
  displayName: string;

  /** Brief description of the framework */
  description: string;

  /** Official documentation URL */
  docsUrl?: string;

  /** GitHub repository URL */
  repoUrl?: string;

  /** Whether framework requires installation before init */
  requiresInstallation: boolean;

  /** Installation method: 'npm', 'uv', 'pip', 'manual', 'npx-on-demand' */
  installMethod?: 'npm' | 'uv' | 'pip' | 'manual' | 'npx-on-demand';

  /** Package identifier for installation (npm package name, PyPI name, etc.) */
  packageName?: string;

  /** CLI command name (executable) */
  cliCommand?: string;

  /** Whether framework initialization is agent-specific */
  isAgentSpecific: boolean;

  /** Supported CodeMie agent names (empty means all agents) */
  supportedAgents?: string[];

  /** Directory created by framework initialization (for detection) */
  initDirectory?: string;
}

/**
 * Framework Adapter - Interface for framework integration
 */
export interface FrameworkAdapter {
  /** Framework metadata */
  readonly metadata: FrameworkMetadata;

  /**
   * Install framework CLI (if required)
   * @returns Promise resolving when installation completes
   */
  install(): Promise<void>;

  /**
   * Uninstall framework CLI
   * @returns Promise resolving when uninstallation completes
   */
  uninstall(): Promise<void>;

  /**
   * Initialize framework in current directory
   * @param agentName - CodeMie agent name (e.g., 'claude', 'codex')
   * @param options - Additional initialization options
   * @returns Promise resolving when initialization completes
   */
  init(agentName: string, options?: FrameworkInitOptions): Promise<void>;

  /**
   * Check if framework is initialized in current directory
   * @param cwd - Working directory to check (default: process.cwd())
   * @returns Promise resolving to true if initialized
   */
  isInitialized(cwd?: string): Promise<boolean>;

  /**
   * Check if framework CLI is installed
   * @returns Promise resolving to true if installed
   */
  isInstalled(): Promise<boolean>;

  /**
   * Get framework-specific agent name mapping
   * @param codemieAgentName - CodeMie agent name
   * @returns Framework's agent identifier, or null if not supported
   */
  getAgentMapping(codemieAgentName: string): string | null;

  /**
   * Get framework version
   * @returns Promise resolving to version string or null if unavailable
   */
  getVersion(): Promise<string | null>;
}

/**
 * Framework Initialization Options
 */
export interface FrameworkInitOptions {
  /** Force re-initialization even if already initialized */
  force?: boolean;

  /** Project name (if framework requires it) */
  projectName?: string;

  /** Working directory (default: process.cwd()) */
  cwd?: string;

  /** Additional framework-specific options */
  [key: string]: unknown;
}

/**
 * Framework Installation Result
 */
export interface FrameworkInstallResult {
  /** Whether installation succeeded */
  success: boolean;

  /** Installation method used */
  method: string;

  /** Version installed (if available) */
  version?: string;

  /** Error message if failed */
  error?: string;
}

/**
 * Framework Initialization Result
 */
export interface FrameworkInitResult {
  /** Whether initialization succeeded */
  success: boolean;

  /** Directory initialized in */
  directory: string;

  /** Agent name used for initialization */
  agentName?: string;

  /** Error message if failed */
  error?: string;
}

/**
 * Framework Registry Entry
 */
export interface FrameworkRegistryEntry {
  /** Framework adapter instance */
  adapter: FrameworkAdapter;

  /** Whether framework is available for use */
  available: boolean;
}
