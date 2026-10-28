import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader, canUseSharedIdentity } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * Isolates CodeMie identity per global profile. Each field is handled by name
 * rather than a generic keyof loop, since codeMieIntegration is an object and
 * the others are strings — a mixed-type loop needs an `any` escape hatch.
 */
function hasIdentity(source: WorkspaceConfig | ProviderProfile): boolean {
  return source.codeMieUrl !== undefined || source.codeMieProject !== undefined || source.codeMieIntegration !== undefined;
}

// All-or-nothing per profile, not per-field: a profile that already defines ANY
// of its own identity fields gets none of the shared ones. Gap-filling only the
// missing fields could pair this profile's own (correct) field with a shared
// field that belongs to a different environment — the shared workspace is a
// single object that may have been left over from whichever profile saved last,
// not necessarily this one's. canUseSharedIdentity() (shared with the read-time
// fallback in config.ts — see its own doc comment) additionally refuses on
// positive evidence the shared value belongs to a different profile/environment;
// a vendor-subscription profile or a lone split-host ai-run-sso profile is always
// allowed by that check.
function withIdentityFrom(
  profile: ProviderProfile,
  source: WorkspaceConfig,
  allProfiles: Record<string, ProviderProfile>,
  ownName: string
): { profile: ProviderProfile; changed: boolean } {
  if (hasIdentity(profile) || !canUseSharedIdentity(profile, allProfiles, ownName, source.codeMieUrl)) {
    return { profile, changed: false };
  }
  const cloned: ProviderProfile = { ...profile };
  let changed = false;
  if (source.codeMieUrl !== undefined) {
    cloned.codeMieUrl = source.codeMieUrl;
    changed = true;
  }
  if (source.codeMieProject !== undefined) {
    cloned.codeMieProject = source.codeMieProject;
    changed = true;
  }
  if (source.codeMieIntegration !== undefined) {
    cloned.codeMieIntegration = source.codeMieIntegration;
    changed = true;
  }
  return { profile: cloned, changed };
}

class IsolateGlobalProfileIdentityMigration implements Migration {
  id = '008-isolate-global-profile-identity';
  description = 'Clone the shared global workspace identity trio onto every global profile so each resolves its own CodeMie identity';

  async up(): Promise<MigrationResult> {
    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    if (!hasGlobal) {
      return { success: true, migrated: false };
    }

    const globalConfig = await ConfigLoader.loadMultiProviderConfig();
    const migratedGlobal = this.migrate(globalConfig);
    if (migratedGlobal === globalConfig) {
      return { success: true, migrated: false };
    }

    await ConfigLoader.saveMultiProviderConfig(migratedGlobal);
    return { success: true, migrated: true };
  }

  migrate(config: MultiProviderConfig): MultiProviderConfig {
    const sharedWorkspace: WorkspaceConfig = config.workspace ?? {};
    if (!hasIdentity(sharedWorkspace)) return config;

    const sourceProfiles = config.profiles ?? {};
    const profiles: Record<string, ProviderProfile> = {};
    let anyChanged = false;
    for (const [name, profile] of Object.entries(sourceProfiles)) {
      const result = withIdentityFrom(profile, sharedWorkspace, sourceProfiles, name);
      profiles[name] = result.profile;
      anyChanged = anyChanged || result.changed;
    }

    // Nobody actually received the shared identity (every profile already had
    // its own, or every CodeMie-platform profile was refused) — nothing changed.
    if (!anyChanged) return config;

    // The shared workspace identity is NEVER stripped, even after cloning it onto
    // every eligible profile: it remains the permanent ambient fallback for local
    // profiles with no identity of their own (AC5 — their behavior must not
    // regress) and for any profile this migration could not or did not clone it
    // onto. Global profiles that did clone their own copy above always resolve it
    // first (see resolveProfileWorkspace() / canUseSharedIdentity() in config.ts),
    // so this leftover value is inert for them once they own their own copy.
    return { ...config, profiles };
  }
}

const migration = new IsolateGlobalProfileIdentityMigration();
MigrationRegistry.register(migration);
export { IsolateGlobalProfileIdentityMigration };
