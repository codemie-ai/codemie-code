import * as fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { resolveCodemieBinary, rewriteHooksCommandTree } from '../utils/hook-command.js';
import { getCodemiePath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

// Repairs already-installed Claude/Gemini hooks whose bare `codemie` command fails
// with `command not found`, for users whose plugin version did not bump. See EPMCDME-14035.
class RewriteHookCommandPathsMigration implements Migration {
  id = '006-resolve-hook-command-paths';
  description = 'Rewrite installed Claude/Gemini hook commands to the absolute codemie path';
  minVersion = '0.1.0';

  private hookFiles(): string[] {
    return [
      getCodemiePath('claude-plugin', 'hooks', 'hooks.json'),
      path.join(homedir(), '.gemini', 'extensions', 'codemie', 'hooks', 'hooks.json'),
    ];
  }

  async up(): Promise<MigrationResult> {
    logger.info('[006-resolve-hook-command-paths] Starting installed-hook path rewrite');

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
          logger.warn(`[006-resolve-hook-command-paths] Skipped ${file}: ${(error as Error)?.message ?? error}`);
        }
        continue;
      }

      binary ??= await resolveCodemieBinary();
      if (rewriteHooksCommandTree(parsed.hooks, binary)) {
        try {
          await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf-8');
          logger.info(`[006-resolve-hook-command-paths] Rewrote ${file}`);
          migrated = true;
        } catch (error) {
          // success:false keeps the migration pending so a transient write error
          // (EACCES/EPERM/disk full) is retried, not recorded as applied forever.
          anyWriteFailed = true;
          logger.warn(
            `[006-resolve-hook-command-paths] Failed to write ${file}: ${(error as Error)?.message ?? error}`,
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

MigrationRegistry.register(new RewriteHookCommandPathsMigration());
export { RewriteHookCommandPathsMigration };
