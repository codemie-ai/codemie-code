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

describe('Workflow Run command', () => {
  setupTestIsolation();

  it('should display help text for the workflow run command', () => {
    const result = cli.runSilent('workflow run --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Execute a custom or shared workflow');
    expect(result.output).toContain('--workflow');
    expect(result.output).toContain('--input');
    expect(result.output).toContain('--file');
    expect(result.output).toContain('--no-wait');
    expect(result.output).toContain('--json');
  });

  it('should reject the removed sdk workflows run command', () => {
    const result = cli.runSilent('sdk workflows run --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/\brun\b/);
  });

  it('should fail when invoking the removed sdk workflows run command', () => {
    const result = cli.runSilent('sdk workflows run');
    expect(result.exitCode).not.toBe(0);
  });

  it('should keep sdk workflow CRUD commands in help', () => {
    const result = cli.runSilent('sdk workflows --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('list');
    expect(result.output).toContain('get');
    expect(result.output).toContain('create');
    expect(result.output).toContain('update');
    expect(result.output).toContain('delete');
    expect(result.output).not.toMatch(/\brun\b/);
  });

  it('should error when workflow run is called without a workflow ID or name', () => {
    const result = cli.runSilent('workflow run');
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Error: Workflow ID or name is required');
  });
});
