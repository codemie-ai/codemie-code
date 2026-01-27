/**
 * Migration system public API
 *
 * This module provides a database-style migration framework for CodeMie CLI.
 * Migrations are tracked in ~/.codemie/migrations.json and run automatically at CLI startup.
 *
 * To add a new migration:
 * 1. Create a new file: src/migrations/XXX-description.migration.ts
 * 2. Implement the Migration interface
 * 3. Import it below
 *
 * Example:
 * ```typescript
 * import './002-add-analytics.migration.js';
 * ```
 */

// Export public API
export { MigrationRunner } from './runner.js';
export { MigrationRegistry } from './registry.js';
export { MigrationTracker } from './tracker.js';
export type { Migration, MigrationResult, MigrationRecord, MigrationHistory } from './types.js';

// Import all migrations (auto-registers them)
import './001-config-rename.migration.js';
import './002-consolidate-sessions.migration.js';

// Future migrations will be imported here:
// import './003-add-analytics.migration.js';
// import './004-restructure-profiles.migration.js';
