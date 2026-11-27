import { describe, it, expect } from 'vitest';
import { Argument, Command, Option } from 'commander';
import { markHidden } from '@/cli/hidden.js';
import { createProgram } from '@/cli/program.js';
import { buildModel, effectiveOptions } from '../tree.js';

function sample(): Command {
  const root = new Command('tool').enablePositionalOptions().version('1.2.3').option('--task <task>', 'Run a task');
  const list = root.command('list').alias('ls').description('List things');
  list.option('-v, --verbose', 'Verbose');
  list.addOption(new Option('--format <fmt>', 'Output format').choices(['json', 'text']));
  list.addOption(new Option('--secret', 'Secret').hideHelp());
  list.option('--out <path>', 'Output file');
  list.option('--cfg [file]', 'Config file');
  list.option('--target <thing>', 'Some value');
  const hiddenCmd = root.command('internal');
  markHidden(hiddenCmd);
  const a = root.command('a');
  const b = a.command('b');
  b.command('c').option('--deep', 'Deep');
  return root;
}

describe('buildModel', () => {
  const model = buildModel(sample());
  const sub = (n: { subs: { name: string }[] }, name: string) =>
    n.subs.find(s => s.name === name) as ReturnType<typeof buildModel>;

  it('uses the root command name and omits hidden commands', () => {
    expect(model.name).toBe('tool');
    expect(model.subs.map(s => s.name)).toEqual(expect.arrayContaining(['list', 'a', 'help']));
    expect(model.subs.map(s => s.name)).not.toContain('internal');
  });

  it('keeps aliases and descriptions', () => {
    const list = sub(model, 'list');
    expect(list.aliases).toEqual(['ls']);
    expect(list.description).toBe('List things');
  });

  it('omits hidden options and reads choices', () => {
    const list = sub(model, 'list');
    expect(list.options.find(o => o.long === '--secret')).toBeUndefined();
    expect(list.options.find(o => o.long === '--format')?.choices).toEqual(['json', 'text']);
  });

  it('classifies takesValue and valueKind', () => {
    const list = sub(model, 'list');
    const get = (l: string) => list.options.find(o => o.long === l)!;
    expect(get('--verbose')).toMatchObject({ short: '-v', takesValue: 'none', valueKind: 'none' });
    expect(get('--format')).toMatchObject({ takesValue: 'required', valueKind: 'value' });
    expect(get('--out')).toMatchObject({ takesValue: 'required', valueKind: 'path' });
    expect(get('--cfg')).toMatchObject({ takesValue: 'optional', valueKind: 'path' });
    expect(get('--target')).toMatchObject({ takesValue: 'required', valueKind: 'path' });
  });

  it('adds -h/--help on every node and an implicit help sub', () => {
    const walk = (n: ReturnType<typeof buildModel>): void => {
      expect(n.options.some(o => o.short === '-h' && o.long === '--help')).toBe(true);
      n.subs.forEach(walk);
    };
    walk(model);
    expect(sub(model, 'help')).toBeDefined();
  });

  it('has -V/--version only on the root', () => {
    const has = (n: ReturnType<typeof buildModel>): boolean => n.options.some(o => o.long === '--version');
    expect(has(model)).toBe(true);
    expect(model.options.some(o => o.long === '--task')).toBe(true);
    expect(has(sub(model, 'list'))).toBe(false);
  });

  it('supports depth 3 and option-only leaves', () => {
    const c = sub(sub(sub(model, 'a'), 'b'), 'c');
    expect(c.subs).toEqual([]);
    expect(c.options.some(o => o.long === '--deep')).toBe(true);
  });

  it('models the first positional argument choices; none otherwise', () => {
    const root = new Command('tool');
    root.command('pick').addArgument(new Argument('<what>').choices(['x', 'y']));
    root.command('plain').argument('<free>');
    const m = buildModel(root);
    const get = (n: string) => m.subs.find(s => s.name === n)!;
    expect(get('pick').positionalChoices).toEqual(['x', 'y']);
    expect(get('plain').positionalChoices).toEqual([]);
    expect(get('help').positionalChoices).toEqual([]);
    expect(m.positionalChoices).toEqual([]);
  });
});

describe('effectiveOptions', () => {
  const model = buildModel(sample());
  const list = model.subs.find(s => s.name === 'list') as typeof model;
  const longsOf = (n: typeof model): (string | undefined)[] => effectiveOptions(n).map(o => o.long);

  it('returns only the node own options below the root (no root options)', () => {
    const longs = longsOf(list);
    expect(longs).toEqual(expect.arrayContaining(['--verbose', '--format', '--help']));
    expect(longs).not.toContain('--task');
    expect(longs).not.toContain('--version');
    expect(effectiveOptions(list).some(o => o.short === '-V')).toBe(false);
    expect(longs.filter(l => l === '--help')).toHaveLength(1);
  });

  it('keeps all root options at the root', () => {
    expect(longsOf(model)).toEqual(expect.arrayContaining(['--task', '--version', '--help']));
    expect(longsOf(model)).toEqual(model.options.map(o => o.long));
  });

  it('pins the premise: with positional options, a root option after a subcommand is unknown', () => {
    const program = sample();
    program.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    program.commands.forEach(c => c.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined }));
    expect(() => program.parse(['node', 'tool', 'list', '--version'])).toThrow(/unknown option '--version'/);
    expect(() => program.parse(['node', 'tool', 'list', '-V'])).toThrow(/unknown option '-V'/);
  });
});

describe('real createProgram() tree', () => {
  const model = buildModel(createProgram());
  const find = (...path: string[]): typeof model => {
    let node = model;
    for (const name of path) node = node.subs.find(s => s.name === name) as typeof model;
    expect(node, path.join(' ')).toBeDefined();
    return node;
  };

  it('offers --task, -V and --version at the root', () => {
    const opts = effectiveOptions(model);
    expect(opts.some(o => o.long === '--task')).toBe(true);
    expect(opts.some(o => o.long === '--version' && o.short === '-V')).toBe(true);
  });

  it.each([['proxy', 'status'], ['list'], ['doctor']])('does not offer root options at %s', (...path) => {
    const opts = effectiveOptions(find(...path));
    expect(opts.some(o => o.long === '--version' || o.short === '-V' || o.long === '--task')).toBe(false);
    expect(opts.some(o => o.long === '--help')).toBe(true);
  });
});
