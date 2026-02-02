import { ClaudePlugin } from './plugins/claude/claude.plugin.js';
import { ClaudeAcpPlugin } from './plugins/claude/claude-acp.plugin.js';
import { CodeMieCodePlugin } from './plugins/codemie-code.plugin.js';
import { GeminiPlugin } from './plugins/gemini/gemini.plugin.js';
import { OpenCodePlugin } from './plugins/opencode/index.js';
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

  static async getInstalledAgents(): Promise<AgentAdapter[]> {
    AgentRegistry.initialize();
    const agents: AgentAdapter[] = [];
    for (const adapter of AgentRegistry.adapters.values()) {
      if (await adapter.isInstalled()) {
        agents.push(adapter);
      }
    }
    return agents;
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
