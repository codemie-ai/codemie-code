/**
 * Agent Registry Unit Tests
 *
 * Tests the agent registry and plugin loading system
 */

import { describe, it, expect } from 'vitest';
import { AgentRegistry, BUILTIN_AGENT_NAME } from '../registry.js';

describe('AgentRegistry', () => {
  describe('Agent Registration', () => {
    it('should register all default agents', () => {
      const agentNames = AgentRegistry.getAgentNames();

      // Should have all 3 default agents (codemie-code, claude, gemini)
      expect(agentNames).toHaveLength(3);
    });

    it('should register built-in agent', () => {
      const agent = AgentRegistry.getAgent(BUILTIN_AGENT_NAME);

      expect(agent).toBeDefined();
      expect(agent?.name).toBe(BUILTIN_AGENT_NAME);
    });

    it('should register Claude plugin', () => {
      const agent = AgentRegistry.getAgent('claude');

      expect(agent).toBeDefined();
      expect(agent?.name).toBe('claude');
    });

    it('should register Gemini plugin', () => {
      const agent = AgentRegistry.getAgent('gemini');

      expect(agent).toBeDefined();
      expect(agent?.name).toBe('gemini');
    });
  });

  describe('Agent Retrieval', () => {
    it('should return undefined for unknown agent', () => {
      const agent = AgentRegistry.getAgent('unknown-agent');

      expect(agent).toBeUndefined();
    });

    it('should return all registered agents', () => {
      const agents = AgentRegistry.getAllAgents();

      expect(agents).toHaveLength(3);
      expect(agents.every((agent) => agent.name)).toBe(true);
    });

    it('should return all agent names', () => {
      const names = AgentRegistry.getAgentNames();

      expect(names).toContain(BUILTIN_AGENT_NAME);
      expect(names).toContain('claude');
      expect(names).toContain('gemini');
    });
  });

  describe('Agent Properties', () => {
    it('should have required adapter properties', () => {
      const agents = AgentRegistry.getAllAgents();

      agents.forEach((agent) => {
        expect(agent.name).toBeDefined();
        expect(agent.displayName).toBeDefined();
        expect(agent.description).toBeDefined();
        expect(typeof agent.isInstalled).toBe('function');
        expect(typeof agent.install).toBe('function');
        expect(typeof agent.uninstall).toBe('function');
        expect(typeof agent.run).toBe('function');
      });
    });

    it('should have unique agent names', () => {
      const names = AgentRegistry.getAgentNames();
      const uniqueNames = new Set(names);

      expect(names.length).toBe(uniqueNames.size);
    });
  });

  describe('Installed Agents', () => {
    it('should filter installed agents', async () => {
      const installedAgents = await AgentRegistry.getInstalledAgents();

      // Should return an array (may be empty if no agents installed)
      expect(Array.isArray(installedAgents)).toBe(true);

      // All returned agents should report as installed
      for (const agent of installedAgents) {
        const isInstalled = await agent.isInstalled();
        expect(isInstalled).toBe(true);
      }
    });

    it('should include built-in agent in installed agents', async () => {
      const installedAgents = await AgentRegistry.getInstalledAgents();

      // Built-in agent should always be "installed"
      const builtInAgent = installedAgents.find(
        (agent) => agent.name === BUILTIN_AGENT_NAME
      );

      expect(builtInAgent).toBeDefined();
    });
  });

  describe('Agent Adapter Interface', () => {
    it('should implement AgentAdapter interface', () => {
      const agent = AgentRegistry.getAgent('claude');

      if (agent) {
        // Check all required methods exist
        expect(typeof agent.isInstalled).toBe('function');
        expect(typeof agent.install).toBe('function');
        expect(typeof agent.uninstall).toBe('function');
        expect(typeof agent.run).toBe('function');
        expect(typeof agent.getVersion).toBe('function');

        // Check all required properties exist
        expect(typeof agent.name).toBe('string');
        expect(typeof agent.displayName).toBe('string');
        expect(typeof agent.description).toBe('string');
      }
    });
  });
});
