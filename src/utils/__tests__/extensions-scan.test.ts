/**
 * Tests for extensions scanning.
 *
 * Covers the multi-directory support added for OpenCode (singular/plural
 * spellings, extra global roots) and pins the existing Claude-shaped behaviour
 * so those additions stay backwards compatible.
 *
 * @group unit
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getExtensionsScanSummary } from '../extensions-scan.js';
import type { AgentExtensionsConfig } from '../../agents/core/types.js';

let root: string;

function write(relativePath: string, content = 'x'): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'codemie-ext-scan-'));

  // Claude-shaped project layout (plural directories).
  write('claude-project/.claude/agents/explorer.md');
  write('claude-project/.claude/commands/deploy.md');
  write('claude-project/.claude/commands/README.md');       // ignored by design
  write('claude-project/.claude/skills/my-skill/SKILL.md');
  write('claude-project/.claude/hooks/pre-commit.sh');
  write('claude-project/.claude/rules/style.md');

  // Namespaced subdirectories sharing a basename — a normal Claude layout, and
  // the one input where cross-directory de-duplication could regress counts.
  write('claude-nested/.claude/commands/a/build.md');
  write('claude-nested/.claude/commands/b/build.md');
  write('claude-nested/.claude/agents/team-x/review.md');
  write('claude-nested/.claude/agents/team-y/review.md');

  // OpenCode-shaped project layout: singular directories, plugins not hooks.
  write('oc-project/.opencode/agent/reviewer.md');
  write('oc-project/.opencode/command/build.md');
  write('oc-project/.opencode/skill/deep-dive/SKILL.md');
  write('oc-project/.opencode/plugin/telemetry.ts');

  // Same OpenCode project also using the plural spellings.
  write('oc-both/.opencode/agent/reviewer.md');
  write('oc-both/.opencode/agents/reviewer.md');            // duplicate name
  write('oc-both/.opencode/agents/second.md');
  write('oc-both/.opencode/plugins/extra.js');

  // Two global roots, both of which OpenCode reads.
  write('global-xdg/opencode/agent/from-xdg.md');
  write('global-home/.opencode/agent/from-home.md');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getExtensionsScanSummary', () => {
  it('returns zeros when the agent declares no extensions config', async () => {
    const summary = await getExtensionsScanSummary(undefined, root);

    expect(summary.project).toEqual({ agents: 0, commands: 0, skills: 0, hooks: 0, rules: 0 });
    expect(summary.global).toEqual({ agents: 0, commands: 0, skills: 0, hooks: 0, rules: 0 });
    expect(summary.projectNames.agents).toEqual([]);
  });

  it('scans the default plural directories unchanged (Claude behaviour)', async () => {
    const config: AgentExtensionsConfig = {
      project: '.claude',
      global: '.claude-global-absent',
      skillsEntryFile: 'SKILL.md',
    };

    const summary = await getExtensionsScanSummary(config, join(root, 'claude-project'));

    expect(summary.project).toEqual({ agents: 1, commands: 1, skills: 1, hooks: 1, rules: 1 });
    expect(summary.projectNames.agents).toEqual(['explorer']);
    expect(summary.projectNames.commands).toEqual(['deploy']);
    // skillsEntryFile makes the skill's directory name the reported name.
    expect(summary.projectNames.skills).toEqual(['my-skill']);
    expect(summary.projectNames.hooks).toEqual(['pre-commit.sh']);
    expect(summary.projectNames.rules).toEqual(['style']);
  });

  it('counts same-named files in different subdirectories separately (Claude regression)', async () => {
    // Regression guard: de-duplicating names across a single directory's
    // recursive listing silently shrank commands_count / agents_count for every
    // agent using namespaced subdirectories. Only cross-directory duplicates
    // (the same extension under two spellings) may collapse.
    const config: AgentExtensionsConfig = {
      project: '.claude',
      global: '.claude-global-absent',
      skillsEntryFile: 'SKILL.md',
    };

    const summary = await getExtensionsScanSummary(config, join(root, 'claude-nested'));

    expect(summary.project.commands).toBe(2);
    expect(summary.project.agents).toBe(2);
    expect(summary.projectNames.commands).toEqual(['build', 'build']);
    expect(summary.projectNames.agents).toEqual(['review', 'review']);
  });

  it('scans singular directory names when the agent declares them', async () => {
    const config: AgentExtensionsConfig = {
      project: '.opencode',
      skillsEntryFile: 'SKILL.md',
      dirNames: {
        agents: ['agent', 'agents'],
        commands: ['command', 'commands'],
        skills: ['skill', 'skills'],
        hooks: ['plugin', 'plugins'],
        rules: [],
      },
    };

    const summary = await getExtensionsScanSummary(config, join(root, 'oc-project'));

    expect(summary.project.agents).toBe(1);
    expect(summary.project.commands).toBe(1);
    expect(summary.project.skills).toBe(1);
    // OpenCode has no hooks/ directory; plugins stand in for that slot.
    expect(summary.project.hooks).toBe(1);
    expect(summary.projectNames.hooks).toEqual(['telemetry.ts']);
    // An empty dirNames list means the concept does not exist for this agent.
    expect(summary.project.rules).toBe(0);
  });

  it('merges singular and plural directories without double counting', async () => {
    const config: AgentExtensionsConfig = {
      project: '.opencode',
      dirNames: { agents: ['agent', 'agents'], hooks: ['plugin', 'plugins'] },
    };

    const summary = await getExtensionsScanSummary(config, join(root, 'oc-both'));

    // 'reviewer' appears under both spellings but counts once.
    expect(summary.projectNames.agents).toEqual(['reviewer', 'second']);
    expect(summary.project.agents).toBe(2);
    expect(summary.projectNames.hooks).toEqual(['extra.js']);
  });

  it('scans extra global roots alongside the primary one', async () => {
    const config: AgentExtensionsConfig = {
      global: join(root, 'global-xdg', 'opencode'),
      extraGlobalDirs: [join(root, 'global-home', '.opencode')],
      dirNames: { agents: ['agent', 'agents'] },
    };

    const summary = await getExtensionsScanSummary(config, root);

    expect(summary.globalNames.agents).toEqual(['from-home', 'from-xdg']);
    expect(summary.global.agents).toBe(2);
  });

  it('degrades to zeros for directories that do not exist', async () => {
    const config: AgentExtensionsConfig = {
      project: '.does-not-exist',
      global: join(root, 'also-missing'),
    };

    const summary = await getExtensionsScanSummary(config, root);

    expect(summary.project.agents).toBe(0);
    expect(summary.global.agents).toBe(0);
  });
});
