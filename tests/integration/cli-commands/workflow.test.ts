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

describe('Workflow Run and Workflows Run commands', () => {
  setupTestIsolation();

  it('should display help text for the workflow run command', () => {
    const result = cli.runSilent('workflow run --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Execute a custom or shared workflow');
    expect(result.output).toContain('--workflow');
    expect(result.output).toContain('--input');
    expect(result.output).toContain('--file');
    expect(result.output).toContain('--no-wait');
  });

  it('should display help text for sdk workflows run command', () => {
    const result = cli.runSilent('sdk workflows run --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Execute a custom or shared workflow by ID or name');
    expect(result.output).toContain('--input');
    expect(result.output).toContain('--file');
    expect(result.output).toContain('--no-wait');
  });

  it('should error when workflow run is called without a workflow ID or name', () => {
    const result = cli.runSilent('workflow run');
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Error: Workflow ID or name is required');
  });
});
