/**
 * Unit tests for the plugin item loaders:
 *   - loaders/agents-loader.ts   (discoverPluginAgents)
 *   - loaders/mcp-loader.ts      (loadPluginMcpServers, mergeMcpConfigs)
 *   - loaders/skills-loader.ts   (discoverPluginSkills, discoverPluginCommands)
 *
 * These loaders are pure fs operations over a plugin directory, so each test
 * seeds a unique mkdtemp temp dir, asserts discovery + conversion, and cleans
 * up in afterEach. No network / spawn / LLM calls are involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { discoverPluginAgents } from '../loaders/agents-loader.js';
import {
  loadPluginMcpServers,
  mergeMcpConfigs,
} from '../loaders/mcp-loader.js';
import {
  discoverPluginSkills,
  discoverPluginCommands,
} from '../loaders/skills-loader.js';
import type { McpConfig, PluginManifest } from '../core/types.js';

const tempDirs: string[] = [];

function makePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codemie-item-loaders-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ============================================================================
// agents-loader
// ============================================================================

describe('discoverPluginAgents', () => {
  it('discovers agent .md files and converts them to namespaced PluginAgents', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(
      join(pluginDir, 'agents', 'reviewer.md'),
      '---\nname: code-reviewer\ndescription: Reviews code\n---\nYou are a reviewer.\n'
    );

    const manifest: PluginManifest = { name: 'my-plugin' };
    const agents = await discoverPluginAgents(pluginDir, manifest);

    expect(agents).toHaveLength(1);
    const agent = agents[0];
    expect(agent.pluginName).toBe('my-plugin');
    // Name comes from frontmatter metadata, not the filename
    expect(agent.agentName).toBe('code-reviewer');
    expect(agent.namespacedName).toBe('my-plugin:code-reviewer');
    // Loader normalizes to forward slashes; normalize both sides for Windows.
    expect(agent.filePath.replace(/\\/g, '/')).toBe(join(pluginDir, 'agents', 'reviewer.md').replace(/\\/g, '/'));
    expect(agent.content).toBe('You are a reviewer.');
    expect(agent.metadata).toMatchObject({
      name: 'code-reviewer',
      description: 'Reviews code',
    });
  });

  it('falls back to the filename when frontmatter has no name', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(
      join(pluginDir, 'agents', 'helper.md'),
      '---\ndescription: no name here\n---\nBody text.\n'
    );

    const agents = await discoverPluginAgents(pluginDir, { name: 'p' });

    expect(agents).toHaveLength(1);
    expect(agents[0].agentName).toBe('helper');
    expect(agents[0].namespacedName).toBe('p:helper');
  });

  it('returns an empty array when the agents directory is empty', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'agents'), { recursive: true });

    const agents = await discoverPluginAgents(pluginDir, { name: 'p' });

    expect(agents).toEqual([]);
  });

  it('returns an empty array when the agents directory does not exist', async () => {
    const pluginDir = makePluginDir();

    const agents = await discoverPluginAgents(pluginDir, { name: 'p' });

    expect(agents).toEqual([]);
  });

  it('keeps a file with malformed frontmatter, falling back to filename + full content', async () => {
    // hasFrontmatter() is non-throwing: broken YAML makes it return false, so
    // the loader treats the whole file as content and derives the name from the
    // filename instead of skipping the file.
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(
      join(pluginDir, 'agents', 'broken.md'),
      '---\nname: [unterminated\n---\nSome body.\n'
    );

    const agents = await discoverPluginAgents(pluginDir, { name: 'p' });

    expect(agents).toHaveLength(1);
    expect(agents[0].agentName).toBe('broken');
    // Full file content retained since frontmatter was not parsed
    expect(agents[0].content).toContain('name: [unterminated');
    expect(agents[0].metadata).toEqual({});
  });

  it('honors a custom agents directory from the manifest', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'custom-agents'), { recursive: true });
    await writeFile(
      join(pluginDir, 'custom-agents', 'a.md'),
      '---\nname: alpha\n---\nBody.\n'
    );

    const agents = await discoverPluginAgents(pluginDir, {
      name: 'p',
      agents: 'custom-agents',
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].agentName).toBe('alpha');
  });
});

// ============================================================================
// mcp-loader
// ============================================================================

describe('loadPluginMcpServers', () => {
  it('loads and namespaces servers from a .mcp.json file at the plugin root', async () => {
    const pluginDir = makePluginDir();
    await writeFile(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const config = await loadPluginMcpServers(pluginDir, { name: 'my-tools' });

    expect(config).not.toBeNull();
    const servers = config!.mcpServers;
    expect(Object.keys(servers)).toEqual(['my-tools:filesystem']);
    expect(servers['my-tools:filesystem']).toEqual({
      command: 'node',
      args: ['server.js'],
    });
  });

  it('expands ${CLAUDE_PLUGIN_ROOT} in server config values', async () => {
    const pluginDir = makePluginDir();
    await writeFile(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
            args: ['--root', '${CLAUDE_PLUGIN_ROOT}'],
          },
        },
      })
    );

    const config = await loadPluginMcpServers(pluginDir, { name: 'p' });

    const server = config!.mcpServers['p:local'];
    expect(server.command).toBe(`${pluginDir}/bin/server`);
    expect(server.args).toEqual(['--root', pluginDir]);
  });

  it('reads inline mcpServers config from the manifest', async () => {
    const pluginDir = makePluginDir();
    const manifest: PluginManifest = {
      name: 'inline-plugin',
      mcpServers: {
        mcpServers: {
          echo: { command: 'echo', args: ['hi'] },
        },
      },
    };

    const config = await loadPluginMcpServers(pluginDir, manifest);

    expect(config).not.toBeNull();
    expect(Object.keys(config!.mcpServers)).toEqual(['inline-plugin:echo']);
  });

  it('returns null when no MCP config is present', async () => {
    const pluginDir = makePluginDir();

    const config = await loadPluginMcpServers(pluginDir, { name: 'p' });

    expect(config).toBeNull();
  });

  it('returns null when the .mcp.json is malformed JSON', async () => {
    const pluginDir = makePluginDir();
    await writeFile(join(pluginDir, '.mcp.json'), '{ not valid json');

    const config = await loadPluginMcpServers(pluginDir, { name: 'p' });

    expect(config).toBeNull();
  });

  it('returns an empty server map when config has no mcpServers key', async () => {
    const pluginDir = makePluginDir();
    await writeFile(join(pluginDir, '.mcp.json'), JSON.stringify({ other: 1 }));

    const config = await loadPluginMcpServers(pluginDir, { name: 'p' });

    expect(config).toEqual({ mcpServers: {} });
  });
});

describe('mergeMcpConfigs', () => {
  it('merges two configs with plugin entries overriding base on key collision', () => {
    const base: McpConfig = {
      mcpServers: {
        a: { command: 'base-a' },
        shared: { command: 'base-shared' },
      },
    };
    const plugin: McpConfig = {
      mcpServers: {
        b: { command: 'plugin-b' },
        shared: { command: 'plugin-shared' },
      },
    };

    const merged = mergeMcpConfigs(base, plugin);

    expect(Object.keys(merged.mcpServers).sort()).toEqual(['a', 'b', 'shared']);
    expect(merged.mcpServers.shared.command).toBe('plugin-shared');
    expect(merged.mcpServers.a.command).toBe('base-a');
    expect(merged.mcpServers.b.command).toBe('plugin-b');
  });
});

// ============================================================================
// skills-loader
// ============================================================================

describe('discoverPluginSkills', () => {
  it('discovers SKILL.md files and converts them to namespaced PluginSkills', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'skills', 'greeter'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greet\ndescription: Says hello\n---\nGreeting body.\n'
    );

    const skills = await discoverPluginSkills(pluginDir, { name: 'my-plugin' });

    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(skill.pluginName).toBe('my-plugin');
    expect(skill.skillName).toBe('greet');
    expect(skill.namespacedName).toBe('my-plugin:greet');
    expect(skill.filePath.replace(/\\/g, '/')).toBe(
      join(pluginDir, 'skills', 'greeter', 'SKILL.md').replace(/\\/g, '/')
    );
    expect(skill.content).toBe('Greeting body.');
    expect(skill.metadata).toMatchObject({ name: 'greet' });
  });

  it('falls back to the directory name when frontmatter has no name', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'skills', 'my-cool-skill'), {
      recursive: true,
    });
    await writeFile(
      join(pluginDir, 'skills', 'my-cool-skill', 'SKILL.md'),
      '---\ndescription: no name\n---\nBody.\n'
    );

    const skills = await discoverPluginSkills(pluginDir, { name: 'p' });

    expect(skills).toHaveLength(1);
    expect(skills[0].skillName).toBe('my-cool-skill');
    expect(skills[0].namespacedName).toBe('p:my-cool-skill');
  });

  it('discovers multiple skills across nested skill directories', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'skills', 'one'), { recursive: true });
    await mkdir(join(pluginDir, 'skills', 'two'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills', 'one', 'SKILL.md'),
      '---\nname: one\n---\nA.\n'
    );
    await writeFile(
      join(pluginDir, 'skills', 'two', 'SKILL.md'),
      '---\nname: two\n---\nB.\n'
    );

    const skills = await discoverPluginSkills(pluginDir, { name: 'p' });

    expect(skills.map((s) => s.skillName).sort()).toEqual(['one', 'two']);
  });

  it('returns an empty array when there are no SKILL.md files', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'skills'), { recursive: true });

    const skills = await discoverPluginSkills(pluginDir, { name: 'p' });

    expect(skills).toEqual([]);
  });

  it('returns an empty array when the skills directory does not exist', async () => {
    const pluginDir = makePluginDir();

    const skills = await discoverPluginSkills(pluginDir, { name: 'p' });

    expect(skills).toEqual([]);
  });

  it('keeps a SKILL.md with malformed frontmatter, using dir name + full content', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'skills', 'brokenskill'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills', 'brokenskill', 'SKILL.md'),
      '---\nname: [oops\n---\nBody.\n'
    );

    const skills = await discoverPluginSkills(pluginDir, { name: 'p' });

    expect(skills).toHaveLength(1);
    expect(skills[0].skillName).toBe('brokenskill');
    expect(skills[0].content).toContain('name: [oops');
    expect(skills[0].metadata).toEqual({});
  });
});

describe('discoverPluginCommands', () => {
  it('discovers command .md files and converts them to namespaced PluginCommands', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'commands'), { recursive: true });
    await writeFile(
      join(pluginDir, 'commands', 'deploy.md'),
      '---\nname: deploy\n---\nRun the deploy.\n'
    );

    const commands = await discoverPluginCommands(pluginDir, { name: 'ops' });

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd.commandName).toBe('deploy');
    expect(cmd.namespacedName).toBe('ops:deploy');
    expect(cmd.content).toBe('Run the deploy.');
  });

  it('derives the command name from the filename when frontmatter is absent', async () => {
    const pluginDir = makePluginDir();
    await mkdir(join(pluginDir, 'commands'), { recursive: true });
    await writeFile(
      join(pluginDir, 'commands', 'status.md'),
      'Just a plain markdown command with no frontmatter.\n'
    );

    const commands = await discoverPluginCommands(pluginDir, { name: 'p' });

    expect(commands).toHaveLength(1);
    expect(commands[0].commandName).toBe('status');
    expect(commands[0].metadata).toEqual({});
    expect(commands[0].content).toBe(
      'Just a plain markdown command with no frontmatter.'
    );
  });

  it('returns an empty array when the commands directory does not exist', async () => {
    const pluginDir = makePluginDir();

    const commands = await discoverPluginCommands(pluginDir, { name: 'p' });

    expect(commands).toEqual([]);
  });
});
