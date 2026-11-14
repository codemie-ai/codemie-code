/**
 * Tests for the section renderer of `codemie proxy analytics status`.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { formatReportRows, formatReportSection } from '../analytics-report.js';

const plain = (lines: string[]): string[] => lines.map((line) => stripAnsi(line));

describe('formatReportSection', () => {
  it('renders the heading bold and each row white, indented by 2 spaces', () => {
    const lines = formatReportSection('Claude', [{ message: 'Hooks: installed' }]);

    expect(lines).toEqual([chalk.bold('Claude:'), chalk.white('  Hooks: installed')]);
  });

  it('puts every item on its own line at 4 spaces, under its row', () => {
    const lines = formatReportSection('Claude', [
      { message: 'Tracked:', items: ['owner/repo', 'Repositories/codemie'] },
      { message: 'Collection: enabled' },
    ]);

    expect(plain(lines)).toEqual([
      'Claude:',
      '  Tracked:',
      '    owner/repo',
      '    Repositories/codemie',
      '  Collection: enabled',
    ]);
  });

  it('puts a hint on its own line at 6 spaces, and no line when there is none', () => {
    const lines = formatReportSection('Claude', [
      { message: 'Hooks: not installed', hint: 'Run: codemie proxy connect --claude-code-otlp' },
      { message: 'Scope: not-configured' },
    ]);

    expect(plain(lines)).toEqual([
      'Claude:',
      '  Hooks: not installed',
      '      Run: codemie proxy connect --claude-code-otlp',
      '  Scope: not-configured',
    ]);
  });

  it('puts an empty line before the footer and indents it like a row', () => {
    const lines = formatReportSection('Copilot', [{ message: 'Connected: yes' }], 'These settings do not affect X.');

    expect(plain(lines)).toEqual(['Copilot:', '  Connected: yes', '', '  These settings do not affect X.']);
  });

  it('dims the footer and keeps the empty line before it', () => {
    const lines = formatReportSection('Copilot', [{ message: 'Connected: yes' }], 'These settings do not affect X.');

    expect(lines.slice(2)).toEqual(['', chalk.dim('  These settings do not affect X.')]);
  });

  it('uses no icons or glyphs', () => {
    const text = plain(
      formatReportSection('Claude', [{ message: 'Hooks: not installed', hint: 'Run: y' }], 'footer')
    ).join('\n');

    for (const glyph of ['✓', '○', '⚠', '✗']) {
      expect(text).not.toContain(glyph);
    }
  });
});

describe('formatReportRows', () => {
  it('prints rows flush left with no heading, items 2 and hints 4 spaces further in', () => {
    const lines = formatReportRows([
      { message: 'Delivery: unhealthy (x)', hint: 'Run: y' },
      { message: 'Tracked:', items: ['owner/repo'] },
    ]);

    expect(plain(lines)).toEqual(['Delivery: unhealthy (x)', '    Run: y', 'Tracked:', '  owner/repo']);
  });

  it('keeps a row white around text that carries its own color', () => {
    expect(formatReportRows([{ message: `Delivery: ${chalk.green('healthy')}` }])).toEqual([
      chalk.white(`Delivery: ${chalk.green('healthy')}`),
    ]);
  });
});
