import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildModel } from '@/cli/completion/tree.js';
import { emitBash } from '@/cli/completion/bash.js';
import { createProgram } from '@/cli/program.js';
import { generate } from '@/cli/completion/index.js';
import { buildFixtureRoot } from '../../helpers/completion-fixtures.js';

const bashPath = process.platform === 'win32' ? undefined : spawnSync('bash', ['--version']).status === 0 ? 'bash' : undefined;
const missing = !bashPath && process.platform !== 'win32';
if (missing && process.env.CI === 'true') {
  describe('bash completion (real bash)', () => {
    it('requires bash in CI', () => {
      throw new Error('bash is not installed but CI=true: bash completion tests cannot be skipped');
    });
  });
}
const suite = bashPath ? describe : describe.skip;
if (!bashPath && process.env.CI !== 'true') {
  console.warn(`[skip] bash completion tests: ${process.platform === 'win32' ? 'win32' : 'bash not found'}`);
}

const HARNESS = `source "$1"; fn="$2"; n="$3"; shift 3
COMP_WORDS=("$@"); COMP_CWORD=$n; COMP_LINE="$*"; COMP_POINT=\${#COMP_LINE}; COMPREPLY=()
"$fn"
for r in "\${COMPREPLY[@]}"; do printf '%s\\n' "$r"; done`;

suite('bash completion (real bash)', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bashcomp-'));
    script = join(dir, 'tool.bash');
    writeFileSync(script, emitBash(buildModel(buildFixtureRoot()), '1.0.0'));
    writeFileSync(join(dir, 'alpha.txt'), '');
    return () => rmSync(dir, { recursive: true, force: true });
  });

  /** words: full command line; the last word is the one being completed. */
  function complete(words: string[]): string[] {
    const r = spawnSync('bash', ['-c', HARNESS, 'harness', script, '_tool', String(words.length - 1), ...words], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    return r.stdout.split('\n').filter(l => l !== '').sort();
  }
  const sorted = (a: string[]): string[] => [...a].sort();
  const ROOT_OPTS = ['--task', '-V', '--version', '-h', '--help'];
  // Root options (--task, -V, --version) are valid only before the subcommand (positional-options mode),
  // so below the root only -h/--help is offered.
  const HELP_OPTS = ['-h', '--help'];
  const ROOT_ONLY_OPTS = ['--task', '-V', '--version'];

  it('script is valid bash and registers the function', () => {
    const r = spawnSync('bash', ['-c', `source "${script}" && complete -p tool`], { encoding: 'utf8' });
    expect(r.stdout).toContain('-F _tool tool');
  });

  it('root offers subcommands, aliases, help and the root options', () => {
    expect(complete(['tool', ''])).toEqual(sorted(['list', 'ls', 'a', 'help', ...ROOT_OPTS]));
  });

  it('filters by the typed prefix', () => {
    expect(complete(['tool', 'l'])).toEqual(['list', 'ls']);
  });

  it('subcommand offers its own options plus -h/--help, no hidden', () => {
    expect(complete(['tool', 'list', '-'])).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...HELP_OPTS])
    );
  });

  it('alias descends to the same node', () => {
    expect(complete(['tool', 'ls', '--v'])).toEqual(['--verbose']);
  });

  it('nested node offers its children, hidden absent', () => {
    expect(complete(['tool', 'a', ''])).toEqual(sorted(['b', 'help', ...HELP_OPTS]));
  });

  it('leaf offers only its options', () => {
    expect(complete(['tool', 'a', 'b', 'c', '--d'])).toEqual(['--deep']);
  });

  it('skips option words while walking', () => {
    expect(complete(['tool', '--version', 'a', 'b', ''])).toEqual(sorted(['c', 'help', ...HELP_OPTS]));
  });

  it('a valued option consumes the next word when walking', () => {
    expect(complete(['tool', '--task', 'x', 'a', ''])).toEqual(sorted(['b', 'help', ...HELP_OPTS]));
  });

  it('does not descend into unknown words', () => {
    expect(complete(['tool', 'bogus', 'l'])).toEqual(['list', 'ls']);
  });

  it('offers choices after a valued option, including values with spaces', () => {
    expect(complete(['tool', 'list', '--format', ''])).toEqual(sorted(['json', 'text', 'two words']));
    expect(complete(['tool', 'list', '--format', 't'])).toEqual(sorted(['text', 'two words']));
  });

  it('offers files only for path options', () => {
    expect(complete(['tool', 'list', '--out', 'al'])).toEqual(['alpha.txt']);
  });

  it('falls back to file completion after a valued option without choices', () => {
    expect(complete(['tool', 'list', '--name', 'al'])).toEqual(['alpha.txt']);
  });

  it('optional-value options do not consume the next word', () => {
    expect(complete(['tool', 'list', '--cfg', 'a', 'x'])).toEqual([]);
    expect(complete(['tool', 'list', '--cfg', ''])).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...HELP_OPTS])
    );
  });

  it('does not offer root options below the root (positional-options mode)', () => {
    for (const words of [['tool', 'list', '-'], ['tool', 'a', '-'], ['tool', 'a', 'b', 'c', '-']]) {
      const out = complete(words);
      for (const o of ROOT_ONLY_OPTS) expect(out, words.join(' ')).not.toContain(o);
    }
    expect(complete(['tool', 'list', '--ver'])).toEqual(['--verbose']);
    expect(complete(['tool', 'list', '--ta'])).toEqual([]);
    expect(complete(['tool', '-'])).toEqual(expect.arrayContaining(ROOT_ONLY_OPTS));
  });

  it('treats -- as end-of-options: nothing is offered after it', () => {
    expect(complete(['tool', 'list', '--', ''])).toEqual([]);
    expect(complete(['tool', 'list', '--', '-'])).toEqual([]);
    expect(complete(['tool', '--', 'a', ''])).toEqual([]);
    expect(complete(['tool', '--', 'l'])).toEqual([]);
  });

  it('a valued option still consumes a -- that is its value', () => {
    expect(complete(['tool', 'list', '--name', '--', '-'])).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...HELP_OPTS])
    );
  });

  it('offers positional choices at a leaf, along with its options', () => {
    expect(complete(['tool', 'a', 'b', 'c', ''])).toEqual(sorted(['red', 'green', 'two words', '--deep', ...HELP_OPTS]));
    expect(complete(['tool', 'a', 'b', 'c', 'r'])).toEqual(['red']);
  });

  it('does not offer positional choices at nodes that have subcommands', () => {
    expect(complete(['tool', 'a', 'b', ''])).not.toContain('red');
  });

  it('never offers hidden names anywhere', () => {
    for (const w of [['tool', ''], ['tool', 'list', ''], ['tool', 'a', '']]) {
      const got = complete(w).join(' ');
      expect(got).not.toMatch(/internal|secret|zz/);
    }
  });

  it('the real CLI offers exactly bash zsh fish for `codemie completion <Tab>`', () => {
    const real = join(dir, 'codemie.bash');
    writeFileSync(real, generate('bash', createProgram()));
    const r = spawnSync('bash', ['-c', HARNESS, 'harness', real, '_codemie', '2', 'codemie', 'completion', ''], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const got = r.stdout.split('\n').filter(l => l !== '' && !l.startsWith('-')).sort();
    expect(got).toEqual(['bash', 'fish', 'zsh']);
  });
});
