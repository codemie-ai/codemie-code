import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildModel } from '@/cli/completion/tree.js';
import { emitFish } from '@/cli/completion/fish.js';
import { buildFixtureRoot } from '../../helpers/completion-fixtures.js';

const fishPath = process.platform === 'win32' ? undefined : spawnSync('fish', ['--version']).status === 0 ? 'fish' : undefined;
const missing = !fishPath && process.platform !== 'win32';
if (missing && process.env.CI === 'true') {
  describe('fish completion (real fish)', () => {
    it('requires fish in CI', () => {
      throw new Error('fish is not installed but CI=true: fish completion tests cannot be skipped');
    });
  });
}
const suite = fishPath ? describe : describe.skip;
if (!fishPath && process.env.CI !== 'true') {
  console.warn(`[skip] fish completion tests: ${process.platform === 'win32' ? 'win32' : 'fish not found'}`);
}

suite('fish completion (real fish)', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fishcomp-'));
    script = join(dir, 'tool.fish');
    writeFileSync(script, emitFish(buildModel(buildFixtureRoot()), '1.0.0'));
    writeFileSync(join(dir, 'alpha.txt'), '');
    return () => rmSync(dir, { recursive: true, force: true });
  });

  /** line: command line up to the cursor. Returns raw lines `name[\tdescription]`. */
  function raw(line: string): string[] {
    const r = spawnSync('fish', ['--no-config', '-c', 'source $argv[1]; complete -C $argv[2]', script, line], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    return r.stdout.split('\n').filter(l => l !== '');
  }
  const complete = (line: string): string[] => raw(line).map(l => l.split('\t')[0]).sort();
  const sorted = (a: string[]): string[] => [...a].sort();
  const ROOT_OPTS = ['--task', '-V', '--version', '-h', '--help'];

  // Fish only offers options once the word being completed starts with '-'.
  it('root offers subcommands, aliases and help; options after a dash', () => {
    expect(complete('tool ')).toEqual(sorted(['list', 'ls', 'a', 'help']));
    expect(complete('tool -')).toEqual(sorted(ROOT_OPTS));
  });

  it('filters by the typed prefix', () => {
    expect(complete('tool l')).toEqual(['list', 'ls']);
  });

  it('alias shows the same description as its command', () => {
    const lines = raw('tool l');
    const desc = (n: string): string | undefined => lines.find(l => l.startsWith(`${n}\t`))?.split('\t')[1];
    expect(desc('list')).toBeTruthy();
    expect(desc('ls')).toBe(desc('list'));
  });

  it('subcommand offers its options plus root options, no hidden', () => {
    expect(complete('tool list -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...ROOT_OPTS])
    );
  });

  it('alias descends to the same node', () => {
    expect(complete('tool ls --v')).toEqual(['--verbose', '--version']);
  });

  it('nested node offers its children, hidden absent', () => {
    expect(complete('tool a ')).toEqual(['b', 'help']);
    expect(complete('tool a -')).toEqual(sorted(ROOT_OPTS));
  });

  it('leaf offers only its options', () => {
    expect(complete('tool a b c --d')).toEqual(['--deep']);
  });

  it('skips option words while walking', () => {
    expect(complete('tool --version a b ')).toEqual(['c', 'help']);
  });

  it('a valued option consumes the next word when walking', () => {
    expect(complete('tool --task x a ')).toEqual(['b', 'help']);
  });

  it('does not descend into unknown words', () => {
    expect(complete('tool bogus l')).toEqual(['list', 'ls']);
  });

  it('offers choices after a valued option, including values with spaces', () => {
    expect(complete('tool list --format ')).toEqual(sorted(['json', 'text', 'two words']));
    expect(complete('tool list --format t')).toEqual(sorted(['text', 'two words']));
  });

  it('offers files only for path options', () => {
    expect(complete('tool list --out al')).toEqual(['alpha.txt']);
  });

  it('falls back to file completion after a valued option without choices', () => {
    expect(complete('tool list --name al')).toEqual(['alpha.txt']);
  });

  it('optional-value options do not consume the next word', () => {
    expect(complete('tool list --cfg a x')).toEqual([]);
    expect(complete('tool list --cfg -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...ROOT_OPTS])
    );
  });

  it('root option accepted after a subcommand takes its value', () => {
    expect(complete('tool list --task ')).toEqual([]);
  });

  it('never offers hidden names anywhere', () => {
    for (const w of ['tool ', 'tool list ', 'tool a ']) {
      expect(complete(w).join(' ')).not.toMatch(/internal|secret|zz/);
    }
  });
});
