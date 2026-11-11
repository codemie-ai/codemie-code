#!/usr/bin/env node

/**
 * CodeMie CLI Wrapper
 * Entry point for the codemie executable
 */

import { logger } from '../dist/utils/logger.js';
import { isScheduledSyncRun } from '../dist/utils/scheduled-run.js';
import { isMachineOutputInvocation } from '../dist/utils/machine-output.js';

// Tolerate EPIPE when stdout/stderr is piped into a consumer that closes early
// (e.g. `codemie | head -1`). Without a handler, Node throws on the next write
// after the pipe closes, crashing the CLI mid-output.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', err => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

// A process an agent runs as a hook: its stdout is the agent's protocol channel
// (Claude Code adds a hook's stdout to the model's context), so start-up output
// stays off it, and no update check or prompt runs inside the agent's hook.
// The agent also reads a hook's stderr on a blocking exit as the block reason,
// so the logger never writes to the console there: the log file only.
const isHookProcess = process.argv[2] === 'hook' || process.argv[2] === 'sound';
if (isHookProcess) {
  logger.setConsoleStream(null);
}

// The daily OS scheduler job for `analytics sync run` invokes this script
// unattended (no TTY, no user to prompt or notify). Detect that invocation
// so migrations run silently and the update check / what's-new notice are
// skipped. A manual `codemie analytics sync run` (no --scheduled) keeps
// today's normal interactive startup.
const isScheduledRun = isScheduledSyncRun(process.argv);

// A `--json` invocation: its stdout is the command's answer and a script parses it, so
// start-up chatter (migration progress, update prompts, what's-new) stays off it. Unlike a
// hook, the console stream is left alone: the command itself still prints to stdout.
const isMachineOutput = isMachineOutputInvocation(process.argv.slice(2));

// Imported after the console switch: their module graph logs at import time.
const { MigrationRunner } = await import('../dist/migrations/index.js');
const { checkAndPromptForUpdate } = await import('../dist/utils/cli-updater.js');

// Auto-run pending migrations (happens at startup)
// Migrations are tracked in ~/.codemie/migrations.json and only run once
try {
  if (await MigrationRunner.hasPending()) {
    const migrationResult = await MigrationRunner.runPending({
      // Show migration messages to user, except in a hook, an unattended run or for --json output
      silent: isHookProcess || isScheduledRun || isMachineOutput
    });
    // A silent run prints no failure line, and the logger writes errors to the console only in
    // debug mode, so a --json caller would never learn that a migration failed (it retries on
    // every start-up). One line on stderr keeps stdout pure JSON. A hook's console is nulled.
    if (isMachineOutput && !isHookProcess && migrationResult.failed > 0) {
      console.error(`Warning: ${migrationResult.failed} migration(s) failed; see the log file for details`);
    }
  }
} catch (error) {
  // Don't block CLI if migration fails
  if (isHookProcess) {
    logger.warn('Warning: Migration failed:', error.message);
  } else {
    console.error('Warning: Migration failed:', error.message);
  }
}

// Check for CLI updates (silent by default, configurable via CODEMIE_AUTO_UPDATE)
// Skip in test environments to avoid timeouts and network calls during testing
// Skip for the unattended scheduled analytics sync job (no user to notify)
// Non-blocking: failures don't prevent CLI from running
const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
if (!isTestEnvironment && !isHookProcess && !isScheduledRun && !isMachineOutput) {
  try {
    await checkAndPromptForUpdate();
  } catch (error) {
    // Silently fail - don't block CLI startup
  }
}

// Once-per-upgrade "What's new" notice from CHANGELOG.md (shares the
// CODEMIE_TIPS off switch with feature tips). Non-blocking, minimal stdout.
// shouldRunUpgradeNotice skips non-TTY stdout, `hook` invocations, and
// invocations with their own output contract (--version/-V/--task/--help);
// a hook process (`hook`, `sound`) or a `--json` invocation never reaches it. A
// skipped notice writes no marker, so it shows on the next run in a terminal.
// Also skipped for the unattended scheduled analytics sync job.
if (!isTestEnvironment && !isHookProcess && !isScheduledRun && !isMachineOutput) {
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
