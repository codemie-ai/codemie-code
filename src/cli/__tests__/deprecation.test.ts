import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import {
  DEPRECATION_REMOVE_ON,
  deprecate,
  deprecatedOption,
  deprecatedCommand,
  removedCommand,
  removedOption,
  listDeprecations,
} from '../deprecation.js';

const entry = { kind: 'deprecated' as const, old: 'codemie old-thing', replacement: 'codemie new-thing' };

describe('deprecation', () => {
  let write: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });
  afterEach(() => {
    write.mockRestore();
    process.exitCode = undefined;
  });

  it('deprecate writes one stderr line with old, replacement and removal date', () => {
    deprecate(entry, { json: false });
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0][0]);
    expect(line).toContain('codemie old-thing');
    expect(line).toContain('codemie new-thing');
    expect(line).toContain(DEPRECATION_REMOVE_ON);
    expect(line.trim().split('\n')).toHaveLength(1);
  });

  it('deprecate still writes under json', () => {
    deprecate(entry, { json: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('deprecate is silent in a hook context', () => {
    const argv = process.argv;
    process.argv = ['node', 'codemie', 'hook'];
    try {
      deprecate(entry);
    } finally {
      process.argv = argv;
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('deprecatedOption is hidden from help and registers its entry', () => {
    const cmd = new Command('x').addOption(
      deprecatedOption({ ...entry, old: '--legacy' }, '--legacy', 'legacy flag')
    );
    expect(cmd.helpInformation()).not.toContain('--legacy');
    expect(listDeprecations().some((e) => e.old === '--legacy')).toBe(true);
  });

  it('deprecatedCommand is hidden and calls deprecate before action', async () => {
    const parent = new Command('p');
    const sub = deprecatedCommand({ ...entry, old: 'p legacy-cmd' }, 'legacy-cmd').action(() => {});
    parent.addCommand(sub);
    expect(parent.helpInformation()).not.toContain('legacy-cmd');
    await parent.parseAsync(['legacy-cmd'], { from: 'user' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain('p legacy-cmd');
  });

  it('removedCommand fails naming the replacement with exitCode 1', async () => {
    const parent = new Command('p');
    parent.addCommand(
      removedCommand({ kind: 'removed', old: 'p gone', replacement: 'p fresh' }, 'gone')
    );
    await parent.parseAsync(['gone', '--whatever', 'extra'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(String(write.mock.calls[0][0])).toContain('p fresh');
  });

  it('using a removedOption sets exitCode 1 naming the replacement', async () => {
    const cmd = new Command('x')
      .addOption(removedOption({ kind: 'removed', old: '--gone', replacement: '--fresh' }, '--gone'))
      .action(() => {});
    expect(cmd.helpInformation()).not.toContain('--gone');
    await cmd.parseAsync(['--gone'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(String(write.mock.calls[0][0])).toContain('--fresh');
  });
});
