/**
 * CLI List Command Integration Test
 *
 * Tests the 'codemie list' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('List Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let listOutput: string;
  let listResult: CommandResult;

  beforeAll(() => {
    // Execute once, validate many times
    listResult = cli.runSilent('list');
    listOutput = listResult.output;
  }, 60000); // 60s timeout for Windows (loads all agent plugins)

  it('should list all available agents', () => {
    // Should show all registered agents (claude, gemini, codemie-code)
    expect(listOutput).toContain('claude');
    expect(listOutput).toContain('gemini');
    expect(listOutput).toContain('codemie-code');
  });

  it('should complete successfully', () => {
    expect(listResult.exitCode).toBe(0);
  });
});
