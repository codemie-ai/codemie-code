import {
  getClaudeAnalyticsPreferencesPath,
  readClaudeAnalyticsPreferences
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { logger } from '@/utils/logger.js';

export type ClaudeAnalyticsSwitch = 'on' | 'off' | 'corrupt';

/** The Claude analytics on/off switch (`claude-analytics.json`); an unreadable file is `corrupt`. */
export async function readClaudeAnalyticsSwitch(): Promise<ClaudeAnalyticsSwitch> {
  const prefs = await readClaudeAnalyticsPreferences();
  if (prefs.kind === 'corrupt') return 'corrupt';
  return prefs.value.enabled ? 'on' : 'off';
}

/** Collection runs only while the switch is on: off and corrupt both fail closed. */
export async function claudeAnalyticsCollecting(): Promise<boolean> {
  return (await readClaudeAnalyticsSwitch()) === 'on';
}

/** The daemon's per-poll read of the switch; a corrupt file is warned about once until it reads valid again. */
export class AnalyticsSwitch {
  private corruptWarned = false;

  async check(): Promise<boolean> {
    const state = await readClaudeAnalyticsSwitch();
    if (state === 'corrupt') {
      if (!this.corruptWarned) {
        this.corruptWarned = true;
        logger.warn('[desktop-telemetry] Analytics preferences file unreadable; not collecting', {
          path: getClaudeAnalyticsPreferencesPath()
        });
      }
      return false;
    }
    this.corruptWarned = false;
    return state === 'on';
  }
}
