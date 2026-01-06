import * as fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import { getCodemieHome, getCodemiePath } from '../utils/paths.js';

export interface EnvConfig {
  [key: string]: string;
}

export class EnvManager {
  private static CONFIG_DIR = getCodemieHome();
  private static CONFIG_FILE = getCodemiePath('codemie-cli.config.json');

  static async loadGlobalConfig(): Promise<EnvConfig> {
    try {
      const content = await fs.readFile(EnvManager.CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  static async saveGlobalConfig(config: EnvConfig): Promise<void> {
    try {
      await fs.mkdir(EnvManager.CONFIG_DIR, { recursive: true });
      await fs.writeFile(
        EnvManager.CONFIG_FILE,
        JSON.stringify(config, null, 2),
        'utf-8'
      );
      logger.success(`Configuration saved to ${EnvManager.CONFIG_FILE}`);
    } catch (error: unknown) {
      logger.error('Failed to save configuration:', error);
      throw error;
    }
  }

  static async getConfigValue(key: string): Promise<string | undefined> {
    // Priority: process.env > global config
    if (process.env[key]) {
      return process.env[key];
    }

    const config = await EnvManager.loadGlobalConfig();
    return config[key];
  }

  static async setConfigValue(key: string, value: string): Promise<void> {
    const config = await EnvManager.loadGlobalConfig();
    config[key] = value;
    await EnvManager.saveGlobalConfig(config);
  }

  static async deleteConfigValue(key: string): Promise<void> {
    const config = await EnvManager.loadGlobalConfig();
    delete config[key];
    await EnvManager.saveGlobalConfig(config);
  }

  static async showConfig(): Promise<void> {
    const config = await EnvManager.loadGlobalConfig();

    if (Object.keys(config).length === 0) {
      logger.info('No configuration found');
      return;
    }

    logger.info('Global configuration:');
    for (const [key, value] of Object.entries(config)) {
      // Mask sensitive values
      const displayValue = key.includes('TOKEN') || key.includes('KEY')
        ? value.substring(0, 4) + '***'
        : value;
      console.log(`  ${key}: ${displayValue}`);
    }
  }
}
