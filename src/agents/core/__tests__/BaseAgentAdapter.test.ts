import { describe, it, expect } from 'vitest';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { AgentMetadata } from '../types.js';

/**
 * Test adapter that extends BaseAgentAdapter
 * Used to test protected methods and metadata access
 */
class TestAdapter extends BaseAgentAdapter {
  constructor(metadata: AgentMetadata) {
    super(metadata);
  }

  // Expose protected metadata for testing
  getMetadata(): AgentMetadata {
    return this.metadata;
  }

  // Implement required abstract methods (no-ops for testing)
  async run(): Promise<void> {
    // No-op for testing
  }
}

describe('BaseAgentAdapter', () => {
  describe('setSilentMode', () => {
    it('should set silentMode to true when enabled', () => {
      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: false // Start as false
      };

      const adapter = new TestAdapter(metadata);

      // Initial state
      expect(adapter.getMetadata().silentMode).toBe(false);

      // Call setter
      adapter.setSilentMode(true);

      // Verify it changed
      expect(adapter.getMetadata().silentMode).toBe(true);
    });

    it('should set silentMode to false when disabled', () => {
      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: true // Start as true
      };

      const adapter = new TestAdapter(metadata);

      // Initial state
      expect(adapter.getMetadata().silentMode).toBe(true);

      // Call setter
      adapter.setSilentMode(false);

      // Verify it changed
      expect(adapter.getMetadata().silentMode).toBe(false);
    });

    it('should not affect original metadata object (verify cloning)', () => {
      const originalMetadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping: {},
        supportedProviders: ['openai'],
        silentMode: false
      };

      const adapter = new TestAdapter(originalMetadata);

      // Modify via setter
      adapter.setSilentMode(true);

      // Original should be unchanged (verify shallow copy worked)
      expect(originalMetadata.silentMode).toBe(false);
      expect(adapter.getMetadata().silentMode).toBe(true);
    });
  });

  describe('constructor metadata cloning', () => {
    it('should create a shallow copy of metadata', () => {
      const envMapping = { apiKey: ['TEST_KEY'] };
      const lifecycle = {
        beforeRun: async (env: NodeJS.ProcessEnv) => env
      };

      const metadata: AgentMetadata = {
        name: 'test',
        displayName: 'Test Agent',
        description: 'Test agent for unit testing',
        npmPackage: null,
        cliCommand: null,
        envMapping,
        supportedProviders: ['openai'],
        lifecycle
      };

      const adapter = new TestAdapter(metadata);

      // Top-level object should be different (cloned)
      expect(adapter.getMetadata()).not.toBe(metadata);

      // Nested objects should be same reference (shallow copy)
      expect(adapter.getMetadata().envMapping).toBe(envMapping);
      expect(adapter.getMetadata().lifecycle).toBe(lifecycle);
    });
  });
});
