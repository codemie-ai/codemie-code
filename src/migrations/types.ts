/**
 * Migration system types
 * Database-style migration framework for CodeMie CLI
 */

/**
 * Migration interface
 * Each migration implements this interface
 */
export interface Migration {
  /** Unique ID (e.g., '001-config-rename', '002-add-analytics') */
  id: string;

  /** Human-readable description */
  description: string;

  /** Minimum CLI version required (e.g., '0.1.0') */
  minVersion?: string;

  /** Version when migration becomes obsolete (e.g., '1.0.0') */
  deprecatedIn?: string;

  /** Execute the migration */
  up(): Promise<MigrationResult>;
}

/**
 * Migration execution result
 */
export interface MigrationResult {
  /** Whether migration executed successfully */
  success: boolean;

  /** Whether migration actually performed changes (false if already done or skipped) */
  migrated: boolean;

  /** Reason for skip or failure */
  reason?: string;

  /** Additional details */
  details?: any;
}

/**
 * Migration history record
 */
export interface MigrationRecord {
  /** Migration ID */
  id: string;

  /** ISO timestamp when applied */
  appliedAt: string;

  /** Whether migration succeeded */
  success: boolean;
}

/**
 * Migration history file format
 */
export interface MigrationHistory {
  /** History file version */
  version: 1;

  /** List of applied migrations */
  migrations: MigrationRecord[];
}
