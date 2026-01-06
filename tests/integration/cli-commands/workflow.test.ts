/**
 * CLI Workflow Command Integration Test
 *
 * Tests the 'codemie workflow' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Workflow Commands', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let workflowResult: CommandResult;

  beforeAll(() => {
    workflowResult = cli.runSilent('workflow list');
  });

  it('should list available workflows', () => {
    // Should show available workflow templates
    expect(workflowResult.output).toMatch(/pr-review|inline-fix|code-ci/i);
  });

  it('should show workflow details', () => {
    // Should include workflow descriptions or names
    expect(workflowResult.output.length).toBeGreaterThan(0);
  });

  it('should complete successfully', () => {
    expect(workflowResult.exitCode).toBe(0);
  });
});
