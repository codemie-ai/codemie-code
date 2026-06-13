// src/agents/plugins/kimi/kimi.hook-config-injector.ts
/**
 * Idempotent injector for CodeMie lifecycle hooks into Kimi's global config.
 *
 * Kimi Code supports lifecycle hooks in `~/.kimi-code/config.toml` under
 * `[[hooks]]` entries. This component registers the hooks CodeMie needs to
 * observe and react to Kimi sessions while leaving user-managed configuration
 * intact.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError, getErrorMessage } from '../../../utils/errors.js';
import { getKimiConfigPath } from './kimi.paths.js';

/**
 * Result shape for hook injection.
 */
export interface HookInjectionResult {
  success: boolean;
  created: boolean;
  configPath: string;
  error?: string;
}

/**
 * Events CodeMie subscribes to in Kimi Code, mapped to their hook timeouts.
 */
const MANAGED_EVENTS: Array<{ event: string; timeout: number }> = [
  { event: 'SessionStart', timeout: 5 },
  { event: 'SessionEnd', timeout: 10 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'Stop', timeout: 5 },
  { event: 'SubagentStop', timeout: 5 },
  { event: 'PreCompact', timeout: 5 },
];

const MANAGED_MARKER = '# CodeMie-managed hooks - do not edit manually';
const COMMAND = 'codemie hook';

interface KimiHooksConfig {
  hooks?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Injects and restores CodeMie lifecycle hooks in Kimi's config.toml.
 */
export class KimiHookConfigInjector {
  /**
   * Idempotently inject CodeMie hooks into `~/.kimi-code/config.toml`.
   */
  async inject(): Promise<HookInjectionResult> {
    const configPath = getKimiConfigPath();

    try {
      const toml = await this.loadTomlModule();
      const configExists = existsSync(configPath);
      let created = false;

      if (!configExists) {
        created = true;
      } else {
        const existingContent = readFileSync(configPath, 'utf-8');
        if (existingContent.includes(MANAGED_MARKER)) {
          logger.info('Kimi config already contains CodeMie-managed hooks; skipping injection.', {
            configPath,
          });
          return { success: true, created: false, configPath };
        }

        this.backupConfig(configPath);
      }

      const parsedConfig: KimiHooksConfig = configExists
        ? (toml.parse(readFileSync(configPath, 'utf-8')) as KimiHooksConfig)
        : {};

      if (!Array.isArray(parsedConfig.hooks)) {
        parsedConfig.hooks = [];
      }

      for (const { event, timeout } of MANAGED_EVENTS) {
        parsedConfig.hooks!.push({
          event,
          command: COMMAND,
          timeout,
        });
      }

      // @iarna/toml does not export its internal JsonMap type, so we assert the
      // parsed object which is known to contain only TOML-compatible values.
      const serialized = toml.stringify(parsedConfig as unknown as Record<string, never>);
      const contentWithMarker = `${MANAGED_MARKER}\n${serialized}`;

      writeFileSync(configPath, contentWithMarker, 'utf-8');

      if (created) {
        logger.info('Created Kimi config with CodeMie-managed hooks.', { configPath });
      } else {
        logger.info('Injected CodeMie-managed hooks into existing Kimi config.', { configPath });
      }

      return { success: true, created, configPath };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('Failed to inject CodeMie hooks into Kimi config.', error);
      return { success: false, created: false, configPath, error: message };
    }
  }

  /**
   * Restore the original config from its CodeMie backup, if one exists.
   */
  async restore(): Promise<void> {
    const configPath = getKimiConfigPath();
    const backupPath = `${configPath}.codemie-backup`;

    if (!existsSync(backupPath)) {
      logger.info('No Kimi config backup found; nothing to restore.', { configPath });
      return;
    }

    copyFileSync(backupPath, configPath);
    logger.info('Restored Kimi config from CodeMie backup.', { configPath, backupPath });
  }

  private async loadTomlModule(): Promise<typeof import('@iarna/toml')> {
    try {
      return await import('@iarna/toml');
    } catch (error) {
      throw new ConfigurationError(
        `Unable to load @iarna/toml. Run "npm install @iarna/toml" to enable Kimi hook injection. ${getErrorMessage(error)}`
      );
    }
  }

  private backupConfig(configPath: string): void {
    const backupPath = `${configPath}.codemie-backup`;
    copyFileSync(configPath, backupPath);
  }
}
