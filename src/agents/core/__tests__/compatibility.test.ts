/**
 * Tests for Provider-Agent Compatibility System
 *
 * Tests the unidirectional dependency pattern where providers declare
 * which agents they support.
 */

import { describe, it, expect } from 'vitest';
import {
  isProviderCompatible,
  getCompatibleProviders,
  getIncompatibilityReason,
  validateCompatibility
} from '../compatibility.js';
import type { ProviderTemplate } from '../../../providers/core/types.js';

// Import providers index to auto-register all provider plugins
import '../../../providers/index.js';

describe('Compatibility System', () => {
  describe('isProviderCompatible', () => {
    it('should support wildcard agents', () => {
      const provider: ProviderTemplate = {
        name: 'universal',
        displayName: 'Universal Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['*']
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(true);
      expect(isProviderCompatible('any-agent', provider)).toBe(true);
    });

    it('should respect explicit agent list', () => {
      const provider: ProviderTemplate = {
        name: 'selective',
        displayName: 'Selective Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['claude', 'codex']
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(true);
      expect(isProviderCompatible('gemini', provider)).toBe(false);
      expect(isProviderCompatible('unknown', provider)).toBe(false);
    });

    it('should handle unsupportedAgents with wildcard', () => {
      const provider: ProviderTemplate = {
        name: 'mostly-universal',
        displayName: 'Mostly Universal Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['*'],
        unsupportedAgents: ['deepagents', 'oldagent']
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(true);
      expect(isProviderCompatible('deepagents', provider)).toBe(false);
      expect(isProviderCompatible('oldagent', provider)).toBe(false);
    });

    it('should handle unsupportedAgents with explicit list', () => {
      const provider: ProviderTemplate = {
        name: 'conflicting',
        displayName: 'Conflicting Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['claude', 'codex', 'gemini'],
        unsupportedAgents: ['codex'] // Exclusion takes precedence
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(false); // Explicitly blocked
      expect(isProviderCompatible('gemini', provider)).toBe(true);
    });

    it('should default to all agents when no supportedAgents defined', () => {
      const provider: ProviderTemplate = {
        name: 'implicit-all',
        displayName: 'Implicit All Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost'
        // No supportedAgents field
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(true);
      expect(isProviderCompatible('any-agent', provider)).toBe(true);
    });

    it('should respect unsupportedAgents even with implicit all', () => {
      const provider: ProviderTemplate = {
        name: 'implicit-with-exclusions',
        displayName: 'Implicit All with Exclusions',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        // No supportedAgents (defaults to all)
        unsupportedAgents: ['oldagent']
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('oldagent', provider)).toBe(false);
    });

    it('should handle empty supportedAgents array', () => {
      const provider: ProviderTemplate = {
        name: 'empty-list',
        displayName: 'Empty List Provider',
        description: 'Test provider',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: [] // Empty = all agents
      };

      expect(isProviderCompatible('claude', provider)).toBe(true);
      expect(isProviderCompatible('codex', provider)).toBe(true);
    });
  });

  describe('getCompatibleProviders', () => {
    it('should return all compatible providers for an agent', () => {
      // This test uses actual provider registry
      const compatibleForClaude = getCompatibleProviders('claude');

      // Should include SSO (wildcard), Bedrock (explicit), LiteLLM (wildcard)
      const providerNames = compatibleForClaude.map(p => p.name);

      expect(providerNames).toContain('ai-run-sso');
      expect(providerNames).toContain('bedrock');
      expect(providerNames).toContain('litellm');

      // Should NOT include Ollama (only supports codex, gemini, codemie-code)
      expect(providerNames).not.toContain('ollama');
    });

    it('should return providers for codex', () => {
      const compatibleForCodex = getCompatibleProviders('codex');
      const providerNames = compatibleForCodex.map(p => p.name);

      // Should include Ollama (explicit), SSO (wildcard), LiteLLM (wildcard)
      expect(providerNames).toContain('ollama');
      expect(providerNames).toContain('ai-run-sso');
      expect(providerNames).toContain('litellm');

      // Should NOT include Bedrock (only supports claude, codemie-code)
      expect(providerNames).not.toContain('bedrock');
    });
  });

  describe('getIncompatibilityReason', () => {
    it('should return null for compatible combinations', () => {
      const provider: ProviderTemplate = {
        name: 'test',
        displayName: 'Test Provider',
        description: 'Test',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['claude']
      };

      expect(getIncompatibilityReason('claude', provider)).toBeNull();
    });

    it('should provide reason for explicit exclusion', () => {
      const provider: ProviderTemplate = {
        name: 'test',
        displayName: 'Test Provider',
        description: 'Test',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['*'],
        unsupportedAgents: ['oldagent']
      };

      const reason = getIncompatibilityReason('oldagent', provider);
      expect(reason).toContain('does not support');
      expect(reason).toContain('oldagent');
    });

    it('should provide reason for not in explicit list', () => {
      const provider: ProviderTemplate = {
        name: 'test',
        displayName: 'Test Provider',
        description: 'Test',
        defaultBaseUrl: 'http://localhost',
        supportedAgents: ['claude', 'codex']
      };

      const reason = getIncompatibilityReason('gemini', provider);
      expect(reason).toContain('only supports');
      expect(reason).toContain('claude');
      expect(reason).toContain('codex');
    });
  });

  describe('validateCompatibility', () => {
    it('should not throw for compatible combinations', () => {
      // These should not throw (using actual providers)
      expect(() => validateCompatibility('claude', 'ai-run-sso')).not.toThrow();
      expect(() => validateCompatibility('codex', 'ollama')).not.toThrow();
      expect(() => validateCompatibility('claude', 'litellm')).not.toThrow();
    });

    it('should throw with helpful message for incompatible combinations', () => {
      // Claude + Ollama should fail (Ollama only supports codex, gemini, codemie-code)
      expect(() => validateCompatibility('claude', 'ollama')).toThrow(/only supports/);
      expect(() => validateCompatibility('claude', 'ollama')).toThrow(/codex.*gemini/);
    });

    it('should throw for unknown provider', () => {
      expect(() => validateCompatibility('claude', 'unknown-provider')).toThrow(/not found/);
    });

    it('should include compatible providers in error message', () => {
      try {
        validateCompatibility('claude', 'ollama');
        expect.fail('Should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        // Should suggest compatible providers
        expect(message).toContain('Compatible providers');
        expect(message).toContain('ai-run-sso');
      }
    });
  });

  describe('Real-World Scenarios', () => {
    it('Ollama: supports OpenAI-compatible agents only', () => {
      // Ollama supports codex, gemini, codemie-code (OpenAI-compatible)
      expect(() => validateCompatibility('codex', 'ollama')).not.toThrow();
      expect(() => validateCompatibility('gemini', 'ollama')).not.toThrow();
      expect(() => validateCompatibility('codemie-code', 'ollama')).not.toThrow();

      // Ollama does NOT support claude (Anthropic SDK)
      expect(() => validateCompatibility('claude', 'ollama')).toThrow();
    });

    it('Bedrock: supports Anthropic SDK agents only', () => {
      // Bedrock supports claude (Anthropic SDK)
      expect(() => validateCompatibility('claude', 'bedrock')).not.toThrow();
      expect(() => validateCompatibility('codemie-code', 'bedrock')).not.toThrow();

      // Bedrock does NOT support codex/gemini (OpenAI-compatible)
      expect(() => validateCompatibility('codex', 'bedrock')).toThrow();
      expect(() => validateCompatibility('gemini', 'bedrock')).toThrow();
    });

    it('SSO: universal provider supports all agents', () => {
      // SSO uses wildcard, should support everything
      expect(() => validateCompatibility('claude', 'ai-run-sso')).not.toThrow();
      expect(() => validateCompatibility('codex', 'ai-run-sso')).not.toThrow();
      expect(() => validateCompatibility('gemini', 'ai-run-sso')).not.toThrow();
      expect(() => validateCompatibility('codemie-code', 'ai-run-sso')).not.toThrow();
    });

    it('LiteLLM: universal proxy supports all agents', () => {
      // LiteLLM uses wildcard, should support everything
      expect(() => validateCompatibility('claude', 'litellm')).not.toThrow();
      expect(() => validateCompatibility('codex', 'litellm')).not.toThrow();
      expect(() => validateCompatibility('gemini', 'litellm')).not.toThrow();
      expect(() => validateCompatibility('codemie-code', 'litellm')).not.toThrow();
    });
  });
});
