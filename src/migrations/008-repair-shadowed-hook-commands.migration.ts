import * as fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { resolveCodemieBinary, rewriteHooksCommandTree } from '../utils/hook-command.js';
import { getCodemiePath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

// Repairs installed Claude/Gemini hooks whose absolute command path resolves to
// the bundled agent binary (@codemieai/codemie-opencode shim) instead of this
// CLI — a bad resolution produced by the EPMCDME-14035 fix when the CLI ran from
// a dev checkout with node_modules/.bin first in PATH. Migration 006 only
// rewrites bare `codemie` prefixes, so these absolute-but-wrong paths survived
// it; rewriteHooksCommandTree now detects and replaces them.
class RepairShadowedHookCommandsMigration implements Migration {
  id = '008-repair-shadowed-hook-commands';
  description = 'Rewrite installed Claude/Gemini hook commands that point at the bundled agent shim';

  private hookFiles(): string[] {
    return [
      getCodemiePath('claude-plugin', 'hooks', 'hooks.json'),
      path.join(homedir(), '.gemini', 'extensions', 'codemie', 'hooks', 'hooks.json'),
    ];
  }

  async up(): Promise<MigrationResult> {
    logger.info('[008-repair-shadowed-hook-commands] Starting shadowed hook command repair');

    let migrated = false;
    let anyWriteFailed = false;
    let binary: string | undefined;

    for (const file of this.hookFiles()) {
      let parsed: { hooks?: unknown };
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { hooks?: unknown };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          logger.warn(`[008-repair-shadowed-hook-commands] Skipped ${file}: ${(error as Error)?.message ?? error}`);
        }
        continue;
      }

      binary ??= await resolveCodemieBinary();
      if (rewriteHooksCommandTree(parsed.hooks, binary)) {
        try {
          await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf-8');
          logger.info(`[008-repair-shadowed-hook-commands] Rewrote ${file}`);
          migrated = true;
        } catch (error) {
          // success:false keeps the migration pending so a transient write error
          // (EACCES/EPERM/disk full) is retried, not recorded as applied forever.
          anyWriteFailed = true;
          logger.warn(
            `[008-repair-shadowed-hook-commands] Failed to write ${file}: ${(error as Error)?.message ?? error}`,
          );
        }
      }
    }

    if (anyWriteFailed) {
      return { success: false, migrated, reason: 'write-failed' };
    }
    return { success: true, migrated, reason: migrated ? undefined : 'nothing-to-rewrite' };
  }
}

MigrationRegistry.register(new RepairShadowedHookCommandsMigration());
export { RepairShadowedHookCommandsMigration };
