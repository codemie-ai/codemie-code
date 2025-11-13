import { CodeMieCodeAdapter } from './adapters/codemie-code';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';

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

export class AgentRegistry {
  private static adapters: Map<string, AgentAdapter> = new Map([
    ['codemie-code', new CodeMieCodeAdapter()],
    ['claude', new ClaudeCodeAdapter()],
    ['codex', new CodexAdapter()]
  ]);

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
