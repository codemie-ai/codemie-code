/**
 * Analytics configuration utilities
 * Handles loading and merging analytics config from multiple sources
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import type { AnalyticsConfig } from './types.js';
import { DEFAULT_ANALYTICS_CONFIG } from './types.js';

/**
 * Load analytics configuration with environment variable overrides
 * Priority: Environment variables > Global config > baseConfig > Defaults
 */
export function loadAnalyticsConfig(
  baseConfig?: Partial<AnalyticsConfig>
): AnalyticsConfig {
  // Start with defaults
  const config: AnalyticsConfig = {
    ...DEFAULT_ANALYTICS_CONFIG,
  };

  // Try to load from global config synchronously
  try {
    const configPath = join(homedir(), '.codemie', 'config.json');
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Merge global config if available (multi-provider format)
    if (parsed.version === 2 && parsed.analytics) {
      Object.assign(config, parsed.analytics);
    }
  } catch {
    // No global config, continue with defaults
  }

  // Merge base config
  if (baseConfig) {
    Object.assign(config, baseConfig);
  }

  // Environment variable overrides
  if (process.env.CODEMIE_ANALYTICS_ENABLED !== undefined) {
    config.enabled =
      process.env.CODEMIE_ANALYTICS_ENABLED === 'true' ||
      process.env.CODEMIE_ANALYTICS_ENABLED === '1';
  }

  if (process.env.CODEMIE_ANALYTICS_TARGET) {
    const target = process.env.CODEMIE_ANALYTICS_TARGET;
    if (target === 'local' || target === 'remote' || target === 'both') {
      config.target = target;
    }
  }

  if (process.env.CODEMIE_ANALYTICS_ENDPOINT) {
    config.remoteEndpoint = process.env.CODEMIE_ANALYTICS_ENDPOINT;
  }

  if (process.env.CODEMIE_ANALYTICS_PATH) {
    config.localPath = process.env.CODEMIE_ANALYTICS_PATH;
  }

  // Expand ~ in local path
  if (config.localPath.startsWith('~')) {
    config.localPath = config.localPath.replace(/^~/, homedir());
  }

  return config;
}

/**
 * Get default analytics path
 */
export function getDefaultAnalyticsPath(): string {
  return join(homedir(), '.codemie', 'analytics');
}
