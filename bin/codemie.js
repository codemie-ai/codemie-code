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

// Continue with normal CLI initialization
import('../dist/cli/index.js').catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
