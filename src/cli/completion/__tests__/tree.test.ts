import { describe, it, expect } from 'vitest';
import { Argument, Command, Option } from 'commander';
import { markHidden } from '@/cli/hidden.js';
import { buildModel, effectiveOptions } from '../tree.js';

function sample(): Command {
  const root = new Command('tool').version('1.2.3').option('--task <task>', 'Run a task');
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

  it('merges root options into a subcommand, deduped, node own options first', () => {
    const opts = effectiveOptions(model, list);
    const longs = opts.map(o => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--task', '--version', '--verbose', '--format']));
    expect(longs.filter(l => l === '--help')).toHaveLength(1);
    expect(opts.filter(o => o.short === '-h')).toHaveLength(1);
  });

  it('lets the node own option win over a root option with the same name', () => {
    const root = { ...model, options: [{ long: '--x', description: 'root', takesValue: 'none' as const, valueKind: 'none' as const, choices: [] }] };
    const node = { ...list, options: [{ long: '--x', description: 'own', takesValue: 'required' as const, valueKind: 'value' as const, choices: ['a'] }] };
    const opts = effectiveOptions(root, node);
    expect(opts).toHaveLength(1);
    expect(opts[0].description).toBe('own');
  });

  it('returns the root options unchanged for the root itself', () => {
    expect(effectiveOptions(model, model).map(o => o.long)).toEqual(model.options.map(o => o.long));
  });
});
