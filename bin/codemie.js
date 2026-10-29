#!/usr/bin/env node

/**
 * CodeMie CLI Wrapper
 * Entry point for the codemie executable
 */

import { MigrationRunner } from '../dist/migrations/index.js';
import { checkAndPromptForUpdate } from '../dist/utils/cli-updater.js';

// Tolerate EPIPE when stdout/stderr is piped into a consumer that closes early
// (e.g. `codemie | head -1`). Without a handler, Node throws on the next write
// after the pipe closes, crashing the CLI mid-output.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', err => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

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
// shouldRunUpgradeNotice skips non-TTY stdout, `hook` invocations, and
// invocations with their own output contract (--version/-V/--task/--help).
if (!isTestEnvironment) {
  try {
    const { readFileSync } = await import('node:fs');
    const { shouldRunUpgradeNotice, showUpgradeNotice } = await import('../dist/utils/whatsnew.js');

    if (shouldRunUpgradeNotice(process.argv.slice(2), process.stdout.isTTY)) {
      const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      const currentVersion = packageJson.version;
      if (currentVersion) {
        showUpgradeNotice(currentVersion);
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
