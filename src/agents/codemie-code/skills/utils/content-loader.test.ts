/**
 * Tests for skill content loader
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadSkillWithInventory } from './content-loader.js';
import type { Skill } from '../core/types.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    promises: {
      readdir: vi.fn(),
    },
  };
});

describe('loadSkillWithInventory', () => {
  const mockSkill: Skill = {
    metadata: {
      name: 'test-skill',
      description: 'Test skill for unit tests',
      priority: 0,
    },
    content: 'This is the skill content from SKILL.md',
    filePath: '/test/path/.codemie/skills/test-skill/SKILL.md',
    source: 'project',
    computedPriority: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load skill with file inventory', async () => {
    // Mock directory exists
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Mock file listing
    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([
      { name: 'README.md', isDirectory: () => false, isFile: () => true } as any,
      { name: 'script.sh', isDirectory: () => false, isFile: () => true } as any,
      { name: 'SKILL.md', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.skill).toBe(mockSkill);
    expect(result.files).toEqual(['README.md', 'script.sh']); // SKILL.md excluded
    expect(result.formattedContent).toContain('## Skill: test-skill');
    expect(result.formattedContent).toContain('This is the skill content');
    expect(result.formattedContent).toContain('### Available Files');
    expect(result.formattedContent).toContain('- README.md');
    expect(result.formattedContent).toContain('- script.sh');
  });

  it('should handle missing directory gracefully', async () => {
    // Mock directory does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.skill).toBe(mockSkill);
    expect(result.files).toEqual([]);
    expect(result.formattedContent).toContain('## Skill: test-skill');
    expect(result.formattedContent).not.toContain('### Available Files');
  });

  it('should exclude hidden files', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([
      { name: '.hidden', isDirectory: () => false, isFile: () => true } as any,
      { name: 'visible.md', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.files).toEqual(['visible.md']);
    expect(result.files).not.toContain('.hidden');
  });

  it('should exclude node_modules directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([
      { name: 'file.md', isDirectory: () => false, isFile: () => true } as any,
      { name: 'node_modules', isDirectory: () => true, isFile: () => false } as any,
    ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.files).toEqual(['file.md']);
  });

  it('should only include supported file extensions', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([
      { name: 'doc.md', isDirectory: () => false, isFile: () => true } as any,
      { name: 'script.sh', isDirectory: () => false, isFile: () => true } as any,
      { name: 'code.js', isDirectory: () => false, isFile: () => true } as any,
      { name: 'binary.exe', isDirectory: () => false, isFile: () => true } as any,
      { name: 'image.png', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.files).toEqual(['code.js', 'doc.md', 'script.sh']); // Sorted
    expect(result.files).not.toContain('binary.exe');
    expect(result.files).not.toContain('image.png');
  });

  it('should handle subdirectories', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // First call: root directory
    vi.mocked(fs.promises.readdir)
      .mockResolvedValueOnce([
        { name: 'root.md', isDirectory: () => false, isFile: () => true } as any,
        { name: 'subdir', isDirectory: () => true, isFile: () => false } as any,
      ])
      // Second call: subdirectory
      .mockResolvedValueOnce([
        { name: 'nested.md', isDirectory: () => false, isFile: () => true } as any,
      ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.files).toContain('root.md');
    expect(result.files).toContain(path.join('subdir', 'nested.md'));
  });

  it('should sort files alphabetically', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([
      { name: 'zebra.md', isDirectory: () => false, isFile: () => true } as any,
      { name: 'alpha.md', isDirectory: () => false, isFile: () => true } as any,
      { name: 'beta.md', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.files).toEqual(['alpha.md', 'beta.md', 'zebra.md']);
  });

  it('should handle permission errors gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readdir).mockRejectedValueOnce(
      new Error('Permission denied')
    );

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.skill).toBe(mockSkill);
    expect(result.files).toEqual([]);
  });

  it('should format content without files when inventory is empty', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.formattedContent).toContain('## Skill: test-skill');
    expect(result.formattedContent).toContain('### SKILL.md Content');
    expect(result.formattedContent).not.toContain('### Available Files');
  });

  it('should include skill description in formatted content', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readdir).mockResolvedValueOnce([]);

    const result = await loadSkillWithInventory(mockSkill);

    expect(result.formattedContent).toContain('Test skill for unit tests');
  });
});
