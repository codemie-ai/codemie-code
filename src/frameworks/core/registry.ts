/**
 * Framework Registry
 *
 * Central registry for all framework adapters.
 * Similar to AgentRegistry pattern in src/agents/registry.ts
 */

import type { FrameworkAdapter, FrameworkRegistryEntry } from './types.js';

export class FrameworkRegistry {
  private static frameworks = new Map<string, FrameworkRegistryEntry>();

  /**
   * Register a framework adapter
   * @param adapter - Framework adapter instance
   */
  static registerFramework(adapter: FrameworkAdapter): void {
    this.frameworks.set(adapter.metadata.name, {
      adapter,
      available: true
    });
  }

  /**
   * Get framework adapter by name
   * @param name - Framework name (e.g., 'speckit', 'bmad')
   * @returns Framework adapter or undefined
   */
  static getFramework(name: string): FrameworkAdapter | undefined {
    const entry = this.frameworks.get(name);
    return entry?.available ? entry.adapter : undefined;
  }

  /**
   * Get all registered frameworks
   * @returns Array of all framework adapters
   */
  static getAllFrameworks(): FrameworkAdapter[] {
    return Array.from(this.frameworks.values())
      .filter((entry) => entry.available)
      .map((entry) => entry.adapter);
  }

  /**
   * Get frameworks supported by specific agent
   * @param agentName - CodeMie agent name
   * @returns Array of framework adapters that support this agent
   */
  static getFrameworksForAgent(agentName: string): FrameworkAdapter[] {
    return this.getAllFrameworks().filter((adapter) => {
      // If no supported agents specified, framework supports all agents
      if (!adapter.metadata.supportedAgents || adapter.metadata.supportedAgents.length === 0) {
        return true;
      }
      // Check if agent is in supported list
      return adapter.metadata.supportedAgents.includes(agentName);
    });
  }

  /**
   * Check if framework is registered
   * @param name - Framework name
   * @returns True if framework is registered and available
   */
  static hasFramework(name: string): boolean {
    const entry = this.frameworks.get(name);
    return entry?.available ?? false;
  }

  /**
   * Get framework names
   * @returns Array of registered framework names
   */
  static getFrameworkNames(): string[] {
    return Array.from(this.frameworks.keys());
  }

  /**
   * Unregister a framework (for testing)
   * @param name - Framework name
   */
  static unregisterFramework(name: string): void {
    this.frameworks.delete(name);
  }

  /**
   * Clear all frameworks (for testing)
   */
  static clear(): void {
    this.frameworks.clear();
  }
}
