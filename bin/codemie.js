#!/usr/bin/env node

/**
 * CodeMie CLI Wrapper
 * Entry point for the codemie executable
 */

import { MigrationRunner } from '../dist/migrations/index.js';
import { checkAndPromptForUpdate } from '../dist/utils/cli-updater.js';

// Auto-run pending migrations (happens at startup)
// Migrations are tracked in ~/.codemie/migrations.json and only run once
try {
  if (await MigrationRunner.hasPending()) {
    await MigrationRunner.runPending({
      silent: false  // Show migration messages to user
    });
  }
} catch (error) {
  // Don't block CLI if migration fails
  console.error('Warning: Migration failed:', error.message);
}

// Check for CLI updates (silent by default, configurable via CODEMIE_AUTO_UPDATE)
// Skip in test environments to avoid timeouts and network calls during testing
// Non-blocking: failures don't prevent CLI from running
const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
if (!isTestEnvironment) {
  try {
    await checkAndPromptForUpdate();
  } catch (error) {
    // Silently fail - don't block CLI startup
  }
}

// Once-per-upgrade "What's new" notice from CHANGELOG.md (shares the
// CODEMIE_TIPS off switch with feature tips). Non-blocking, minimal stdout.
// Skipped for scripted/piped use (stdout not a TTY) and for invocations that
// produce their own output contract (--version/-V/--task/--help).
const skipNoticeArgs = new Set(['--version', '-V', '--task', '--help']);
const hasOutputContractArg = process.argv.slice(2).some(arg => skipNoticeArgs.has(arg));
const isInteractiveTerminal = process.stdout.isTTY !== false; // undefined -> treat as TTY
if (!isTestEnvironment && isInteractiveTerminal && !hasOutputContractArg) {
  try {
    const { readFileSync } = await import('node:fs');
    const { default: chalk } = await import('chalk');
    const {
      isWhatsNewEnabled,
      getLastSeenVersion,
      getReleaseNotes,
      renderReleaseNotes,
      markVersionSeen
    } = await import('../dist/utils/whatsnew.js');

    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    const currentVersion = packageJson.version;

    if (currentVersion && isWhatsNewEnabled()) {
      const lastSeenVersion = getLastSeenVersion();
      if (lastSeenVersion === null) {
        // Fresh install (no marker) — record silently, no "Updated to" banner
        markVersionSeen(currentVersion);
      } else if (lastSeenVersion !== currentVersion) {
        const entries = getReleaseNotes(currentVersion);
        if (entries.length > 0) {
          console.log(chalk.dim(`✨ Updated to ${currentVersion} — here's what changed:`));
          renderReleaseNotes(entries, { maxItems: 6 });
        }
        // Mark seen even when this version has no changelog entry — don't nag again
        markVersionSeen(currentVersion);
      }
    }
  } catch (error) {
    // Silently fail - don't block CLI startup
  }
}

// Continue with normal CLI initialization
import('../dist/cli/index.js').catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
