import type { Migration } from './types.js';

/**
 * Central migration registry
 * Stores all registered migrations and provides access methods
 */
export class MigrationRegistry {
  private static migrations: Migration[] = [];

  /**
   * Register a migration
   * Migrations auto-register themselves when imported
   */
  static register(migration: Migration): void {
    this.migrations.push(migration);
  }

  /**
   * Get all migrations sorted by ID
   * Ensures migrations run in predictable order (001, 002, 003, etc.)
   */
  static getAll(): Migration[] {
    return [...this.migrations].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Get a specific migration by ID
   */
  static get(id: string): Migration | undefined {
    return this.migrations.find(m => m.id === id);
  }

  /**
   * Clear all registered migrations
   * Used primarily for testing
   */
  static clear(): void {
    this.migrations = [];
  }
}
