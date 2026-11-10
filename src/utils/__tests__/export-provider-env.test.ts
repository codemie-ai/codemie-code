/**
 * Unit tests for ConfigLoader.exportProviderEnvVars (src/utils/config.ts).
 *
 * exportProviderEnvVars maps a profile CodeMieConfigOptions object to the
 * generic CODEMIE_* env vars that agents later transform into their own
 * namespace (ANTHROPIC_*, OPENAI_*, ...). Model-tier propagation is already
 * covered exhaustively by agents/core/__tests__/model-tier-config.test.ts
 * (the CODEMIE_*_MODEL -> ANTHROPIC_DEFAULT_*_MODEL transform side); this file
 * pins the *export* side and the untested field mappings.
 *
 * All expectations were captured by running the compiled function first
 * (regression pinning of today's contract). Importing config.js transitively
 * imports src/providers/index.js, which auto-registers all provider plugins,
 * so requiresAuth-based defaults (e.g. ollama) resolve without extra imports.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../config.js';
import type { CodeMieConfigOptions } from '../config.js';

// Helper: build a partial config without fighting the full interface shape.
function cfg(partial: Record<string, unknown>): CodeMieConfigOptions {
  return partial as unknown as CodeMieConfigOptions;
}

describe('ConfigLoader.exportProviderEnvVars', () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    // Restore any accidental env mutation (function should not touch it).
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  describe('always-emitted keys (stale-value clearing)', () => {
    it('emits API key + all three tier vars + auth method even for an empty config', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({}));

      // These keys are ALWAYS present so a stale shell value cannot survive an
      // env merge in BaseAgentAdapter.
      expect(env).toHaveProperty('CODEMIE_API_KEY');
      expect(env).toHaveProperty('CODEMIE_HAIKU_MODEL');
      expect(env).toHaveProperty('CODEMIE_SONNET_MODEL');
      expect(env).toHaveProperty('CODEMIE_OPUS_MODEL');
      expect(env).toHaveProperty('CODEMIE_AUTH_METHOD');

      // Absent tiers/auth are emitted as empty strings (falsy -> downstream
      // transform skips them, but the key still overrides a stale value).
      expect(env.CODEMIE_HAIKU_MODEL).toBe('');
      expect(env.CODEMIE_SONNET_MODEL).toBe('');
      expect(env.CODEMIE_OPUS_MODEL).toBe('');
      expect(env.CODEMIE_AUTH_METHOD).toBe('');
      // Unregistered/absent provider -> empty API key (no 'not-required').
      expect(env.CODEMIE_API_KEY).toBe('');
    });

    it('omits optional keys entirely when their config fields are unset', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({}));

      expect(env).not.toHaveProperty('CODEMIE_PROVIDER');
      expect(env).not.toHaveProperty('CODEMIE_BASE_URL');
      expect(env).not.toHaveProperty('CODEMIE_MODEL');
      expect(env).not.toHaveProperty('CODEMIE_REASONING_EFFORT');
      expect(env).not.toHaveProperty('CODEMIE_TIMEOUT');
      expect(env).not.toHaveProperty('CODEMIE_DEBUG');
    });

    it('clears stale tier vars: a config with only sonnet still emits empty haiku/opus', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ sonnetModel: 'claude-sonnet-x' }));

      expect(env.CODEMIE_SONNET_MODEL).toBe('claude-sonnet-x');
      expect(env.CODEMIE_HAIKU_MODEL).toBe('');
      expect(env.CODEMIE_OPUS_MODEL).toBe('');
    });
  });

  describe('provider / baseUrl / apiKey / model basics', () => {
    it('maps the core connection fields to their CODEMIE_* vars', () => {
      const env = ConfigLoader.exportProviderEnvVars(
        cfg({
          provider: 'openai',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-123',
          model: 'gpt-4o',
        })
      );

      expect(env.CODEMIE_PROVIDER).toBe('openai');
      expect(env.CODEMIE_BASE_URL).toBe('https://api.example.com');
      expect(env.CODEMIE_API_KEY).toBe('sk-123');
      expect(env.CODEMIE_MODEL).toBe('gpt-4o');
    });

    it('defaults CODEMIE_API_KEY to "not-required" for a requiresAuth:false provider (ollama)', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'ollama' }));

      expect(env.CODEMIE_PROVIDER).toBe('ollama');
      expect(env.CODEMIE_API_KEY).toBe('not-required');
    });

    it('an explicit apiKey overrides the "not-required" default', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'ollama', apiKey: 'my-key' }));

      expect(env.CODEMIE_API_KEY).toBe('my-key');
    });

    it('an unregistered provider name yields an empty API key (no auth default applied)', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'totally-unknown-provider' }));

      expect(env.CODEMIE_PROVIDER).toBe('totally-unknown-provider');
      expect(env.CODEMIE_API_KEY).toBe('');
    });
  });

  describe('timeout mapping', () => {
    it('stringifies a positive timeout into CODEMIE_TIMEOUT', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ timeout: 30000 }));

      expect(env.CODEMIE_TIMEOUT).toBe('30000');
      expect(typeof env.CODEMIE_TIMEOUT).toBe('string');
    });

    it('omits CODEMIE_TIMEOUT when timeout is 0 (unlimited / falsy)', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ timeout: 0 }));

      expect(env).not.toHaveProperty('CODEMIE_TIMEOUT');
    });
  });

  describe('debug mapping', () => {
    it('emits CODEMIE_DEBUG="true" when debug is enabled', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ debug: true }));

      expect(env.CODEMIE_DEBUG).toBe('true');
    });

    it('omits CODEMIE_DEBUG when debug is false', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ debug: false }));

      expect(env).not.toHaveProperty('CODEMIE_DEBUG');
    });
  });

  describe('reasoningEffort and authMethod passthrough', () => {
    it('maps reasoningEffort to CODEMIE_REASONING_EFFORT', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ reasoningEffort: 'high' }));

      expect(env.CODEMIE_REASONING_EFFORT).toBe('high');
    });

    it('passes an explicit authMethod through to CODEMIE_AUTH_METHOD', () => {
      const env = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'sso', authMethod: 'sso' }));

      expect(env.CODEMIE_AUTH_METHOD).toBe('sso');
    });
  });

  describe('fields that are NOT exported by this function', () => {
    it('does not export allowedDirs / ignorePatterns / codeMieIntegration / max*Tokens', () => {
      // These fields are consumed on the INPUT side (loadFromEnv reads
      // CODEMIE_ALLOWED_DIRS etc.), but exportProviderEnvVars deliberately does
      // NOT round-trip them back out. Pin that so a future change is noticed.
      const env = ConfigLoader.exportProviderEnvVars(
        cfg({
          provider: 'openai',
          allowedDirs: ['/a', '/b'],
          ignorePatterns: ['node_modules', 'dist'],
          maxOutputTokens: 4096,
          maxThinkingTokens: 2048,
          codeMieIntegration: { id: 'int-1', alias: 'my-alias' },
        })
      );

      expect(env).not.toHaveProperty('CODEMIE_ALLOWED_DIRS');
      expect(env).not.toHaveProperty('CODEMIE_IGNORE_PATTERNS');
      expect(env).not.toHaveProperty('CODEMIE_INTEGRATION_ID');
      expect(env).not.toHaveProperty('CODEMIE_INTEGRATION_ALIAS');
      expect(env).not.toHaveProperty('CODEMIE_MAX_OUTPUT_TOKENS');
      expect(env).not.toHaveProperty('CODEMIE_MAX_THINKING_TOKENS');

      // Sanity: the recognized fields are still exported from the same object.
      expect(env.CODEMIE_PROVIDER).toBe('openai');
    });
  });

  describe('purity / isolation', () => {
    it('returns a fresh object and does not mutate process.env', () => {
      const before = { ...process.env };

      const a = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'openai', apiKey: 'k' }));
      const b = ConfigLoader.exportProviderEnvVars(cfg({ provider: 'openai', apiKey: 'k' }));

      // Distinct object instances (no shared mutable state between calls).
      expect(a).not.toBe(b);
      expect(a).toEqual(b);

      // process.env must be untouched by the export.
      expect(process.env).toEqual(before);
    });
  });
});
