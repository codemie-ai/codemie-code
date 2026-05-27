import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import { ConfigurationError } from '../utils/errors.js';
import { sanitizeToSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';
import { StorageScope } from '../env/types.js';
import type { MultiProviderConfig, CodemieSkill } from '../env/types.js';

class SkillSlugFormatMigration implements Migration {
  id = '005-skill-slug-format';
  description = 'Update skill directory slugs to include project/scope suffix for uniqueness';

  async up(): Promise<MigrationResult> {
    const workingDir = process.cwd();
    let migrated = false;

    const globalConfig = await ConfigLoader.loadMultiProviderConfig();

    const hasProfileLevelSkills = Object.values(globalConfig.profiles).some(
      p => (p as any).codemieSkills?.length > 0
    );
    if (hasProfileLevelSkills && !globalConfig.codemieSkills?.length) {
      throw new ConfigurationError(
        '005-skill-slug-format migration requires migration 004 (move-skills-to-top-level) to have run first. ' +
        'Skills are still stored inside profiles rather than at the top-level config.'
      );
    }

    const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    const { config: migratedGlobal, changed: globalChanged } =
      await this.migrateSkillSlugs(globalConfig, StorageScope.GLOBAL, globalSkillsDir);
    if (globalChanged) {
      await ConfigLoader.saveMultiProviderConfig(migratedGlobal);
      migrated = true;
    }

    const hasLocal = await ConfigLoader.hasProjectConfig(workingDir);
    if (hasLocal) {
      const localConfig = await ConfigLoader.loadLocalMultiProviderConfig(workingDir);
      const localSkillsDir = path.join(workingDir, '.claude', 'skills');
      const { config: migratedLocal, changed: localChanged } =
        await this.migrateSkillSlugs(localConfig, StorageScope.LOCAL, localSkillsDir);
      if (localChanged) {
        await ConfigLoader.saveLocalMultiProviderConfig(workingDir, migratedLocal);
        migrated = true;
      }
    }

    return { success: true, migrated };
  }

  private async migrateSkillSlugs(
    config: MultiProviderConfig,
    scope: StorageScope,
    skillsDir: string
  ): Promise<{ config: MultiProviderConfig; changed: boolean }> {
    const skills = config.codemieSkills ?? [];
    if (skills.length === 0) return { config, changed: false };

    let changed = false;
    const updatedSkills = await Promise.all(skills.map(async (skill) => {
      const newSlug = this.computeNewSlug(skill, scope);
      if (skill.slug === newSlug) return skill;

      const oldDir = path.join(skillsDir, skill.slug);
      const newDir = path.join(skillsDir, newSlug);

      let dirExists = false;
      try {
        await fs.access(oldDir);
        dirExists = true;
      } catch {
        // old directory doesn't exist — safe to update config slug only
      }

      if (dirExists) {
        try {
          await fs.rename(oldDir, newDir);
        } catch (err) {
          logger.debug(`005 migration: failed to rename skill directory ${oldDir} → ${newDir}: ${(err as Error).message}`);
          return skill;
        }
      }

      changed = true;
      return { ...skill, slug: newSlug };
    }));

    return { config: { ...config, codemieSkills: updatedSkills }, changed };
  }

  private computeNewSlug(skill: CodemieSkill, scope: StorageScope): string {
    const base = sanitizeToSlug(skill.name) || sanitizeToSlug(skill.id);
    const projectSuffix = skill.project ? `-${sanitizeToSlug(skill.project)}` : '';
    return `${base}${projectSuffix}-${scope}`;
  }
}

const migration = new SkillSlugFormatMigration();
MigrationRegistry.register(migration);
export { SkillSlugFormatMigration };
