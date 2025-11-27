import { ClaudePlugin } from './plugins/claude.plugin.js';
import { CodexPlugin } from './plugins/codex.plugin.js';
import { CodeMieCodePlugin, BUILTIN_AGENT_NAME } from './plugins/codemie-code.plugin.js';
import { GeminiPlugin } from './plugins/gemini.plugin.js';
import { AgentAdapter } from './core/types.js';

// Re-export for backwards compatibility
export { AgentAdapter } from './core/types.js';
export { BUILTIN_AGENT_NAME } from './plugins/codemie-code.plugin.js';

/**
 * Central registry for all agents
 * Uses plugin-based architecture for easy extensibility
 */
export class AgentRegistry {
  private static adapters: Map<string, AgentAdapter> = new Map();

  static {
    // Initialize plugin-based adapters
    AgentRegistry.adapters.set(BUILTIN_AGENT_NAME, new CodeMieCodePlugin());
    AgentRegistry.adapters.set('claude', new ClaudePlugin());
    AgentRegistry.adapters.set('codex', new CodexPlugin());
    AgentRegistry.adapters.set('gemini', new GeminiPlugin());
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
}
