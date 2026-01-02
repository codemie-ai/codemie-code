/**
 * Test Isolation Helper
 *
 * Provides isolated CodeMie home directory for each test file.
 * This enables parallel test execution without state conflicts.
 *
 * Usage:
 *   import { setupTestIsolation } from '../helpers/test-isolation.js';
 *
 *   describe('My Test Suite', () => {
 *     setupTestIsolation();
 *
 *     it('test 1', () => {
 *       // Tests run with isolated CODEMIE_HOME
 *     });
 *   });
 */

import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, afterAll } from 'vitest';

/**
 * Setup isolated CODEMIE_HOME for test suite
 *
 * Creates unique temporary directory per test file.
 * Automatically cleans up after tests complete.
 *
 * @param options Configuration options
 * @returns Test home directory path
 */
export function setupTestIsolation(options: {
  /**
   * Preserve temp directory after tests (for debugging)
   * Default: false
   */
  preserveTempDir?: boolean;
} = {}): string {
  let testHome: string;
  const originalHome = process.env.CODEMIE_HOME;

  beforeAll(() => {
    // Create unique temp directory for this test file
    const prefix = 'codemie-test-';
    testHome = mkdirSync(join(tmpdir(), prefix), { recursive: true }) ||
               join(tmpdir(), prefix + Math.random().toString(36).slice(2, 9));

    // Ensure directory exists
    mkdirSync(testHome, { recursive: true });

    // Set CODEMIE_HOME for this test
    process.env.CODEMIE_HOME = testHome;
  });

  afterAll(() => {
    // Restore original CODEMIE_HOME
    if (originalHome) {
      process.env.CODEMIE_HOME = originalHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }

    // Cleanup temp directory unless preserving
    if (!options.preserveTempDir && testHome) {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors (may be locked on Windows)
        console.warn(`Failed to cleanup test home: ${testHome}`);
      }
    }
  });

  return testHome;
}

/**
 * Get current test home directory
 * Only available after setupTestIsolation() has been called
 */
export function getTestHome(): string {
  const testHome = process.env.CODEMIE_HOME;
  if (!testHome || !testHome.includes('codemie-test-')) {
    throw new Error('Test isolation not setup. Call setupTestIsolation() in beforeAll()');
  }
  return testHome;
}
