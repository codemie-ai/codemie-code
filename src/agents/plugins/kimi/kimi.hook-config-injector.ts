// src/agents/plugins/kimi/kimi.hook-config-injector.ts
/**
 * Idempotent injector for CodeMie lifecycle hooks into Kimi's global config.
 *
 * Kimi Code supports lifecycle hooks in `~/.kimi-code/config.toml` under
 * `[[hooks]]` entries. This component registers the hooks CodeMie needs to
 * observe and react to Kimi sessions while leaving user-managed configuration
 * intact.
 */

import { access, copyFile, readFile, writeFile } from 'fs/promises';
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
  // SessionEnd must flush pending metrics to the CodeMie API. On a busy
  // local/remote server this can take 10-15s, so keep the hook alive long
  // enough for the sync to complete and session files to be renamed.
  { event: 'SessionEnd', timeout: 60 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'Stop', timeout: 5 },
  { event: 'SubagentStop', timeout: 5 },
  { event: 'PreCompact', timeout: 5 },
];

export const MANAGED_MARKER = '# CodeMie-managed hooks - do not edit manually';
const COMMAND = 'codemie hook';

type TomlMap = { [key: string]: TomlValue };
type TomlArray = string[] | number[] | boolean[] | Date[] | TomlMap[];
type TomlValue = string | number | boolean | Date | TomlArray | TomlArray[] | TomlMap;

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
      const configExists = await access(configPath).then(() => true).catch(() => false);
      let created = false;
      let existingContent: string | undefined;

      if (!configExists) {
        created = true;
      } else {
        existingContent = await readFile(configPath, 'utf-8');
      }

      const parsedConfig: KimiHooksConfig =
        existingContent !== undefined
          ? (toml.parse(existingContent) as KimiHooksConfig)
          : {};

      if (!Array.isArray(parsedConfig.hooks)) {
        parsedConfig.hooks = [];
      }

      // If CodeMie-managed hooks are already present, update their timeouts
      // when they differ instead of appending duplicates.
      const managedEventTimeouts = new Map(MANAGED_EVENTS.map(e => [e.event, e.timeout]));
      let updatedExisting = false;
      for (const hook of parsedConfig.hooks!) {
        if (
          typeof hook === 'object' &&
          hook !== null &&
          hook.command === COMMAND &&
          typeof hook.event === 'string' &&
          managedEventTimeouts.has(hook.event)
        ) {
          const expectedTimeout = managedEventTimeouts.get(hook.event)!;
          if (hook.timeout !== expectedTimeout) {
            hook.timeout = expectedTimeout;
            updatedExisting = true;
          }
        }
      }

      if (updatedExisting) {
        await this.backupConfig(configPath);
        const serialized = toml.stringify(parsedConfig as unknown as TomlMap);
        const contentWithMarker = `${MANAGED_MARKER}\n${serialized}`;
        await writeFile(configPath, contentWithMarker, 'utf-8');
        logger.info('Updated CodeMie-managed hook timeouts in Kimi config.', { configPath });
        return { success: true, created: false, configPath };
      }

      // Already injected and up to date
      if (existingContent?.includes(MANAGED_MARKER)) {
        logger.info('Kimi config already contains CodeMie-managed hooks; skipping injection.', {
          configPath,
        });
        return { success: true, created: false, configPath };
      }

      for (const { event, timeout } of MANAGED_EVENTS) {
        parsedConfig.hooks!.push({
          event,
          command: COMMAND,
          timeout,
        });
      }

      if (!created) {
        await this.backupConfig(configPath);
      }

      const serialized = toml.stringify(parsedConfig as unknown as TomlMap);
      const contentWithMarker = `${MANAGED_MARKER}\n${serialized}`;

      await writeFile(configPath, contentWithMarker, 'utf-8');

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
  async restore(): Promise<HookInjectionResult> {
    const configPath = getKimiConfigPath();
    const backupPath = `${configPath}.codemie-backup`;

    const backupExists = await access(backupPath).then(() => true).catch(() => false);
    if (!backupExists) {
      logger.info('No Kimi config backup found; nothing to restore.', { configPath });
      return { success: true, created: false, configPath };
    }

    try {
      await copyFile(backupPath, configPath);
      logger.info('Restored Kimi config from CodeMie backup.', { configPath, backupPath });
      return { success: true, created: false, configPath };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('Failed to restore Kimi config from CodeMie backup.', error);
      return { success: false, created: false, configPath, error: message };
    }
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

  private async backupConfig(configPath: string): Promise<void> {
    const backupPath = `${configPath}.codemie-backup`;
    const backupExists = await access(backupPath).then(() => true).catch(() => false);
    if (backupExists) {
      logger.debug('Kimi config backup already exists; skipping backup creation.', {
        configPath,
        backupPath,
      });
      return;
    }
    await copyFile(configPath, backupPath);
  }
}
