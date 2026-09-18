import { describe, it, expect } from 'vitest';
import { DecoupleProviderWorkspaceConfigMigration } from '../007-decouple-provider-workspace-config.migration.js';
import type { MultiProviderConfig } from '../../env/types.js';

const migration = new DecoupleProviderWorkspaceConfigMigration();
const migrate = (config: any): MultiProviderConfig => migration.migrate(config);

function baseConfig(activeProfile: string, profiles: Record<string, any> = {}): any {
  return { version: 2, activeProfile, profiles };
}

describe('DecoupleProviderWorkspaceConfigMigration', () => {
  it('lifts the active profile\'s moving fields into workspace and strips them from every profile', () => {
    const config = baseConfig('active', {
      active: {
        provider: 'ai-run-sso',
        model: 'claude-sonnet-4-6',
        codeMieProject: 'active-proj',
        hooks: { PreToolUse: [] }
      },
      other: {
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-6'
      }
    });

    const result = migrate(config);

    expect(result.workspace).toEqual({
      codeMieProject: 'active-proj',
      hooks: { PreToolUse: [] }
    });
    expect((result.profiles.active as any).codeMieProject).toBeUndefined();
    expect((result.profiles.active as any).hooks).toBeUndefined();
    expect((result.profiles.other as any).codeMieProject).toBeUndefined();
    // Non-moving fields are preserved
    expect(result.profiles.active.provider).toBe('ai-run-sso');
    expect(result.profiles.other.provider).toBe('anthropic-subscription');
  });

  it('falls back to the first profile (iteration order) with a moving field when the active profile has none', () => {
    const config = baseConfig('active', {
      active: {
        provider: 'ai-run-sso',
        model: 'claude-sonnet-4-6'
      },
      other: {
        provider: 'anthropic-subscription',
        codeMieProject: 'other-proj'
      }
    });

    const result = migrate(config);

    expect(result.workspace).toEqual({ codeMieProject: 'other-proj' });
    expect((result.profiles.other as any).codeMieProject).toBeUndefined();
  });

  it('falls back to the profile with identity fields even when the active profile has an unrelated workspace field (regression for CR-007)', () => {
    // The active profile ("active") sets only `metrics` — an OTHER_WORKSPACE_KEYS
    // field — while codeMieUrl/codeMieProject/codeMieIntegration live entirely on
    // "sso". A naive "active profile has ANY workspace field" check would have
    // wrongly claimed the active profile as the sole source and silently dropped
    // the identity trio for every profile, breaking client authentication.
    const config = baseConfig('active', {
      active: {
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-6',
        metrics: { sync: true }
      },
      sso: {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://codemie.example.com',
        codeMieProject: 'sso-proj',
        codeMieIntegration: 'sso-integration'
      }
    });

    const result = migrate(config);

    expect(result.workspace).toEqual({
      codeMieUrl: 'https://codemie.example.com',
      codeMieProject: 'sso-proj',
      codeMieIntegration: 'sso-integration',
      metrics: { sync: true }
    });
    expect((result.profiles.sso as any).codeMieUrl).toBeUndefined();
    expect((result.profiles.sso as any).codeMieProject).toBeUndefined();
    expect((result.profiles.sso as any).codeMieIntegration).toBeUndefined();
    expect((result.profiles.active as any).metrics).toBeUndefined();
  });

  it('never mixes the identity trio across profiles: codeMieUrl/codeMieProject/codeMieIntegration always come from the same source profile', () => {
    const config = baseConfig('other', {
      active: {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://active.example.com',
        codeMieProject: 'active-proj',
        codeMieIntegration: 'active-integration'
      },
      other: {
        provider: 'anthropic-subscription',
        codeMieProject: 'other-proj'
      }
    });

    const result = migrate(config);

    // "other" is active and defines a (partial) identity field, so it is the sole
    // identity source — "active"'s codeMieUrl/codeMieIntegration must NOT leak in
    // and get paired with "other"'s codeMieProject.
    expect(result.workspace).toEqual({ codeMieProject: 'other-proj' });
  });

  it('resolves non-identity fields independently per key, active profile preferred', () => {
    const config = baseConfig('active', {
      active: {
        provider: 'ai-run-sso',
        hooks: { PreToolUse: [] }
      },
      other: {
        provider: 'anthropic-subscription',
        skillsSearchUrl: 'https://skills.example.com',
        hooks: { PreToolUse: ['other-hook'] }
      }
    });

    const result = migrate(config);

    // hooks: active profile defines one, so active wins even though "other" also has one.
    // skillsSearchUrl: only "other" defines it, so it's picked up despite active being preferred.
    expect(result.workspace).toEqual({
      hooks: { PreToolUse: [] },
      skillsSearchUrl: 'https://skills.example.com'
    });
  });

  it('leaves workspace unset (not an empty {}) and profiles unchanged when no profile has any moving field', () => {
    // An empty `{}` is still a *defined* workspace to resolveWorkspace()'s whole-object
    // override rule, so writing one for a scope with nothing to move would wrongly cut
    // that scope off from falling back to the global scope's workspace. See CR-003.
    const config = baseConfig('active', {
      active: { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' },
      other: { provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' }
    });

    const result = migrate(config);

    expect(result.workspace).toBeUndefined();
    expect(result.profiles.active).toEqual(config.profiles.active);
    expect(result.profiles.other).toEqual(config.profiles.other);
  });

  it('is idempotent — returns the same reference when config.workspace is already defined', () => {
    const config = {
      ...baseConfig('active', {
        active: { provider: 'ai-run-sso', codeMieProject: 'active-proj' }
      }),
      workspace: { codeMieProject: 'already-migrated' }
    };

    const result = migrate(config);

    expect(result).toBe(config);
  });

  it('treats an explicit empty workspace object as already migrated (no-op)', () => {
    const config = {
      ...baseConfig('active', {
        active: { provider: 'ai-run-sso', codeMieProject: 'active-proj' }
      }),
      workspace: {}
    };

    const result = migrate(config);

    expect(result).toBe(config);
  });

  it('handles a config with no profiles without error', () => {
    const config = baseConfig('active', {});

    const result = migrate(config);

    expect(result.workspace).toBeUndefined();
    expect(result.profiles).toEqual({});
  });
});
