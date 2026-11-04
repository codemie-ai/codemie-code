import * as fs from 'fs/promises';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { MigrationTracker } from './tracker.js';
import { ConfigLoader } from '../utils/config.js';
import { getCodemiePath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { IDENTITY_KEYS, isMultiProviderConfig } from '../env/types.js';
import type { CodeMieIntegrationInfo, MultiProviderConfig, ProviderProfile } from '../env/types.js';

/**
 * Id of the migration shipped by the reverted PR #701 (commit 71093df1), which
 * cloned the shared workspace identity onto every global profile. Only configs
 * that ran unreleased main between #701 and its revert carry those clones.
 * Differs from today's `008-repair-hook-shell-and-stale-paths`.
 */
export const PR701_MIGRATION_ID = '008-isolate-global-profile-identity';

function sameIntegration(a?: CodeMieIntegrationInfo, b?: CodeMieIntegrationInfo): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.alias === b.alias;
}

/** A profile whose identity trio equals the shared trio (and has at least one key). */
function holdsSharedTrio(profile: ProviderProfile, shared: MultiProviderConfig['workspace']): boolean {
  const hasIdentity = IDENTITY_KEYS.some((key) => profile[key] !== undefined);
  return hasIdentity
    && profile.codeMieUrl === shared?.codeMieUrl
    && profile.codeMieProject === shared?.codeMieProject
    && sameIntegration(profile.codeMieIntegration, shared?.codeMieIntegration);
}

/**
 * Repairs #701 residue only (EPMCDME-15411): when #701 may have run, every global
 * profile whose identity trio equals the shared workspace trio has that trio
 * cleared, so it becomes `unowned` and its owner confirms a project once.
 * Profiles with a different trio keep it. It never assigns a project.
 */
class ClearClonedProfileIdentityMigration implements Migration {
  id = '010-clear-cloned-profile-identity';
  description = 'Clear CodeMie identity cloned onto every global profile by the reverted #701 migration';

  /** Pure transform: the profiles cleared, and the config to write (same object when nothing changes). */
  clear(config: MultiProviderConfig): { config: MultiProviderConfig; cleared: string[] } {
    const cleared: string[] = [];
    const profiles: Record<string, ProviderProfile> = {};
    for (const [name, profile] of Object.entries(config.profiles ?? {})) {
      if (holdsSharedTrio(profile, config.workspace)) {
        const clean: Record<string, unknown> = { ...profile };
        for (const key of IDENTITY_KEYS) delete clean[key];
        profiles[name] = clean as ProviderProfile;
        cleared.push(name);
      } else {
        profiles[name] = profile;
      }
    }
    return cleared.length > 0 ? { config: { ...config, profiles }, cleared } : { config, cleared };
  }

  async up(): Promise<MigrationResult> {
    // An unparsable ledger may have lost #701's record: err toward asking once more.
    const possiblyApplied = (await MigrationTracker.hasRecord(PR701_MIGRATION_ID))
      || (await MigrationTracker.ledgerWasUnparsable());
    if (!possiblyApplied) {
      return { success: true, migrated: false, reason: 'pr701-not-applied' };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(getCodemiePath('codemie-cli.config.json'), 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { success: true, migrated: false, reason: 'no-global-config' };
      }
      // Unparsable global config: keep the migration pending and retry once it is fixed.
      logger.warn(`[${this.id}] Global config is unreadable; will retry`);
      return { success: false, migrated: false, reason: 'global-config-unreadable' };
    }
    if (!isMultiProviderConfig(raw)) {
      return { success: true, migrated: false, reason: 'not-multi-provider' };
    }

    const { config, cleared } = this.clear(raw);
    if (cleared.length === 0) {
      return { success: true, migrated: false, reason: 'nothing-to-clear' };
    }
    await ConfigLoader.saveMultiProviderConfig(config);
    logger.info(`[${this.id}] Cleared cloned CodeMie identity from ${cleared.length} profile(s)`);
    return { success: true, migrated: true, details: { cleared } };
  }
}

MigrationRegistry.register(new ClearClonedProfileIdentityMigration());
export { ClearClonedProfileIdentityMigration };
