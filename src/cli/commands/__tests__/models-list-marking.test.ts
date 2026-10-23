/**
 * `codemie models list` marks catalog rows that belong to the active profile's
 * own model list (resolveProfileModels), and the one matching the active model
 * distinctly, so a multi-model profile's own models are visible at a glance
 * without opening the full catalogue. A profile set up per agent tags each row
 * with the agents using it instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

import { formatAgentModelsBlock, formatTable, runModelsList, sortUsedModelsFirst } from '../models.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';
import type { ModelInfo } from '../../../providers/core/types.js';

function model(id: string): ModelInfo {
  return { id, name: id } as ModelInfo;
}

describe('formatTable — profile model marking', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function allLogs(): string {
    return logSpy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  it('marks ids in the profile model list, and the active model distinctly', () => {
    formatTable([model('a'), model('b'), model('c')], ['a', 'b'], 'a');

    const lines = allLogs().split('\n');
    const rowA = lines.find(l => /^a\s/.test(l));
    const rowB = lines.find(l => /^b\s/.test(l));
    const rowC = lines.find(l => /^c\s/.test(l));

    expect(rowA).toContain('(active)');
    expect(rowB).toContain('(profile)');
    expect(rowB).not.toContain('(active)');
    expect(rowC).not.toContain('(profile)');
    expect(rowC).not.toContain('(active)');
  });

  it('marks nothing when no profile model ids are given', () => {
    formatTable([model('a'), model('b')]);

    const rendered = allLogs();
    expect(rendered).not.toContain('(active)');
    expect(rendered).not.toContain('(profile)');
  });

  describe('per-agent columns', () => {
    const agentModels = {
      claude: { models: ['claude-x', 'shared'], model: 'claude-x' },
      codex: { models: ['gpt-5.4'], model: 'gpt-5.4' },
      opencode: { models: ['shared', 'gpt-5.4'], model: 'shared' },
    };
    let columns: PropertyDescriptor | undefined;

    beforeEach(() => {
      columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    });
    afterEach(() => {
      if (columns) Object.defineProperty(process.stdout, 'columns', columns);
      else delete (process.stdout as { columns?: number }).columns;
    });

    /** The cells of one row between NAME and DESCRIPTION, split by agent column. */
    function agentCells(line: string | undefined): string[] {
      const header = allLogs().split('\n')[0];
      const start = header.indexOf('CLAUDE');
      const end = header.indexOf('DESCRIPTION');
      const width = header.indexOf('CODEX') - start;
      const cells = (line ?? '').slice(start, end);
      return [0, 1, 2].map(i => cells.slice(i * width, (i + 1) * width).trim());
    }

    it('gives each agent its own column: active, available, or blank', () => {
      formatTable([model('claude-x'), model('gpt-5.4'), model('shared'), model('other')], [], undefined, agentModels);

      const lines = allLogs().split('\n');
      expect(lines[0]).toMatch(/CLAUDE\s+CODEX\s+OPENCODE\s+DESCRIPTION/);
      expect(agentCells(lines.find(l => /^claude-x\s/.test(l)))).toEqual(['active', '', '']);
      expect(agentCells(lines.find(l => /^gpt-5.4\s/.test(l)))).toEqual(['', 'active', '✓']);
      expect(agentCells(lines.find(l => /^shared\s/.test(l)))).toEqual(['✓', '', 'active']);
      expect(agentCells(lines.find(l => /^other\s/.test(l)))).toEqual(['', '', '']);
      expect(allLogs()).not.toContain('(active)');
    });

    it('explains the marks in a legend under the table', () => {
      formatTable([model('claude-x')], [], undefined, agentModels);

      expect(allLogs()).toContain('active = the agent starts with this model');
      expect(allLogs()).toContain('✓ = available to the agent');
      expect(allLogs()).toContain('codemie models switch --agent <name>');
    });

    it('falls back to one AGENTS column, starring active agents, with more than four agents', () => {
      const many = {
        ...agentModels,
        gemini: { models: ['gemini-x'], model: 'gemini-x' },
        pi: { models: ['shared'], model: 'shared' },
      };
      formatTable([model('shared'), model('gpt-5.4')], [], undefined, many);

      const lines = allLogs().split('\n');
      expect(lines[0]).toMatch(/AGENTS\s+DESCRIPTION/);
      expect(lines.find(l => /^shared\s/.test(l))).toContain('claude, opencode*, pi*');
      expect(lines.find(l => /^gpt-5.4\s/.test(l))).toContain('codex*, opencode');
      expect(allLogs()).toContain('* = the agent starts with this model');
    });

    it('falls back to one AGENTS column when the columns would overflow the terminal', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      formatTable([model('shared')], [], undefined, agentModels);

      expect(allLogs().split('\n')[0]).toMatch(/AGENTS\s+DESCRIPTION/);
    });
  });

  it('renders identically to before when no agent tags are given', () => {
    formatTable([model('a'), model('b')], ['a'], 'a');
    const without = allLogs();
    logSpy.mockClear();
    formatTable([model('a'), model('b')], ['a'], 'a', undefined);
    expect(allLogs()).toBe(without);
  });
});

describe('sortUsedModelsFirst', () => {
  it('moves the used models first, keeping catalog order within each group', () => {
    const sorted = sortUsedModelsFirst([model('a'), model('b'), model('c'), model('d')], ['d', 'b']);

    expect(sorted.map(m => m.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('formatAgentModelsBlock', () => {
  it('lists each agent with its active model first', () => {
    const lines = formatAgentModelsBlock({
      agentModels: {
        claude: { models: ['claude-y', 'claude-x'], model: 'claude-x' },
        codex: { models: ['gpt-5.4'], model: 'gpt-5.4' },
      },
    });

    expect(lines[0]).toBe('Agents:');
    expect(lines[1]).toMatch(/Claude Code\s+claude-x \(active\), claude-y/);
    expect(lines[2]).toMatch(/Codex CLI\s+gpt-5.4 \(active\)/);
  });
});

describe('runModelsList', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const catalog = [model('claude-x'), model('gpt-5.4'), model('other')];
  const fetchModels = vi.fn();

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    fetchModels.mockReset().mockResolvedValue(catalog);
    vi.spyOn(ProviderRegistry, 'getModelProxy').mockReturnValue({ fetchModels } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockConfig(extra: Record<string, unknown>): void {
    vi.spyOn(ConfigLoader, 'load').mockResolvedValue({ provider: 'litellm', ...extra } as never);
  }

  function out(): string {
    return logSpy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  const perAgent = {
    model: 'claude-x',
    agentModels: {
      claude: { models: ['claude-x'], model: 'claude-x' },
      codex: { models: ['gpt-5.4', 'claude-x'], model: 'gpt-5.4' },
    },
  };

  it('prints the Agents block and per-agent columns, used models first', async () => {
    mockConfig(perAgent);

    await runModelsList(undefined, '/work');

    const rows = out().split('\n').filter(l => /^(claude-x|gpt-5.4|other)\s/.test(l));
    expect(out()).toContain('Agents:');
    expect(out()).toMatch(/CLAUDE\s+CODEX\s+DESCRIPTION/);
    expect(rows.map(l => l.split(/\s+/)[0])).toEqual(['claude-x', 'gpt-5.4', 'other']);
    expect(rows[0]).toMatch(/active\s+✓/);
  });

  it('tags only the named agent models with --agent', async () => {
    mockConfig(perAgent);

    await runModelsList('codex', '/work');

    const lines = out().split('\n');
    expect(out()).toContain('Agent: OpenAI Codex CLI');
    expect(out()).not.toContain('Agents:');
    expect(lines.find(l => /^gpt-5.4\s/.test(l))).toContain('(active)');
    expect(lines.find(l => /^claude-x\s/.test(l))).toContain('(profile)');
    expect(lines.find(l => /^other\s/.test(l))).not.toContain('(');
    expect(out()).not.toMatch(/CLAUDE\s+CODEX/);
    // Codex's own models come first.
    expect(lines.filter(l => /^(claude-x|gpt-5.4|other)\s/.test(l)).map(l => l.split(/\s+/)[0]))
      .toEqual(['claude-x', 'gpt-5.4', 'other']);
  });

  it('fails before fetching for an agent the profile does not configure', async () => {
    mockConfig(perAgent);

    await runModelsList('pi', '/work');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('claude, codex');
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('rejects --agent on a legacy profile', async () => {
    mockConfig({ model: 'claude-x' });

    await runModelsList('claude', '/work');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('keeps the legacy (active)/(profile) tags without an Agents block', async () => {
    mockConfig({ model: 'claude-x' });

    await runModelsList(undefined, '/work');

    expect(out()).not.toContain('Agents:');
    expect(out().split('\n').find(l => /^claude-x\s/.test(l))).toContain('(active)');
  });
});
