import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

  it('rejects only the bare form of a bareOnly entry, not the same flag with a value', async () => {
    const { validateCommandExample } = await import('../tips-validator.js');
    const bare: DeprecationEntry = {
      kind: 'deprecated',
      old: 'codemie analytics --include-external',
      replacement: 'codemie analytics --include-external always',
      bareOnly: true,
    };
    const p = await program();
    expect(validateCommandExample(p, 'codemie analytics --include-external', [bare]).ok).toBe(false);
    expect(validateCommandExample(p, 'codemie analytics --include-external --last 7d', [bare]).ok).toBe(false);
    expect(validateCommandExample(p, 'codemie analytics --open --include-external', [bare]).ok).toBe(false);
    expect(validateCommandExample(p, 'codemie analytics --include-external always', [bare]).ok).toBe(true);
    expect(validateCommandExample(p, 'codemie analytics --last 7d --include-external never', [bare]).ok).toBe(true);
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

/** Flags the agent wrappers (`codemie-claude`, …, built by AgentCLI outside the `codemie` tree) still offer. */
const AGENT_WRAPPER_FLAGS = ['--silent'];

/** README.md, AGENTS.md and every top-level docs/*.md; run artifacts (docs/superpowers, docs/stories, …) are not docs. */
function shippedDocs(): string[] {
  const docs = readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => join('docs', name));
  return ['README.md', 'AGENTS.md', ...docs].map((p) => join(ROOT, p));
}

describe('scanDocs', () => {
  it('finds nothing in the shipped docs and root help for the current registry', async () => {
    const { scanDocs, scanText } = await import('../tips-validator.js');
    await program();
    const paths = shippedDocs();
    expect(paths).toEqual(expect.arrayContaining([join(ROOT, 'AGENTS.md'), join(ROOT, 'docs', 'HOOKS.md')]));
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

describe('retired flags', () => {
  it('a flag no command still offers is retired; one still offered elsewhere is not', async () => {
    const { retiredFlags } = await import('../tips-validator.js');
    const { listDeprecations } = await import('../../cli/deprecation.js');
    const retired = retiredFlags(await program(), listDeprecations());
    expect(retired).toEqual(expect.arrayContaining(['--claude-code-otlp', '--copilot-cli-otlp', '--copilot-chat-otlp']));
    expect(retired).not.toContain('--force');
    expect(retired).not.toContain('--overwrite');
    expect(retiredFlags(await program(), listDeprecations(), AGENT_WRAPPER_FLAGS)).not.toContain('--silent');
  });

  it('flags a retired flag anywhere outside a marked table, never an adapter id that is not a flag', async () => {
    const { scanRetiredFlags } = await import('../tips-validator.js');
    const file = tmpFile('r.md', [
      'Run `codemie proxy connect --claude-code-otlp`.',
      'Prose: connect/disconnect --claude-code-otlp --scope user.',
      'Adapter: `codemie hook --agent claude-code-otlp`, dir `claude-code-otlp/`, bin codemie-claude-code-otlp.',
      '<!-- deprecation-table:start -->',
      '| `codemie proxy connect --claude-code-otlp` | `codemie proxy connect --claude-otlp` | 2026-12-31 |',
      '<!-- deprecation-table:end -->',
    ].join('\n'));
    const findings = scanRetiredFlags([file], ['--claude-code-otlp']);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
    expect(findings[0].reason).toContain('--claude-code-otlp');
  });

  it('no shipped doc names a retired flag outside a marked deprecation table', async () => {
    const { retiredFlags, scanRetiredFlags } = await import('../tips-validator.js');
    const { listDeprecations } = await import('../../cli/deprecation.js');
    const retired = retiredFlags(await program(), listDeprecations(), AGENT_WRAPPER_FLAGS);
    expect(scanRetiredFlags(shippedDocs(), retired)).toEqual([]);
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
