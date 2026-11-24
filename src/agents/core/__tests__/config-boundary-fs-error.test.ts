import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

let unreadable = '';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (p: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      if (String(p) === unreadable) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

import { findNearestConfigDir } from '../event-fields/identity-fields.js';

describe('findNearestConfigDir with an unreadable .git marker', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codemie-boundary-'));
    vi.stubEnv('CODEMIE_HOME', path.join(tmp, 'home'));
  });

  afterEach(async () => {
    unreadable = '';
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('stays at the launch dir instead of selecting the config of a containing worktree', async () => {
    const outer = path.join(tmp, 'outer');
    const inner = path.join(outer, 'inner');
    const deep = path.join(inner, 'sub');
    await fs.mkdir(path.join(outer, '.git'), { recursive: true });
    await fs.mkdir(path.join(outer, '.codemie'), { recursive: true });
    await fs.writeFile(path.join(outer, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, profiles: {} }));
    await fs.mkdir(deep, { recursive: true });

    // Definite absence of an inner marker continues up to the containing worktree...
    expect(await findNearestConfigDir(deep)).toBe(outer);
    // ...but an inner marker that cannot be read leaves the boundary unknown.
    unreadable = path.join(inner, '.git');
    expect(await findNearestConfigDir(deep)).toBe(deep);
  });
});
