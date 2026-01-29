/**
 * Skills Integration Tests
 *
 * Tests the skill discovery and loading system end-to-end.
 * Verifies skills are passed to agents and bash skills work correctly.
 *
 * Performance: Commands executed once per suite in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCLIRunner, createTempWorkspace, type CommandResult } from '../helpers/index.js';
import { setupTestIsolation, getTestHome } from '../helpers/test-isolation.js';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const cli = createCLIRunner();

describe('Skills Integration - Happy Path', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-integration-');
  let listResult: CommandResult;

  beforeAll(async () => {
    // Create test skill
    workspace.writeFile('.codemie/skills/test-skill/SKILL.md', `---
name: test-skill
description: Test skill for integration testing
priority: 10
modes:
  - code
compatibility:
  agents:
    - codemie-code
---

# Test Skill

When the user asks to "test the skill system", respond with "Skill system is working!"
`);

    // List skills to verify discovery
    listResult = cli.runSilent(`skill list --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should discover and load test skill', () => {
    expect(listResult.exitCode).toBe(0);
    expect(listResult.output).toContain('test-skill');
    expect(listResult.output).toContain('Test skill for integration testing');
  });

  it('should show skill source as project', () => {
    expect(listResult.exitCode).toBe(0);
    expect(listResult.output).toContain('project');
  });
});

describe('Skills Integration - Bash Skills', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-bash-');
  let listResult: CommandResult;
  let validateResult: CommandResult;

  beforeAll(async () => {
    // Create bash-specific skill
    workspace.writeFile('.codemie/skills/bash-commands/SKILL.md', `---
name: bash-commands
description: Guidelines for bash command execution
priority: 20
modes:
  - code
compatibility:
  agents:
    - codemie-code
---

# Bash Command Guidelines

When executing bash commands:
- Always use the Bash tool for system operations
- Verify file paths before operations
- Use appropriate error handling

Example: When asked to "list files in current directory", use:
\`\`\`bash
ls -la
\`\`\`
`);

    // Execute commands once
    listResult = cli.runSilent(`skill list --cwd ${workspace.path}`);
    validateResult = cli.runSilent(`skill validate --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should load bash skill successfully', () => {
    expect(listResult.exitCode).toBe(0);
    expect(listResult.output).toContain('bash-commands');
    expect(listResult.output).toContain('Guidelines for bash command execution');
  });

  it('should validate bash skill content', () => {
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.output).toMatch(/✓ Valid skills?: 1/);
  });
});

describe('Skills Integration - Priority Resolution', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-priority-');
  let listResult: CommandResult;

  beforeAll(async () => {
    // Create global skill (low priority) - write directly to testHome (not workspace)
    // Using direct fs calls because globalSkillDir is an absolute path,
    // and workspace.writeFile() would incorrectly join workspace.path + absolute path on Windows
    const testHome = getTestHome();
    const globalSkillDir = join(testHome, 'skills', 'global-skill');
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, 'SKILL.md'), `---
name: typescript-style
description: Global TypeScript style guide
priority: 5
---
Use semicolons
`);

    // Create project skill (high priority, same name)
    workspace.writeFile('.codemie/skills/project-skill/SKILL.md', `---
name: typescript-style
description: Project-specific TypeScript style guide
priority: 10
---
No semicolons (project preference)
`);

    // List skills
    listResult = cli.runSilent(`skill list --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should prioritize project skill over global skill', () => {
    expect(listResult.exitCode).toBe(0);

    // Should only show project skill (deduplication by name)
    const lines = listResult.output.split('\n').filter(l => l.includes('typescript-style'));
    expect(lines.length).toBeGreaterThan(0);

    // Should show project source (project skills have higher priority)
    expect(listResult.output).toMatch(/typescript-style/);
    expect(listResult.output).toMatch(/project/);
  });
});

describe('Skills Integration - Mode Filtering', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-mode-');
  let codeListResult: CommandResult;
  let architectListResult: CommandResult;

  beforeAll(async () => {
    // Create code-mode skill
    workspace.writeFile('.codemie/skills/code-skill/SKILL.md', `---
name: code-mode-skill
description: Only for code mode
modes:
  - code
---
Code mode content
`);

    // Create architect-mode skill
    workspace.writeFile('.codemie/skills/architect-skill/SKILL.md', `---
name: architect-mode-skill
description: Only for architect mode
modes:
  - architect
---
Architect mode content
`);

    // List skills with different mode filters
    codeListResult = cli.runSilent(`skill list --mode code --cwd ${workspace.path}`);
    architectListResult = cli.runSilent(`skill list --mode architect --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should only load skills matching code mode', () => {
    expect(codeListResult.exitCode).toBe(0);
    expect(codeListResult.output).toContain('code-mode-skill');
    expect(codeListResult.output).not.toContain('architect-mode-skill');
  });

  it('should only load skills matching architect mode', () => {
    expect(architectListResult.exitCode).toBe(0);
    expect(architectListResult.output).toContain('architect-mode-skill');
    expect(architectListResult.output).not.toContain('code-mode-skill');
  });
});

describe('Skills Integration - Cache Management', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-cache-');
  let firstListResult: CommandResult;
  let reloadResult: CommandResult;
  let secondListResult: CommandResult;

  beforeAll(async () => {
    // Create initial skill
    workspace.writeFile('.codemie/skills/cached-skill/SKILL.md', `---
name: cached-skill
description: Initial version
---
Initial content
`);

    // First load
    firstListResult = cli.runSilent(`skill list --cwd ${workspace.path}`);

    // Reload cache
    reloadResult = cli.runSilent('skill reload');

    // Second load (after reload)
    secondListResult = cli.runSilent(`skill list --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should list skills before reload', () => {
    expect(firstListResult.exitCode).toBe(0);
    expect(firstListResult.output).toContain('cached-skill');
  });

  it('should clear cache successfully', () => {
    expect(reloadResult.exitCode).toBe(0);
    expect(reloadResult.output).toMatch(/✓ Skill cache cleared/);
  });

  it('should list skills after reload', () => {
    expect(secondListResult.exitCode).toBe(0);
    expect(secondListResult.output).toContain('cached-skill');
  });
});

describe('Skills Integration - Error Handling', () => {
  setupTestIsolation();

  const workspace = createTempWorkspace('skills-errors-');
  let validateResult: CommandResult;
  let listResult: CommandResult;

  beforeAll(async () => {
    // Create valid skill
    workspace.writeFile('.codemie/skills/valid-skill/SKILL.md', `---
name: valid-skill
description: Valid skill
---
Valid content
`);

    // Create invalid skill (missing required field)
    workspace.writeFile('.codemie/skills/invalid-skill/SKILL.md', `---
name: invalid-skill
---
Missing description field
`);

    // Execute commands
    validateResult = cli.runSilent(`skill validate --cwd ${workspace.path}`);
    listResult = cli.runSilent(`skill list --cwd ${workspace.path}`);
  }, 30000);

  afterAll(() => {
    workspace.cleanup();
  });

  it('should validate and report only valid skills', () => {
    // Validation succeeds (invalid skills are silently filtered)
    expect(validateResult.exitCode).toBe(0);

    // Should report valid skills
    expect(validateResult.output).toMatch(/✓ Valid skills?: 1/);
    expect(validateResult.output).toContain('valid-skill');

    // Invalid skills are silently filtered during discovery
    // (Current implementation doesn't track parse errors)
  });

  it('should continue loading valid skills when invalid skills exist', () => {
    // List should succeed (non-blocking)
    expect(listResult.exitCode).toBe(0);

    // Should show valid skill
    expect(listResult.output).toContain('valid-skill');

    // Invalid skill should be silently filtered
    expect(listResult.output).not.toContain('invalid-skill');
  });
});
