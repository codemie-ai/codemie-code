/**
 * Session Discovery Unit Tests
 *
 * Tests for agent-agnostic session file discovery using adapters.
 * Covers recursive directory scanning, pattern filtering, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { existsSync } from 'fs';
import { discoverSessionFiles } from '../session-discovery.js';
import type { SessionAdapter } from '../../adapters/base/BaseSessionAdapter.js';

// Mock SessionAdapter implementation for testing
class MockSessionAdapter implements SessionAdapter {
  readonly agentName = 'mock-agent';
  private baseDirectory: string;
  private patternSuffix: string;
  private projectDirectories?: string[];

  constructor(
    baseDir: string,
    patternSuffix = '.jsonl',
    projectDirs?: string[]
  ) {
    this.baseDirectory = baseDir;
    this.patternSuffix = patternSuffix;
    this.projectDirectories = projectDirs;
  }

  getSessionPaths() {
    return {
      baseDir: this.baseDirectory,
      projectDirs: this.projectDirectories
    };
  }

  matchesSessionPattern(filePath: string): boolean {
    const filename = filePath.split(sep).pop() || '';
    return (
      filename.endsWith(this.patternSuffix) &&
      !filename.startsWith('agent-') &&
      !filename.startsWith('.')
    );
  }

  async parseSessionFile(): Promise<any> {
    return { sessionId: 'mock', agentName: 'mock-agent', messages: [] };
  }
}

describe('Session Discovery - Basic Functionality', () => {
  let tempDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-discovery-test-'));
    baseDir = join(tempDir, 'sessions');
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should discover all session files in directory', async () => {
    // Create test structure
    const projectDir = join(baseDir, 'project-1');
    await mkdir(projectDir);
    await writeFile(join(projectDir, 'session-1.jsonl'), '');
    await writeFile(join(projectDir, 'session-2.jsonl'), '');
    await writeFile(join(projectDir, 'agent-abc.jsonl'), ''); // Should be filtered

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(2);
    expect(files).toContain(join(projectDir, 'session-1.jsonl'));
    expect(files).toContain(join(projectDir, 'session-2.jsonl'));
    expect(files).not.toContain(join(projectDir, 'agent-abc.jsonl'));
  });

  it('should filter using adapter.matchesSessionPattern()', async () => {
    const projectDir = join(baseDir, 'project-1');
    await mkdir(projectDir);
    await writeFile(join(projectDir, 'valid.jsonl'), '');
    await writeFile(join(projectDir, 'valid.txt'), '');
    await writeFile(join(projectDir, '.hidden.jsonl'), '');
    await writeFile(join(projectDir, 'agent-123.jsonl'), '');

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('valid.jsonl');
  });

  it('should scan nested directories recursively', async () => {
    // Create nested structure
    const project1 = join(baseDir, 'project-1');
    const project2 = join(baseDir, 'project-2');
    const project3 = join(baseDir, 'nested', 'project-3');

    await mkdir(project1);
    await mkdir(project2);
    await mkdir(project3, { recursive: true });

    await writeFile(join(project1, 'session-a.jsonl'), '');
    await writeFile(join(project2, 'session-b.jsonl'), '');
    await writeFile(join(project3, 'session-c.jsonl'), '');

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    // Should only find project-1 and project-2 (direct subdirs of baseDir)
    // project-3 is nested under 'nested' which is not scanned
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some(f => f.includes('session-a.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('session-b.jsonl'))).toBe(true);
  });

  it('should return empty array for non-existent path', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    const adapter = new MockSessionAdapter(nonExistentDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toEqual([]);
  });
});

describe('Session Discovery - Edge Cases', () => {
  let tempDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-discovery-test-'));
    baseDir = join(tempDir, 'sessions');
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle empty directories', async () => {
    const emptyProject = join(baseDir, 'empty-project');
    await mkdir(emptyProject);

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toEqual([]);
  });

  it('should handle multiple adapters', async () => {
    // Create files for different agents
    const project1 = join(baseDir, 'project-1');
    await mkdir(project1);
    await writeFile(join(project1, 'session.jsonl'), '');
    await writeFile(join(project1, 'session.log'), '');
    await writeFile(join(project1, 'config.json'), '');

    // Adapter 1: Matches .jsonl files
    const adapter1 = new MockSessionAdapter(baseDir, '.jsonl');
    const files1 = await discoverSessionFiles(adapter1);
    expect(files1).toHaveLength(1);
    expect(files1[0]).toContain('.jsonl');

    // Adapter 2: Matches .log files
    const adapter2 = new MockSessionAdapter(baseDir, '.log');
    const files2 = await discoverSessionFiles(adapter2);
    expect(files2).toHaveLength(1);
    expect(files2[0]).toContain('.log');
  });
});

describe('Session Discovery - Cross-Platform Path Handling', () => {
  let tempDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-discovery-test-'));
    baseDir = join(tempDir, 'sessions');
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle platform-specific paths correctly', async () => {
    // Create test structure
    const projectDir = join(baseDir, 'test-project');
    await mkdir(projectDir);
    await writeFile(join(projectDir, 'session.jsonl'), '');

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(1);
    // Verify path uses platform-specific separator
    expect(files[0]).toContain(sep);
    // Verify path is absolute
    expect(files[0]).toContain(baseDir);
  });

  it('should handle paths with special characters', async () => {
    // Create directory with spaces and special chars
    const specialDir = join(baseDir, 'project with spaces');
    await mkdir(specialDir);
    await writeFile(join(specialDir, 'session-1.jsonl'), '');

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('project with spaces');
  });
});

describe('Session Discovery - Project Directory Filtering', () => {
  let tempDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-discovery-test-'));
    baseDir = join(tempDir, 'sessions');
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should search only specified project directories when provided', async () => {
    // Create multiple project directories
    const project1 = join(baseDir, 'project-1');
    const project2 = join(baseDir, 'project-2');
    const project3 = join(baseDir, 'project-3');

    await mkdir(project1);
    await mkdir(project2);
    await mkdir(project3);

    await writeFile(join(project1, 'session-1.jsonl'), '');
    await writeFile(join(project2, 'session-2.jsonl'), '');
    await writeFile(join(project3, 'session-3.jsonl'), '');

    // Only search project-1 and project-3
    const adapter = new MockSessionAdapter(baseDir, '.jsonl', ['project-1', 'project-3']);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(2);
    expect(files.some(f => f.includes('session-1.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('session-3.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('session-2.jsonl'))).toBe(false);
  });

  it('should discover files in base directory when no subdirectories exist', async () => {
    // Create files directly in base directory
    await writeFile(join(baseDir, 'session-1.jsonl'), '');
    await writeFile(join(baseDir, 'session-2.jsonl'), '');
    await writeFile(join(baseDir, 'agent-123.jsonl'), ''); // Should be filtered

    const adapter = new MockSessionAdapter(baseDir);
    const files = await discoverSessionFiles(adapter);

    expect(files).toHaveLength(2);
    expect(files.some(f => f.includes('session-1.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('session-2.jsonl'))).toBe(true);
  });
});
