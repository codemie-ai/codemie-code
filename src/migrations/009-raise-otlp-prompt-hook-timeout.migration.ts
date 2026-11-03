import * as fs from 'fs/promises';
import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { logger } from '../utils/logger.js';

interface PromptHook {
  command?: unknown;
  timeout?: unknown;
  statusMessage?: unknown;
}

// `codemie proxy connect` wrote the claude-code-otlp UserPromptSubmit hook with a 30s timeout before
// EPMCDME-16568; nothing rewrites it on upgrade, so the SSO sign-in wait would be capped at 15s.
// Only codemie's own entry is raised, and only when its timeout is below the current one.
class RaiseOtlpPromptHookTimeoutMigration implements Migration {
  id = '009-raise-otlp-prompt-hook-timeout';
  description = 'Raise the installed claude-code-otlp UserPromptSubmit hook timeout for the SSO sign-in wait';

  async up(): Promise<MigrationResult> {
    // Loaded lazily: the connector is only needed by this one-time migration, not at every CLI startup.
    const [{ getClaudeSettingsPath }, connector, { writeAtomically }] = await Promise.all([
      import('../agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js'),
      import('../cli/commands/proxy/connectors/claude-code-otlp.js'),
      import('../cli/commands/proxy/connectors/vscode.js'),
    ]);
    const file = getClaudeSettingsPath();

    let settings: { hooks?: { UserPromptSubmit?: unknown } };
    try {
      settings = JSON.parse(await fs.readFile(file, 'utf-8')) as typeof settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`[${this.id}] Skipped ${file}: ${(error as Error)?.message ?? error}`);
      }
      return { success: true, migrated: false, reason: 'no-settings' };
    }

    const groups = settings?.hooks?.UserPromptSubmit;
    let changed = false;
    for (const group of Array.isArray(groups) ? groups : []) {
      const hooks: PromptHook[] = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of hooks) {
        if (
          typeof hook?.command === 'string' &&
          hook.command.includes(connector.CODEMIE_COMMAND_MARKER) &&
          typeof hook.timeout === 'number' &&
          hook.timeout < connector.CODEMIE_USER_PROMPT_HOOK_TIMEOUT_SECONDS
        ) {
          hook.timeout = connector.CODEMIE_USER_PROMPT_HOOK_TIMEOUT_SECONDS;
          hook.statusMessage ??= connector.CODEMIE_USER_PROMPT_HOOK_STATUS_MESSAGE;
          changed = true;
        }
      }
    }
    if (!changed) {
      return { success: true, migrated: false, reason: 'nothing-to-raise' };
    }

    try {
      await writeAtomically(file, JSON.stringify(settings, null, 2) + '\n');
    } catch (error) {
      // success:false keeps the migration pending so a transient write error is retried.
      logger.warn(`[${this.id}] Failed to write ${file}: ${(error as Error)?.message ?? error}`);
      return { success: false, migrated: false, reason: 'write-failed' };
    }
    logger.info(`[${this.id}] Raised the codemie UserPromptSubmit hook timeout in ${file}`);
    return { success: true, migrated: true };
  }
}

MigrationRegistry.register(new RaiseOtlpPromptHookTimeoutMigration());
export { RaiseOtlpPromptHookTimeoutMigration };
