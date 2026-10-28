import { describe, it, expect } from 'vitest';
import { IsolateGlobalProfileIdentityMigration } from '../008-isolate-global-profile-identity.migration.js';
import type { MultiProviderConfig } from '../../env/types.js';

const migration = new IsolateGlobalProfileIdentityMigration();
const migrate = (config: any): MultiProviderConfig => migration.migrate(config);

describe('IsolateGlobalProfileIdentityMigration', () => {
  it('clones the shared workspace identity trio onto every global profile while keeping it in workspace as a permanent fallback', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' },
        'env-b': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj',
        hooks: { PreToolUse: [] }
      }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-a'] as any).codeMieProject).toBe('shared-proj');
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
    // Never stripped: it remains the historical ambient fallback for local profiles
    // with no identity of their own (AC5) and for any profile that could not claim
    // it. Global profiles that cloned their own copy above always resolve it first.
    expect(result.workspace?.codeMieUrl).toBe('https://shared.example.com');
    expect(result.workspace?.codeMieProject).toBe('shared-proj');
    expect(result.workspace?.hooks).toEqual({ PreToolUse: [] });
  });

  it('does not overwrite a profile that already defines its own identity', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', codeMieUrl: 'https://already-own.example.com' }
      },
      workspace: { codeMieUrl: 'https://shared.example.com' }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://already-own.example.com');
  });

  it('treats the identity trio as a unit: a profile that already defines ANY of its own identity fields gets none of the shared ones, to avoid mixing environments', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        // Already has its own codeMieProject but no codeMieUrl. Gap-filling codeMieUrl
        // from the shared workspace here would risk pairing this profile's own project
        // with a codeMieUrl from a different (shared) environment — skip the whole trio.
        'env-a': { provider: 'ai-run-sso', codeMieProject: 'env-a-own-proj' },
        'env-b': { provider: 'ai-run-sso' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj'
      }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBeUndefined();
    expect((result.profiles['env-a'] as any).codeMieProject).toBe('env-a-own-proj');
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
    // Still never stripped, even though env-a's own partial identity means it will
    // never read this value either (same atomic-trio rule applies at read time) —
    // other profiles/local configs with no identity of their own still depend on it.
    expect(result.workspace?.codeMieUrl).toBe('https://shared.example.com');
  });

  it('skips the copy for a profile whose baseUrl origin does not match the shared codeMieUrl, to avoid pinning another environment\'s project onto it', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        // Last profile saved before the bug fix — its own backend, but the
        // shared workspace identity now belongs to a different one.
        'medecision': { provider: 'ai-run-sso', baseUrl: 'https://codemie.gcp.medecision.com/code-assistant-api' },
        'env-b': { provider: 'ai-run-sso', baseUrl: 'https://shared.example.com/code-assistant-api' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj'
      }
    };

    const result = migrate(config);

    expect((result.profiles['medecision'] as any).codeMieUrl).toBeUndefined();
    expect((result.profiles['medecision'] as any).codeMieProject).toBeUndefined();
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
  });

  it('clones the shared identity onto a vendor-subscription profile regardless of baseUrl origin', () => {
    const config: any = {
      version: 2,
      activeProfile: 'anthropic-sub',
      profiles: {
        'anthropic-sub': { provider: 'anthropic-subscription', baseUrl: 'https://api.anthropic.com' }
      },
      workspace: { codeMieUrl: 'https://codemie.lab.epam.com', codeMieProject: 'epm-cdme' }
    };

    const result = migrate(config);

    expect((result.profiles['anthropic-sub'] as any).codeMieUrl).toBe('https://codemie.lab.epam.com');
    expect((result.profiles['anthropic-sub'] as any).codeMieProject).toBe('epm-cdme');
    expect(result.workspace?.codeMieUrl).toBe('https://codemie.lab.epam.com');
  });

  it('clones the shared identity onto a lone ai-run-sso profile with a split API host, when no sibling claims the shared origin', () => {
    const config: any = {
      version: 2,
      activeProfile: 'split-host',
      profiles: {
        'split-host': { provider: 'ai-run-sso', baseUrl: 'https://api.split-host.example.com/code-assistant-api' }
      },
      workspace: { codeMieUrl: 'https://split-host.example.com', codeMieProject: 'split-host-proj' }
    };

    const result = migrate(config);

    expect((result.profiles['split-host'] as any).codeMieUrl).toBe('https://split-host.example.com');
    expect((result.profiles['split-host'] as any).codeMieProject).toBe('split-host-proj');
    expect(result.workspace?.codeMieUrl).toBe('https://split-host.example.com');
  });

  it('keeps workspace when every profile already has its own identity or every candidate was refused, so nobody loses data nobody claimed', () => {
    const config: any = {
      version: 2,
      activeProfile: 'medecision',
      profiles: {
        // Only profile, mismatched origin, no sibling evidence either way —
        // canUseSharedIdentity() would actually allow this one (no positive
        // conflict evidence), so pin a genuine refusal case: a sibling DOES
        // claim the shared origin, so medecision is refused, and env-b already
        // has its own full identity so it changes nothing either.
        'medecision': { provider: 'ai-run-sso', baseUrl: 'https://codemie.gcp.medecision.com/code-assistant-api' },
        'env-b': {
          provider: 'ai-run-sso',
          baseUrl: 'https://shared.example.com/code-assistant-api',
          codeMieUrl: 'https://shared.example.com',
          codeMieProject: 'shared-proj'
        }
      },
      workspace: { codeMieUrl: 'https://shared.example.com', codeMieProject: 'shared-proj' }
    };

    const result = migrate(config);

    expect((result.profiles['medecision'] as any).codeMieUrl).toBeUndefined();
    expect(result.workspace?.codeMieUrl).toBe('https://shared.example.com');
    expect(result.workspace?.codeMieProject).toBe('shared-proj');
  });

  it('is a no-op when workspace has no identity fields', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } },
      workspace: { hooks: { PreToolUse: [] } }
    };

    expect(migrate(config)).toBe(config);
  });

  it('is a no-op when workspace is undefined (not yet run through migration 007)', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } }
    };

    expect(migrate(config)).toBe(config);
  });
});
