/**
 * Integration tests for pattern-based skill invocation
 *
 * Tests the integration between pattern detection and skill loading
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../../src/skills/core/SkillManager.js';
import { extractSkillPatterns } from '../../src/skills/utils/pattern-matcher.js';
import { loadSkillWithInventory } from '../../src/skills/utils/content-loader.js';

describe('Pattern-based skill invocation (Integration)', () => {
  let tempSkillsDir: string;

  beforeEach(async () => {
    // Reset SkillManager singleton
    SkillManager.resetInstance();

    // Create temporary skills directory
    tempSkillsDir = path.join(
      process.cwd(),
      '.test-skills-' + Date.now().toString()
    );
    await fs.promises.mkdir(tempSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temp directory
    if (fs.existsSync(tempSkillsDir)) {
      await fs.promises.rm(tempSkillsDir, { recursive: true, force: true });
    }
  });

  it('should detect pattern and load skill with inventory', async () => {
    // Create test skill
    const skillDir = path.join(tempSkillsDir, '.codemie', 'skills', 'test-skill');
    await fs.promises.mkdir(skillDir, { recursive: true });

    const skillContent = `---
name: test-skill
description: A test skill for integration testing
priority: 0
---

# Test Skill

This is a test skill for pattern invocation.

## Usage

Use this skill by typing /test-skill in your message.
`;

    await fs.promises.writeFile(
      path.join(skillDir, 'SKILL.md'),
      skillContent,
      'utf-8'
    );

    // Add a reference file
    await fs.promises.writeFile(
      path.join(skillDir, 'reference.md'),
      '# Reference\n\nExample reference content.',
      'utf-8'
    );

    // Step 1: Extract pattern
    const patternResult = extractSkillPatterns('/test-skill please help');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns).toHaveLength(1);
    expect(patternResult.patterns[0].name).toBe('test-skill');

    // Step 2: Load skill by name
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(['test-skill'], {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    expect(skills).toHaveLength(1);
    expect(skills[0].skill.metadata.name).toBe('test-skill');
    expect(skills[0].skill.metadata.description).toBe('A test skill for integration testing');

    // Step 3: Verify file inventory
    expect(skills[0].files).toHaveLength(1);
    expect(skills[0].files).toContain('reference.md');

    // Step 4: Verify formatted content
    expect(skills[0].formattedContent).toContain('## Skill: test-skill');
    expect(skills[0].formattedContent).toContain('### SKILL.md Content');
    expect(skills[0].formattedContent).toContain('### Available Files');
    expect(skills[0].formattedContent).toContain('- reference.md');
  });

  it('should handle multiple skill patterns', async () => {
    // Create two test skills
    const skill1Dir = path.join(tempSkillsDir, '.codemie', 'skills', 'skill-one');
    const skill2Dir = path.join(tempSkillsDir, '.codemie', 'skills', 'skill-two');

    await fs.promises.mkdir(skill1Dir, { recursive: true });
    await fs.promises.mkdir(skill2Dir, { recursive: true });

    await fs.promises.writeFile(
      path.join(skill1Dir, 'SKILL.md'),
      '---\nname: skill-one\ndescription: First skill\npriority: 0\n---\n\n# Skill One',
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(skill2Dir, 'SKILL.md'),
      '---\nname: skill-two\ndescription: Second skill\npriority: 0\n---\n\n# Skill Two',
      'utf-8'
    );

    // Extract patterns
    const patternResult = extractSkillPatterns('/skill-one and /skill-two');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns).toHaveLength(2);

    // Load both skills
    const skillNames = patternResult.patterns.map((p) => p.name);
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(skillNames, {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    expect(skills).toHaveLength(2);
    expect(skills[0].skill.metadata.name).toBe('skill-one');
    expect(skills[1].skill.metadata.name).toBe('skill-two');
  });

  it('should skip non-existent skills gracefully', async () => {
    // Extract pattern for non-existent skill
    const patternResult = extractSkillPatterns('/nonexistent-skill');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns[0].name).toBe('nonexistent-skill');

    // Try to load non-existent skill
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(['nonexistent-skill'], {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    // Should return empty array
    expect(skills).toHaveLength(0);
  });

  it('should handle mixed valid and invalid skills', async () => {
    // Create one valid skill
    const validSkillDir = path.join(tempSkillsDir, '.codemie', 'skills', 'valid-skill');
    await fs.promises.mkdir(validSkillDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(validSkillDir, 'SKILL.md'),
      '---\nname: valid-skill\ndescription: Valid skill\npriority: 0\n---\n\n# Valid Skill',
      'utf-8'
    );

    // Extract patterns (mix of valid and invalid)
    const patternResult = extractSkillPatterns('/valid-skill /invalid-skill /another-invalid');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns).toHaveLength(3);

    // Load skills
    const skillNames = patternResult.patterns.map((p) => p.name);
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(skillNames, {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    // Should only return the valid skill
    expect(skills).toHaveLength(1);
    expect(skills[0].skill.metadata.name).toBe('valid-skill');
  });

  it('should exclude built-in commands from pattern detection', async () => {
    const patternResult = extractSkillPatterns('/help me with this');

    expect(patternResult.hasPatterns).toBe(false);
    expect(patternResult.patterns).toHaveLength(0);
  });

  it('should deduplicate skill patterns', async () => {
    const patternResult = extractSkillPatterns('/test-skill and /test-skill again');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns).toHaveLength(1);
    expect(patternResult.patterns[0].name).toBe('test-skill');
  });

  it('should include file inventory with subdirectories', async () => {
    // Create skill with nested structure
    const skillDir = path.join(tempSkillsDir, '.codemie', 'skills', 'files-skill');
    await fs.promises.mkdir(skillDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: files-skill\ndescription: Skill with files\npriority: 0\n---\n\n# Files Skill',
      'utf-8'
    );

    // Create subdirectory with files
    const refsDir = path.join(skillDir, 'references');
    await fs.promises.mkdir(refsDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(skillDir, 'README.md'),
      '# README',
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(refsDir, 'guide.md'),
      '# Guide',
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(skillDir, 'script.sh'),
      '#!/bin/bash',
      'utf-8'
    );

    // Load skill
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(['files-skill'], {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    expect(skills).toHaveLength(1);

    // Verify file inventory
    expect(skills[0].files).toHaveLength(3);
    expect(skills[0].files).toContain('README.md');
    expect(skills[0].files).toContain(path.join('references', 'guide.md'));
    expect(skills[0].files).toContain('script.sh');

    // SKILL.md should be excluded
    expect(skills[0].files).not.toContain('SKILL.md');

    // Verify formatted content
    expect(skills[0].formattedContent).toContain('### Available Files');
    expect(skills[0].formattedContent).toContain('- README.md');
    expect(skills[0].formattedContent).toContain('- references');
    expect(skills[0].formattedContent).toContain('- script.sh');
  });

  it('should work with pattern arguments', async () => {
    const patternResult = extractSkillPatterns('/commit -m "fix bug"');

    expect(patternResult.hasPatterns).toBe(true);
    expect(patternResult.patterns[0].name).toBe('commit');
    expect(patternResult.patterns[0].args).toBe('-m "fix bug"');
    expect(patternResult.patterns[0].raw).toBe('/commit -m "fix bug"');
  });

  it('should handle skill with no additional files', async () => {
    // Create skill with only SKILL.md
    const skillDir = path.join(tempSkillsDir, '.codemie', 'skills', 'minimal-skill');
    await fs.promises.mkdir(skillDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: minimal-skill\ndescription: Minimal skill\npriority: 0\n---\n\n# Minimal',
      'utf-8'
    );

    // Load skill
    const manager = SkillManager.getInstance();
    const skills = await manager.getSkillsByNames(['minimal-skill'], {
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    expect(skills).toHaveLength(1);
    expect(skills[0].files).toHaveLength(0);

    // Formatted content should not include "Available Files" section
    expect(skills[0].formattedContent).toContain('## Skill: minimal-skill');
    expect(skills[0].formattedContent).toContain('### SKILL.md Content');
    expect(skills[0].formattedContent).not.toContain('### Available Files');
  });

  it('should load skill content directly via loadSkillWithInventory', async () => {
    // Create test skill
    const skillDir = path.join(tempSkillsDir, '.codemie', 'skills', 'direct-load');
    await fs.promises.mkdir(skillDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: direct-load\ndescription: Direct load test\npriority: 0\n---\n\n# Content',
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(skillDir, 'example.md'),
      '# Example',
      'utf-8'
    );

    // Discover skill first
    const manager = SkillManager.getInstance();
    const discoveredSkills = await manager.listSkills({
      cwd: tempSkillsDir,
      agentName: 'codemie-code',
    });

    // Find the specific skill we created
    const directLoadSkill = discoveredSkills.find(
      (s) => s.metadata.name === 'direct-load'
    );

    expect(directLoadSkill).toBeDefined();

    // Load with inventory
    const skillWithInventory = await loadSkillWithInventory(directLoadSkill!);

    expect(skillWithInventory.skill.metadata.name).toBe('direct-load');
    expect(skillWithInventory.files).toContain('example.md');
    expect(skillWithInventory.formattedContent).toContain('## Skill: direct-load');
    expect(skillWithInventory.formattedContent).toContain('- example.md');
  });
});
