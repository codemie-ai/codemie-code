#!/usr/bin/env node

/**
 * CodeMie CLI Wrapper
 * Entry point for the codemie executable
 */

import { MigrationRunner } from '../dist/migrations/index.js';

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

// Continue with normal CLI initialization
import('../dist/cli/index.js').catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
