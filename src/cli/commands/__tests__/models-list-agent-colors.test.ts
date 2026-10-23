/**
 * `codemie models list` AGENTS fallback column: each agent name is colored on its own (active
 * green, available cyan), and padding ignores the color codes so DESCRIPTION stays aligned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tagging chalk: green/cyan/dim wrap text in visible markers; everything else is identity.
vi.mock('chalk', () => {
  const tag = (name: string) => (s: string): string => `<${name}>${s}</${name}>`;
  const tagged: Record<string, (s: string) => string> = { green: tag('g'), cyan: tag('c'), dim: tag('d') };
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_target, prop: string) => tagged[prop] ?? proxy,
    apply: (_target, _this, args: unknown[]) => (typeof args[0] === 'string' ? args[0] : proxy),
  });
  return { default: proxy };
});

import { formatTable } from '../models.js';
import type { ModelInfo } from '../../../providers/core/types.js';

const model = (id: string): ModelInfo => ({ id, name: id, description: 'desc' }) as ModelInfo;
const stripTags = (s: string): string => s.replace(/<\/?[gcd]>/g, '');

// Five agents force the single AGENTS column.
const agentModels = {
  claude: { models: ['shared'], model: 'claude-x' },
  codex: { models: ['shared'], model: 'shared' },
  gemini: { models: ['gemini-x'], model: 'gemini-x' },
  opencode: { models: ['shared'], model: 'shared' },
  pi: { models: ['shared'], model: 'pi-x' },
};

describe('formatTable — AGENTS column colors', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  function rowFor(id: string): string {
    const lines = logSpy.mock.calls.map(call => String(call[0]));
    return lines.find(line => stripTags(line).startsWith(id)) ?? '';
  }

  it('colors only the active agents green and the others cyan', () => {
    formatTable([model('shared')], [], undefined, agentModels);

    const row = rowFor('shared');
    expect(row).toContain('<c>claude</c><d>, </d><g>codex*</g><d>, </d><g>opencode*</g><d>, </d><c>pi</c>');
  });

  it('keeps DESCRIPTION aligned regardless of color codes', () => {
    formatTable([model('shared'), model('gemini-x'), model('none')], [], undefined, agentModels);

    const header = stripTags(String(logSpy.mock.calls[0][0]));
    const column = header.indexOf('DESCRIPTION');
    for (const id of ['shared', 'gemini-x', 'none']) {
      expect(stripTags(rowFor(id)).indexOf('desc')).toBe(column);
    }
  });

  it('cuts a list longer than the column with an ellipsis', () => {
    const long = Object.fromEntries(
      ['agent-one', 'agent-two', 'agent-three', 'agent-four', 'agent-five'].map(name => [name, { models: ['m'], model: 'other' }])
    );
    formatTable([model('m')], [], undefined, long);

    const plain = stripTags(rowFor('m'));
    expect(plain).toContain('agent-one, agent-two…');
    expect(plain).not.toContain('agent-three');
  });
});
