/**
 * CLI Error Handling Integration Test
 *
 * Tests the CLI error handling by executing invalid commands
 * and verifying proper error responses.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Error Handling', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let errorResult: CommandResult;

  beforeAll(() => {
    errorResult = cli.runSilent('invalid-command-xyz');
  });

  it('should handle invalid commands gracefully', () => {
    // Should fail with non-zero exit code
    expect(errorResult.exitCode).not.toBe(0);
  });

  it('should provide helpful error messages', () => {
    // Should include error information or help text
    expect(errorResult.error || errorResult.output).toBeDefined();
  });
});
