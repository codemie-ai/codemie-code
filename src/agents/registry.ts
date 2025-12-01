import { ClaudePlugin } from './plugins/claude.plugin.js';
import { CodexPlugin } from './plugins/codex.plugin.js';
import { CodeMieCodePlugin } from './plugins/codemie-code.plugin.js';
import { GeminiPlugin } from './plugins/gemini.plugin.js';
import { DeepAgentsPlugin } from './plugins/deepagents.plugin.js';
import { AgentAdapter, AgentAnalyticsAdapter } from './core/types.js';

// Re-export for backwards compatibility
export { AgentAdapter, AgentAnalyticsAdapter } from './core/types.js';
export { BUILTIN_AGENT_NAME } from './plugins/codemie-code.plugin.js';

/**
 * Central registry for all agents
 * Uses plugin-based architecture for easy extensibility
 */
export class AgentRegistry {
  private static adapters: Map<string, AgentAdapter> = new Map();
  private static analyticsAdapters: Map<string, AgentAnalyticsAdapter> = new Map();

  static {
    // Initialize plugin-based adapters
    AgentRegistry.registerPlugin(new CodeMieCodePlugin());
    AgentRegistry.registerPlugin(new ClaudePlugin());
    AgentRegistry.registerPlugin(new CodexPlugin());
    AgentRegistry.registerPlugin(new GeminiPlugin());
    AgentRegistry.registerPlugin(new DeepAgentsPlugin());
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
    return AgentRegistry.adapters.get(name);
  }

  static getAllAgents(): AgentAdapter[] {
    return Array.from(AgentRegistry.adapters.values());
  }

  static getAgentNames(): string[] {
    return Array.from(AgentRegistry.adapters.keys());
  }

  static async getInstalledAgents(): Promise<AgentAdapter[]> {
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
    return AgentRegistry.analyticsAdapters.get(agentName);
  }

  /**
   * Get all registered analytics adapters
   */
  static getAllAnalyticsAdapters(): AgentAnalyticsAdapter[] {
    return Array.from(AgentRegistry.analyticsAdapters.values());
  }
}
