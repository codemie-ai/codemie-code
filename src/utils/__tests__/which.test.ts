/**
 * Tests for cross-platform command detection utilities
 * Validates path trimming for Windows \r\n line endings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as exec from '../exec.js';

describe('getCommandPath', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should trim Windows-style line endings (\\r\\n)', async () => {
    // Mock where.exe output with \r\n line endings (Windows style)
    execSpy.mockResolvedValue({
      code: 0,
      stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('claude');

    // Should return path WITHOUT trailing \r
    expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  it('should handle multiple paths from where.exe', async () => {
    // where.exe can return multiple matches
    execSpy.mockResolvedValue({
      code: 0,
      stdout: 'C:\\Program Files\\nodejs\\node.exe\r\nC:\\Users\\test\\node.exe\r\n',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('node');

    // Should return first path, properly trimmed
    expect(result).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('should handle Unix-style line endings (\\n)', async () => {
    // Mock which output with \n line endings (Unix style)
    execSpy.mockResolvedValue({
      code: 0,
      stdout: '/usr/local/bin/node\n',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('node');

    // Should return path without trailing \n
    expect(result).toBe('/usr/local/bin/node');
    expect(result).not.toContain('\n');
  });

  it('should handle mixed line endings', async () => {
    // Edge case: mixed \r\n and \n
    execSpy.mockResolvedValue({
      code: 0,
      stdout: '/usr/bin/python3\r\n/usr/local/bin/python3\n',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('python3');

    // Should return first path, properly trimmed
    expect(result).toBe('/usr/bin/python3');
  });

  it('should handle old Mac line endings (\\r)', async () => {
    // Old Mac OS used \r (carriage return only)
    execSpy.mockResolvedValue({
      code: 0,
      stdout: '/usr/bin/node\r/usr/local/bin/node\r',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('node');

    // Should return first path, properly trimmed
    expect(result).toBe('/usr/bin/node');
  });

  it('should return null when command not found', async () => {
    execSpy.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'INFO: Could not find files for the given pattern(s).'
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('nonexistent');

    expect(result).toBeNull();
  });

  it('should return null on execution error', async () => {
    execSpy.mockRejectedValue(new Error('Command failed'));

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('test');

    expect(result).toBeNull();
  });

  it('should filter out empty lines', async () => {
    // Output with empty lines (shouldn't happen but handle gracefully)
    execSpy.mockResolvedValue({
      code: 0,
      stdout: '\r\n\r\nC:\\path\\to\\cmd.exe\r\n\r\n',
      stderr: ''
    });

    const { getCommandPath } = await import('../processes.js');
    const result = await getCommandPath('cmd');

    expect(result).toBe('C:\\path\\to\\cmd.exe');
  });
});

describe('commandExists', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return true when command exists', async () => {
    execSpy.mockResolvedValue({
      code: 0,
      stdout: 'C:\\Windows\\System32\\cmd.exe\r\n',
      stderr: ''
    });

    const { commandExists } = await import('../processes.js');
    const result = await commandExists('cmd');

    expect(result).toBe(true);
  });

  it('should return false when command not found', async () => {
    execSpy.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'INFO: Could not find files for the given pattern(s).'
    });

    const { commandExists } = await import('../processes.js');
    const result = await commandExists('nonexistent');

    expect(result).toBe(false);
  });

  it('should return false on execution error', async () => {
    execSpy.mockRejectedValue(new Error('Command failed'));

    const { commandExists } = await import('../processes.js');
    const result = await commandExists('test');

    expect(result).toBe(false);
  });
});
