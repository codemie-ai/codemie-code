/**
 * CLI Version Command Integration Test
 *
 * Tests the 'codemie version' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Version Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let versionResult: CommandResult;

  beforeAll(() => {
    versionResult = cli.runSilent('version');
  });

  it('should display version number', () => {
    // Should show semantic version format
    expect(versionResult.output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('should complete successfully', () => {
    expect(versionResult.exitCode).toBe(0);
  });
});
