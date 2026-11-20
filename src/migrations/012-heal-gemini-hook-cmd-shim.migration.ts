import * as fs from 'fs/promises';
import type { MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { RewriteHookCommandPathsMigration } from './006-resolve-hook-command-paths.migration.js';

// On Windows an installed Gemini hook that runs npm's extensionless sh shim opens a console window per
// event; the `.cmd` shim beside it does not. Heals the installed hooks.json for every provider, not only
// the ones whose launch re-localizes hooks. See EPMCDME-16975.
class HealGeminiHookCmdShimMigration extends RewriteHookCommandPathsMigration {
  id = '012-heal-gemini-hook-cmd-shim';
  description = 'Rewrite installed Gemini hook commands to the codemie .cmd shim on Windows';

  protected hookFiles(): Array<{ file: string; claude: boolean }> {
    return super.hookFiles().filter(({ claude }) => !claude);
  }

  // Gemini may read hooks.json at any time: write beside it, then rename over it so it never sees a torn file.
  protected async writeHooks(file: string, content: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, content, 'utf-8');
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async up(): Promise<MigrationResult> {
    if (process.platform !== 'win32') {
      return { success: true, migrated: false, reason: 'not-windows' };
    }
    return super.up();
  }
}

MigrationRegistry.register(new HealGeminiHookCmdShimMigration());
export { HealGeminiHookCmdShimMigration };
