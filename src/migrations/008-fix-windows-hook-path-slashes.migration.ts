import * as fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { fixCommandTreeSlashes } from '../utils/hook-command.js';
import { getCodemiePath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

// Repairs already-installed Claude/Gemini hooks that contain Windows backslash paths
// written by migration 006 before EPMCDME-14762 was fixed. Bash (Git Bash / WSL) consumes
// \X sequences as escape codes, so `C:\Users\...\codemie.cmd` becomes `C:Users...codemie.cmd`
// and the hook fails with `command not found`. Forward slashes work everywhere. See EPMCDME-14762.
class FixWindowsHookPathSlashesMigration implements Migration {
  id = '008-fix-windows-hook-path-slashes';
  description = 'Convert backslash paths in installed Claude/Gemini hooks.json to forward slashes';

  private hookFiles(): string[] {
    return [
      getCodemiePath('claude-plugin', 'hooks', 'hooks.json'),
      path.join(homedir(), '.gemini', 'extensions', 'codemie', 'hooks', 'hooks.json'),
    ];
  }

  async up(): Promise<MigrationResult> {
    logger.info('[008-fix-windows-hook-path-slashes] Starting backslash-path fix in installed hooks');

    let migrated = false;
    let anyWriteFailed = false;

    for (const file of this.hookFiles()) {
      let parsed: { hooks?: unknown };
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { hooks?: unknown };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          logger.warn(`[008-fix-windows-hook-path-slashes] Skipped ${file}: ${(error as Error)?.message ?? error}`);
        }
        continue;
      }

      if (fixCommandTreeSlashes(parsed.hooks)) {
        try {
          await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf-8');
          logger.info(`[008-fix-windows-hook-path-slashes] Fixed ${file}`);
          migrated = true;
        } catch (error) {
          // success:false keeps the migration pending so a transient write error
          // (EACCES/EPERM/disk full) is retried, not recorded as applied forever.
          anyWriteFailed = true;
          logger.warn(
            `[008-fix-windows-hook-path-slashes] Failed to write ${file}: ${(error as Error)?.message ?? error}`,
          );
        }
      }
    }

    if (anyWriteFailed) {
      return { success: false, migrated, reason: 'write-failed' };
    }
    return { success: true, migrated, reason: migrated ? undefined : 'nothing-to-fix' };
  }
}

MigrationRegistry.register(new FixWindowsHookPathSlashesMigration());
export { FixWindowsHookPathSlashesMigration };
