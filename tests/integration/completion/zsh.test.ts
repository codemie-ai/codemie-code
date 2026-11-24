import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildModel } from '@/cli/completion/tree.js';
import { emitZsh } from '@/cli/completion/zsh.js';
import { createProgram } from '@/cli/program.js';
import { generate } from '@/cli/completion/index.js';
import { buildFixtureRoot } from '../../helpers/completion-fixtures.js';
import { startZsh, type ZshSession } from '../../helpers/zsh-pty.js';

const zshPath = process.platform === 'win32' ? undefined : spawnSync('zsh', ['--version']).status === 0 ? 'zsh' : undefined;
const missing = !zshPath && process.platform !== 'win32';
if (missing && process.env.CI === 'true') {
  describe('zsh completion (real zsh)', () => {
    it('requires zsh in CI', () => {
      throw new Error('zsh is not installed but CI=true: zsh completion tests cannot be skipped');
    });
  });
}
const suite = zshPath ? describe : describe.skip;
if (!zshPath && process.env.CI !== 'true') {
  console.warn(`[skip] zsh completion tests: ${process.platform === 'win32' ? 'win32' : 'zsh not found'}`);
}

suite('zsh completion (real zsh)', () => {
  let dir: string;
  let script: string;
  let src: ZshSession;
  let auto: ZshSession;
  let real: ZshSession;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zshcomp-'));
    script = join(dir, 'tool.zsh');
    writeFileSync(script, emitZsh(buildModel(buildFixtureRoot()), '1.0.0'));
    writeFileSync(join(dir, 'alpha.txt'), '');
    src = await startZsh({ script, name: 'tool', cwd: dir, mode: 'source' });
    auto = await startZsh({ script, name: 'tool', cwd: dir, mode: 'autoload' });
    const realScript = join(dir, 'codemie.zsh');
    writeFileSync(realScript, generate('zsh', createProgram()));
    real = await startZsh({ script: realScript, name: 'codemie', cwd: dir, mode: 'source' });
  }, 60000);
  afterAll(() => {
    src?.close();
    auto?.close();
    real?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const complete = async (line: string): Promise<string[]> => (await src.complete(line)).sort();
  const sorted = (a: string[]): string[] => [...a].sort();
  const ROOT_OPTS = ['--task', '-V', '--version', '-h', '--help'];

  it('source registers the function with compdef', async () => {
    expect(await src.expr('$_comps[tool]')).toBe('_tool');
  });

  it('autoloaded from fpath registers and completes', async () => {
    expect(await auto.expr('$_comps[tool]')).toBe('_tool');
    expect((await auto.complete('tool ')).sort()).toEqual(sorted(['list', 'ls', 'a', 'help', ...ROOT_OPTS]));
  });

  it('root offers subcommands, aliases, help and root options', async () => {
    expect(await complete('tool ')).toEqual(sorted(['list', 'ls', 'a', 'help', ...ROOT_OPTS]));
  });

  it('filters by the typed prefix', async () => {
    expect(await complete('tool l')).toEqual(['list', 'ls']);
  });

  it('subcommand offers its options plus root options, no hidden', async () => {
    expect(await complete('tool list -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...ROOT_OPTS])
    );
  });

  it('alias descends to the same node', async () => {
    expect(await complete('tool ls --v')).toEqual(['--verbose', '--version']);
  });

  it('nested node offers its children, hidden absent', async () => {
    expect(await complete('tool a ')).toEqual(sorted(['b', 'help', ...ROOT_OPTS]));
  });

  it('leaf offers only its options', async () => {
    expect(await complete('tool a b c --d')).toEqual(['--deep']);
  });

  it('skips option words while walking', async () => {
    expect(await complete('tool --version a b ')).toEqual(sorted(['c', 'help', ...ROOT_OPTS]));
  });

  it('a valued option consumes the next word when walking', async () => {
    expect(await complete('tool --task x a ')).toEqual(sorted(['b', 'help', ...ROOT_OPTS]));
  });

  it('does not descend into unknown words', async () => {
    expect(await complete('tool bogus l')).toEqual(['list', 'ls']);
  });

  it('offers choices after a valued option, including values with spaces', async () => {
    expect(await complete('tool list --format ')).toEqual(sorted(['json', 'text', 'two words']));
    expect(await complete('tool list --format t')).toEqual(sorted(['text', 'two words']));
  });

  it('offers files only for path options', async () => {
    expect(await complete('tool list --out al')).toEqual(['alpha.txt']);
  });

  it('falls back to file completion after a valued option without choices', async () => {
    expect(await complete('tool list --name al')).toEqual(['alpha.txt']);
  });

  it('optional-value options do not consume the next word', async () => {
    expect(await complete('tool list --cfg a x')).toEqual([]);
    expect(await complete('tool list --cfg -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...ROOT_OPTS])
    );
  });

  it('root option accepted after a subcommand takes its value', async () => {
    expect(await complete('tool list --task ')).toEqual([]);
  });

  it('treats -- as end-of-options: nothing is offered after it', async () => {
    expect(await complete('tool list -- ')).toEqual([]);
    expect(await complete('tool list -- -')).toEqual([]);
    expect(await complete('tool -- a ')).toEqual([]);
    expect(await complete('tool -- l')).toEqual([]);
  });

  it('a valued option still consumes a -- that is its value', async () => {
    expect(await complete('tool list --name -- -')).toEqual(
      sorted(['-v', '--verbose', '--format', '--out', '--cfg', '--name', ...ROOT_OPTS])
    );
  });

  it('offers positional choices at a leaf, along with its options', async () => {
    expect(await complete('tool a b c ')).toEqual(sorted(['red', 'green', 'two words', '--deep', ...ROOT_OPTS]));
    expect(await complete('tool a b c r')).toEqual(['red']);
  });

  it('does not offer positional choices at nodes that have subcommands', async () => {
    expect(await complete('tool a b ')).not.toContain('red');
  });

  it('never offers hidden names anywhere', async () => {
    for (const w of ['tool ', 'tool list ', 'tool a ']) {
      expect((await complete(w)).join(' ')).not.toMatch(/internal|secret|zz/);
    }
  });

  it('the real CLI offers exactly bash zsh fish for `codemie completion <Tab>`', async () => {
    const got = (await real.complete('codemie completion ')).filter(n => !n.startsWith('-')).sort();
    expect(got).toEqual(['bash', 'fish', 'zsh']);
  });
});
