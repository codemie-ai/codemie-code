import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeprecationEntry } from '../../cli/deprecation.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const OLD: DeprecationEntry = {
  kind: 'deprecated',
  old: 'codemie proxy status --deep',
  replacement: 'codemie proxy inspect',
};

async function program() {
  const { createProgram } = await import('../../cli/program.js');
  return createProgram();
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tips-validator-'));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe('validateCommandExample', () => {
  it('accepts a valid command', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    expect(validateCommandExample(await program(), 'codemie proxy status --json')).toEqual({ ok: true });
  });

  it('rejects an unknown subcommand', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    const r = validateCommandExample(await program(), 'codemie proxy nope');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown flag', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    const r = validateCommandExample(await program(), 'codemie proxy status --bogus');
    expect(r.ok).toBe(false);
  });

  it('rejects a registered deprecated form', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    const r = validateCommandExample(await program(), 'codemie proxy status --deep', [OLD]);
    expect(r.ok).toBe(false);
  });

  it('ignores examples that are not codemie commands', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    expect(validateCommandExample(await program(), 'codemie-claude --status')).toEqual({ ok: true });
  });

  it('every tips.json entry passes', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    const { TIPS } = await import('../tips.js');
    const p = await program();
    const bad: string[] = [];
    for (const tip of TIPS) {
      for (const c of tip.commands ?? []) {
        const r = validateCommandExample(p, c);
        if (!r.ok) bad.push(`${tip.id}: ${c} (${r.reason})`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('scanDocs', () => {
  it('finds nothing in the shipped docs and root help for the current registry', async () => {
    const { scanDocs, scanText } = await import('../tips-validator.js');
    const paths = ['README.md', 'docs/COMMANDS.md', 'docs/ARCHITECTURE-PROXY.md', 'docs/ANALYTICS-REPORT.md', 'docs/ANALYTICS-SYNC.md'].map(p => join(ROOT, p));
    expect(scanDocs(paths)).toEqual([]);
    const p = await program();
    let help = '';
    p.configureOutput({ writeOut: s => { help += s; } });
    p.outputHelp();
    expect(scanText('root-help', help)).toEqual([]);
  });

  it('flags a registered old form in code spans and fences but skips marked blocks', async () => {
    const { scanDocs } = await import('../tips-validator.js');
    const file = tmpFile('a.md', [
      'Use `codemie proxy status --deep` now.',
      '```bash',
      'codemie proxy status --deep',
      '```',
      '<!-- deprecation-table:start -->',
      '| `codemie proxy status --deep` | `codemie proxy inspect` | 2026-12-31 |',
      '<!-- deprecation-table:end -->',
      'Plain prose mentioning codemie proxy status --deep is not a command.',
    ].join('\n'));
    const findings = scanDocs([file], [OLD]);
    expect(findings.map(f => f.line)).toEqual([1, 3]);
  });
});

describe('checkDeprecationTables', () => {
  const block = (rows: string[]): string => [
    '<!-- deprecation-table:start -->',
    '| Old | New | Removal |',
    '| --- | --- | --- |',
    ...rows,
    '<!-- deprecation-table:end -->',
  ].join('\n');

  it('passes with no block and empty registry, and skips missing files', async () => {
    const { checkDeprecationTables } = await import('../tips-validator.js');
    const file = tmpFile('c.md', '# nothing');
    expect(checkDeprecationTables([file, '/nonexistent/x.md'], [])).toEqual([]);
  });

  it('passes when rows and registry match', async () => {
    const { checkDeprecationTables } = await import('../tips-validator.js');
    const file = tmpFile('c.md', block(['| `codemie proxy status --deep` | `codemie proxy inspect` | 2026-12-31 |']));
    expect(checkDeprecationTables([file], [OLD])).toEqual([]);
  });

  it('flags a row without a registry entry and a registry entry without a row', async () => {
    const { checkDeprecationTables } = await import('../tips-validator.js');
    const file = tmpFile('c.md', block(['| `codemie foo` | `codemie bar` | 2026-12-31 |']));
    expect(checkDeprecationTables([file], [OLD])).toHaveLength(2);
  });

  it('shipped CHANGELOG and PROXY-AND-ANALYTICS pass', async () => {
    const { checkDeprecationTables } = await import('../tips-validator.js');
    const { listDeprecations } = await import('../../cli/deprecation.js');
    await program();
    const paths = ['CHANGELOG.md', 'docs/PROXY-AND-ANALYTICS.md'].map(p => join(ROOT, p));
    expect(checkDeprecationTables(paths, listDeprecations())).toEqual([]);
  });
});
