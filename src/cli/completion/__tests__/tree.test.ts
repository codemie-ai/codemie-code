import { describe, it, expect } from 'vitest';
import { Command, Option } from 'commander';
import { markHidden } from '@/cli/hidden.js';
import { buildModel } from '../tree.js';

function sample(): Command {
  const root = new Command('tool').version('1.2.3').option('--task <task>', 'Run a task');
  const list = root.command('list').alias('ls').description('List things');
  list.option('-v, --verbose', 'Verbose');
  list.addOption(new Option('--format <fmt>', 'Output format').choices(['json', 'text']));
  list.addOption(new Option('--secret', 'Secret').hideHelp());
  list.option('--out <path>', 'Output file');
  list.option('--cfg [file]', 'Config file');
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
});
