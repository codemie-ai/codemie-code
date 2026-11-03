import * as fs from 'fs/promises';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';

// `codemie proxy connect --claude-code-otlp` wrote a bare `codemie hook ...` into ~/.claude/settings.json.
// Under Git Bash a bare `codemie` fails with `command not found` when only `codemie.cmd` exists (Connect
// installs). Nothing rewrote it, so already-connected users stay broken. EPMCDME-15907.
class LocalizeOtlpHookCommandsMigration implements Migration {
  id = '010-localize-otlp-hook-commands';
  description = 'Rewrite installed claude-code-otlp hook commands to the absolute codemie path';

  async up(): Promise<MigrationResult> {
    // Loaded lazily: the connector is only needed by this one-time migration, not at every CLI startup.
    const [{ getClaudeSettingsPath }, connector, { writeAtomically }] = await Promise.all([
      import('../agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js'),
      import('../cli/commands/proxy/connectors/claude-code-otlp.js'),
      import('../cli/commands/proxy/connectors/vscode.js'),
    ]);
    const file = getClaudeSettingsPath();

    let settings: { hooks?: Record<string, unknown> };
    try {
      settings = JSON.parse(await fs.readFile(file, 'utf-8')) as typeof settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`[${this.id}] Skipped ${file}: ${(error as Error)?.message ?? error}`);
      }
      return { success: true, migrated: false, reason: 'no-settings' };
    }

    if (!settings?.hooks || !(await connector.localizeCodemieHookCommands(settings.hooks))) {
      return { success: true, migrated: false, reason: 'nothing-to-rewrite' };
    }

    try {
      await writeAtomically(file, JSON.stringify(settings, null, 2) + '\n');
    } catch (error) {
      // success:false keeps the migration pending so a transient write error is retried.
      logger.warn(`[${this.id}] Failed to write ${file}: ${(error as Error)?.message ?? error}`);
      return { success: false, migrated: false, reason: 'write-failed' };
    }
    logger.info(`[${this.id}] Localized codemie hook commands in ${file}`);
    return { success: true, migrated: true };
  }
}

MigrationRegistry.register(new LocalizeOtlpHookCommandsMigration());
export { LocalizeOtlpHookCommandsMigration };
