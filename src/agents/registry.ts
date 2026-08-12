import { ClaudePlugin } from './plugins/claude/claude.plugin.js';
import { ClaudeAcpPlugin } from './plugins/claude/claude-acp.plugin.js';
import { CodeMieCodePlugin } from './plugins/codemie-code.plugin.js';
import { GeminiPlugin } from './plugins/gemini/gemini.plugin.js';
import { OpenCodePlugin } from './plugins/opencode/index.js';
import { CodexPlugin } from './plugins/codex/index.js';
import { PiPlugin } from './plugins/pi/index.js';
import { KimiPlugin } from './plugins/kimi/kimi.plugin.js';
import { KimiAcpPlugin } from './plugins/kimi/kimi-acp.plugin.js';
import { CopilotCliPlugin } from './plugins/copilot-cli/index.js';
import { AgentAdapter, AgentAnalyticsAdapter } from './core/types.js';

// Re-export for backwards compatibility
export { AgentAdapter, AgentAnalyticsAdapter } from './core/types.js';
export { BUILTIN_AGENT_NAME } from './plugins/codemie-code.plugin.js';

/**
 * Central registry for all agents
 * Uses plugin-based architecture for easy extensibility
 */
export class AgentRegistry {
  private static readonly adapters: Map<string, AgentAdapter> = new Map();
  private static readonly analyticsAdapters: Map<string, AgentAnalyticsAdapter> = new Map();
  private static initialized = false;

  /**
   * Lazy initialization - registers all built-in plugins on first access
   */
  private static initialize(): void {
    if (AgentRegistry.initialized) {
      return;
    }

    AgentRegistry.registerPlugin(new CodeMieCodePlugin());
    AgentRegistry.registerPlugin(new ClaudePlugin());
    AgentRegistry.registerPlugin(new ClaudeAcpPlugin());
    AgentRegistry.registerPlugin(new GeminiPlugin());
    AgentRegistry.registerPlugin(new OpenCodePlugin());
    AgentRegistry.registerPlugin(new CodexPlugin());
    AgentRegistry.registerPlugin(new PiPlugin());
    AgentRegistry.registerPlugin(new KimiPlugin());
    AgentRegistry.registerPlugin(new KimiAcpPlugin());
    AgentRegistry.registerPlugin(new CopilotCliPlugin());

    AgentRegistry.initialized = true;
  }

  /**
   * Register a plugin and its analytics adapter (if available)
   */
  private static registerPlugin(plugin: AgentAdapter): void {
    AgentRegistry.adapters.set(plugin.name, plugin);

    // Auto-register analytics adapter if provided in metadata
    const metadata = (plugin as any).metadata;
    if (metadata?.analyticsAdapter) {
      AgentRegistry.analyticsAdapters.set(plugin.name, metadata.analyticsAdapter);
    }
  }

  static getAgent(name: string): AgentAdapter | undefined {
    AgentRegistry.initialize();
    return AgentRegistry.adapters.get(name);
  }

  static getAllAgents(): AgentAdapter[] {
    AgentRegistry.initialize();
    return Array.from(AgentRegistry.adapters.values());
  }

  static getAgentNames(): string[] {
    AgentRegistry.initialize();
    return Array.from(AgentRegistry.adapters.keys());
  }

  /**
   * Agents CodeMie can actually install, launch and update — i.e. everything except
   * analytics-only agents, which CodeMie reads telemetry for but never manages.
   *
   * Every agent-MANAGEMENT surface must use this rather than {@link getAllAgents}:
   * install, uninstall, update, list, doctor and the first-run experience. Listing an
   * unmanageable agent there advertises commands that always fail, and `codemie update`
   * is actively destructive — updateAgent() never calls the adapter, it reads
   * `metadata.npmPackage` and runs `npm install -g <pkg> --force`, which would overwrite
   * a user's own install of a third-party tool.
   *
   * {@link getAllAgents} intentionally still returns them, because the analytics pipeline
   * resolves session adapters through the registry.
   */
  static getManageableAgents(): AgentAdapter[] {
    AgentRegistry.initialize();
    return Array.from(AgentRegistry.adapters.values()).filter(
      (adapter) => adapter.metadata.analyticsOnly !== true
    );
  }

  /**
   * Installed agents CodeMie can manage. Analytics-only agents are excluded: every
   * consumer of this is a management surface (uninstall, list, doctor), and "installed"
   * is meaningless for an agent CodeMie never installs.
   */
  static async getInstalledAgents(): Promise<AgentAdapter[]> {
    AgentRegistry.initialize();
    const manageable = AgentRegistry.getManageableAgents();
    const installResults = await Promise.all(
      manageable.map(async (adapter) => ({
        adapter,
        installed: await adapter.isInstalled()
      }))
    );
    return installResults
      .filter(({ installed }) => installed)
      .map(({ adapter }) => adapter);
  }

  /**
   * Get analytics adapter for a specific agent
   */
  static getAnalyticsAdapter(agentName: string): AgentAnalyticsAdapter | undefined {
    AgentRegistry.initialize();
    return AgentRegistry.analyticsAdapters.get(agentName);
  }

  /**
   * Get all registered analytics adapters
   */
  static getAllAnalyticsAdapters(): AgentAnalyticsAdapter[] {
    AgentRegistry.initialize();
    return Array.from(AgentRegistry.analyticsAdapters.values());
  }
}
