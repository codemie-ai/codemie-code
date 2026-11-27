import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildModel } from '@/cli/completion/tree.js';
import { emitFish } from '@/cli/completion/fish.js';
import { createProgram } from '@/cli/program.js';
import { generate } from '@/cli/completion/index.js';
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
  // Root options (--task, -V, --version) are valid only before the subcommand (positional-options mode),
  // so below the root only -h/--help is offered.
  const HELP_OPTS = ['-h', '--help'];
  const ROOT_ONLY_OPTS = ['--task', '-V', '--version'];

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

  it('subcommand offers its own options plus -h/--help, no hidden', () => {
    expect(complete('tool list -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...HELP_OPTS])
    );
  });

  it('alias descends to the same node', () => {
    expect(complete('tool ls --v')).toEqual(['--verbose']);
  });

  it('nested node offers its children, hidden absent', () => {
    expect(complete('tool a ')).toEqual(['b', 'help']);
    expect(complete('tool a -')).toEqual(sorted(HELP_OPTS));
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
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...HELP_OPTS])
    );
  });

  it('does not offer root options below the root (positional-options mode)', () => {
    for (const line of ['tool list -', 'tool a -', 'tool a b c -']) {
      const out = complete(line);
      for (const o of ROOT_ONLY_OPTS) expect(out, line).not.toContain(o);
    }
    expect(complete('tool list --ver')).toEqual(['--verbose']);
    expect(complete('tool list --ta')).toEqual([]);
    expect(complete('tool -')).toEqual(expect.arrayContaining(ROOT_ONLY_OPTS));
  });

  it('treats -- as end-of-options: nothing is offered after it', () => {
    expect(complete('tool list -- ')).toEqual([]);
    expect(complete('tool list -- -')).toEqual([]);
    expect(complete('tool -- a ')).toEqual([]);
    expect(complete('tool -- l')).toEqual([]);
  });

  it('a valued option still consumes a -- that is its value (walker state)', () => {
    // fish itself suppresses option completion after a literal `--`, so check the walker directly.
    const state = (words: string[]): string => {
      const r = spawnSync(
        'fish',
        ['--no-config', '-c', 'source $argv[1]; set -g WORDS $argv[2..-1]; function commandline; printf "%s\\n" $WORDS; end; __tool_state', script, ...words],
        { cwd: dir, encoding: 'utf8' }
      );
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    expect(state(['tool', 'list', '--name', '--'])).toBe('1');
    expect(state(['tool', 'list', '--'])).toBe('end');
    expect(state(['tool', '--', 'a'])).toBe('end');
  });

  it('offers positional choices at a leaf, along with its options', () => {
    expect(complete('tool a b c ')).toEqual(sorted(['red', 'green', 'two words']));
    expect(complete('tool a b c r')).toEqual(['red']);
  });

  it('does not offer positional choices at nodes that have subcommands', () => {
    expect(complete('tool a b ')).not.toContain('red');
  });

  it('never offers hidden names anywhere', () => {
    for (const w of ['tool ', 'tool list ', 'tool a ']) {
      expect(complete(w).join(' ')).not.toMatch(/internal|secret|zz/);
    }
  });

  it('the real CLI offers exactly bash zsh fish for `codemie completion <Tab>`', () => {
    const real = join(dir, 'codemie.fish');
    writeFileSync(real, generate('fish', createProgram()));
    const r = spawnSync('fish', ['--no-config', '-c', 'source $argv[1]; complete -C $argv[2]', real, 'codemie completion '], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const got = r.stdout.split('\n').filter(l => l !== '').map(l => l.split('\t')[0]).sort();
    expect(got).toEqual(['bash', 'fish', 'zsh']);
  });
});
