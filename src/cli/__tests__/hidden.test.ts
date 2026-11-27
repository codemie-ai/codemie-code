import { describe, it, expect } from 'vitest';
import { Command, Option } from 'commander';
import { isHiddenCommand, isHiddenOption, markHidden } from '../hidden.js';
import { deprecatedCommand, removedCommand } from '../deprecation.js';

describe('hidden helpers', () => {
  it('detects commands registered with addCommand hidden', () => {
    const root = new Command('root');
    const a = new Command('a');
    const b = new Command('b');
    root.addCommand(a, { hidden: true });
    root.addCommand(b);
    expect(isHiddenCommand(a)).toBe(true);
    expect(isHiddenCommand(b)).toBe(false);
  });

  it('detects deprecated and removed command stubs', () => {
    const dep = deprecatedCommand({ kind: 'deprecated', old: 'x', replacement: 'y' }, 'x');
    const rem = removedCommand({ kind: 'removed', old: 'z', replacement: 'y' }, 'z');
    expect(isHiddenCommand(dep)).toBe(true);
    expect(isHiddenCommand(rem)).toBe(true);
  });

  it('markHidden hides a command', () => {
    const c = new Command('c');
    expect(isHiddenCommand(c)).toBe(false);
    markHidden(c);
    expect(isHiddenCommand(c)).toBe(true);
  });

  it('detects hidden options', () => {
    expect(isHiddenOption(new Option('--a').hideHelp())).toBe(true);
    expect(isHiddenOption(new Option('--b'))).toBe(false);
  });
});
