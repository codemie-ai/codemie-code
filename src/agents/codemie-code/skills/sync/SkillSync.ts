import { readdir, stat, mkdir, copyFile, readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../../../../utils/logger.js';
import { SkillManager } from '../core/SkillManager.js';
import type { SkillSource } from '../core/types.js';

/**
 * Options for skill sync operation
 */
export interface SyncOptions {
  /** Project working directory */
  cwd?: string;
  /** Remove orphaned synced skills */
  clean?: boolean;
  /** Preview without writing */
  dryRun?: boolean;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** Skills copied/updated */
  synced: string[];
  /** Skills unchanged (up-to-date) */
  skipped: string[];
  /** Skills cleaned up (--clean) */
  removed: string[];
  /** Non-fatal errors */
  errors: string[];
}

/**
 * Entry in the sync manifest for a single skill
 */
interface SyncManifestEntry {
  /** Skill source type */
  source: SkillSource;
  /** Absolute path to source SKILL.md */
  sourcePath: string;
  /** ISO timestamp of last sync */
  syncedAt: string;
  /** Source file mtime at sync time (ms) */
  mtimeMs: number;
}

/**
 * Sync manifest stored at .claude/skills/.codemie-sync.json
 */
interface SyncManifest {
  /** ISO timestamp of last sync */
  lastSync: string;
  /** Synced skills keyed by skill name */
  skills: Record<string, SyncManifestEntry>;
}

/**
 * Sync CodeMie-managed skills into Claude Code's .claude/skills/ directory.
 *
 * Uses SkillManager to discover ALL skills from ALL sources (project, global,
 * plugin, mode-specific) and copies entire skill directories (SKILL.md +
 * reference files) to the target. Tracks synced state via a manifest file
 * for incremental sync (mtime comparison).
 */
export class SkillSync {
  private readonly MANIFEST_FILE = '.codemie-sync.json';

  /**
   * Sync all CodeMie skills to .claude/skills/
   */
  async syncToClaude(options: SyncOptions = {}): Promise<SyncResult> {
    const { cwd = process.cwd(), clean = false, dryRun = false } = options;

    const result: SyncResult = {
      synced: [],
      skipped: [],
      removed: [],
      errors: [],
    };

    const targetBase = join(cwd, '.claude', 'skills');

    try {
      // Discover all skills
      const manager = SkillManager.getInstance();
      manager.reload(); // Force fresh discovery
      const skills = await manager.listSkills({ cwd });

      if (skills.length === 0) {
        logger.debug('[SkillSync] No skills discovered, nothing to sync');
        return result;
      }

      // Ensure target directory exists
      if (!dryRun) {
        await mkdir(targetBase, { recursive: true });
      }

      // Load existing manifest
      const manifest = await this.loadManifest(targetBase);

      // Track which skill names we process (for clean-up)
      const processedNames = new Set<string>();

      // Sync each skill
      for (const skill of skills) {
        // Use namespaced name for plugin skills, regular name otherwise
        const skillName = skill.pluginInfo?.fullSkillName ?? skill.metadata.name;
        processedNames.add(skillName);

        const sourceDir = dirname(skill.filePath);
        const targetDir = join(targetBase, skillName);

        try {
          // Check if sync is needed (mtime comparison)
          const sourceStat = await stat(skill.filePath);
          const manifestEntry = manifest.skills[skillName];

          if (
            manifestEntry &&
            manifestEntry.sourcePath === skill.filePath &&
            manifestEntry.mtimeMs === sourceStat.mtimeMs
          ) {
            result.skipped.push(skillName);
            continue;
          }

          if (dryRun) {
            result.synced.push(skillName);
            continue;
          }

          // Copy entire source directory to target
          await this.copyDirectory(sourceDir, targetDir);

          // Update manifest entry
          manifest.skills[skillName] = {
            source: skill.source,
            sourcePath: skill.filePath,
            syncedAt: new Date().toISOString(),
            mtimeMs: sourceStat.mtimeMs,
          };

          result.synced.push(skillName);
          logger.debug(`[SkillSync] Synced: ${skillName} (${skill.source})`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`${skillName}: ${msg}`);
          logger.debug(`[SkillSync] Error syncing ${skillName}: ${msg}`);
        }
      }

      // Clean orphaned skills (in manifest but no longer discovered)
      if (clean) {
        for (const name of Object.keys(manifest.skills)) {
          if (!processedNames.has(name)) {
            const orphanDir = join(targetBase, name);

            if (dryRun) {
              result.removed.push(name);
              continue;
            }

            try {
              if (existsSync(orphanDir)) {
                await rm(orphanDir, { recursive: true, force: true });
              }
              delete manifest.skills[name];
              result.removed.push(name);
              logger.debug(`[SkillSync] Removed orphaned skill: ${name}`);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              result.errors.push(`clean ${name}: ${msg}`);
            }
          }
        }
      }

      // Write updated manifest
      if (!dryRun) {
        manifest.lastSync = new Date().toISOString();
        await this.saveManifest(targetBase, manifest);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`sync failed: ${msg}`);
      logger.debug(`[SkillSync] Sync failed: ${msg}`);
    }

    return result;
  }

  /**
   * Load sync manifest from target directory
   */
  private async loadManifest(targetBase: string): Promise<SyncManifest> {
    const manifestPath = join(targetBase, this.MANIFEST_FILE);

    try {
      if (existsSync(manifestPath)) {
        const content = await readFile(manifestPath, 'utf-8');
        return JSON.parse(content) as SyncManifest;
      }
    } catch (error) {
      logger.debug(`[SkillSync] Could not load manifest, starting fresh: ${error}`);
    }

    return { lastSync: '', skills: {} };
  }

  /**
   * Save sync manifest to target directory
   */
  private async saveManifest(targetBase: string, manifest: SyncManifest): Promise<void> {
    const manifestPath = join(targetBase, this.MANIFEST_FILE);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * Recursively copy a directory
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });

    const entries = await readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        await this.copyDirectory(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }
}
