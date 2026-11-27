import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeBash, escapeZshDescribe, escapeFish } from '../escape.js';

const NASTY = [
  `it's`, `say "hi"`, '$HOME', '`id`', '100%', 'a:b', '[x]', 'back\\slash', 'ünï ✓ 日本',
  'a\\', "a\\'b", '$(touch SENTINEL)',
];
const FIXTURE = 'a\n$(touch SENTINEL)';
const flat = (s: string): string => s.replace(/\r?\n|\r/g, ' ');

// The real-shell cases run on POSIX only: Windows runners have no zsh or fish, and Git Bash
// is not a supported completion target, so they are skipped there (also when CI is set).
const IS_WINDOWS = process.platform === 'win32';

function shellAvailable(sh: string): boolean {
  if (IS_WINDOWS) return false;
  return spawnSync(sh, ['--version'], { encoding: 'utf8' }).status === 0;
}

interface ShellCase {
  name: string;
  syntaxArgs: string[];
  runArgs: string[];
  escape: (s: string) => string;
  /** build script that prints the embedded value followed by a terminator */
  script: (escaped: string) => string;
}

const shells: ShellCase[] = [
  {
    name: 'bash', syntaxArgs: ['-n'], runArgs: [], escape: escapeBash,
    script: (e) => `V='${e}'\nprintf '%s' "$V"\n`,
  },
  {
    name: 'zsh', syntaxArgs: ['-n'], runArgs: ['-f'], escape: escapeZshDescribe,
    script: (e) => `typeset -a items\nitems=('name:${e}')\nprint -rn -- "\${items[1]}"\n`,
  },
  {
    name: 'fish', syntaxArgs: ['--no-execute'], runArgs: ['--no-config'], escape: escapeFish,
    script: (e) => `printf '%s' '${e}'\n`,
  },
];

describe('escape functions', () => {
  it('collapse newlines to a space (pure)', () => {
    for (const fn of [escapeBash, escapeZshDescribe, escapeFish]) {
      expect(fn('a\nb\r\nc')).not.toMatch(/[\r\n]/);
    }
    expect(escapeBash('a\nb')).toBe('a b');
  });

  for (const sh of shells) {
    const available = shellAvailable(sh.name);
    if (!available && process.env.CI && !IS_WINDOWS) {
      it(`${sh.name} is installed (required in CI)`, () => {
        expect.fail(`${sh.name} not found but CI is set`);
      });
      continue;
    }
    describe.skipIf(!available)(sh.name, () => {
      const dir = mkdtempSync(join(tmpdir(), 'esc-'));
      const run = (body: string): { out: string; status: number | null; err: string } => {
        const file = join(dir, `t.${sh.name}`);
        writeFileSync(file, body);
        const syn = spawnSync(sh.name, [...sh.syntaxArgs, file], { encoding: 'utf8', cwd: dir });
        expect(syn.status, `syntax: ${syn.stderr}`).toBe(0);
        const r = spawnSync(sh.name, [...sh.runArgs, file], { encoding: 'utf8', cwd: dir });
        return { out: r.stdout, status: r.status, err: r.stderr };
      };

      for (const raw of NASTY) {
        it(`round-trips ${JSON.stringify(raw)}`, () => {
          const r = run(sh.script(sh.escape(raw)));
          expect(r.err).toBe('');
          const expected = sh.name === 'zsh' ? `name:${flat(raw)}` : flat(raw);
          expect(r.out).toBe(expected);
          expect(existsSync(join(dir, 'SENTINEL'))).toBe(false);
        });
      }

      it('fixture with newline and command substitution is inert', () => {
        const r = run(sh.script(sh.escape(FIXTURE)));
        expect(r.status).toBe(0);
        expect(existsSync(join(dir, 'SENTINEL'))).toBe(false);
        expect(r.out).toContain('$(touch SENTINEL)');
        rmSync(dir, { recursive: true, force: true });
      });
    });
  }
});
