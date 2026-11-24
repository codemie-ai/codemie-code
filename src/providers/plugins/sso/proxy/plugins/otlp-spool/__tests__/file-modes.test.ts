/**
 * CR-003: evidence/spool directories are created 0700 and the metadata/spool files this feature creates
 * are 0600. Asserted on the options handed to fs (portable); Windows modes are not ACL guarantees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Call = { fn: string; path: string; options: unknown };
const calls: Call[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const spy = (fn: 'mkdir' | 'writeFile' | 'appendFile', optIndex: number) =>
    (...args: unknown[]) => {
      calls.push({ fn, path: String(args[0]), options: args[optIndex] });
      return (real[fn] as (...a: unknown[]) => unknown)(...args);
    };
  return { ...real, mkdir: spy('mkdir', 1), writeFile: spy('writeFile', 2), appendFile: spy('appendFile', 2) };
});
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let home: string;
let prev: string | undefined;

beforeEach(() => {
  calls.length = 0;
  prev = process.env.CODEMIE_HOME;
  home = mkdtempSync(join(tmpdir(), 'modes-'));
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const mode = (c: Call): unknown => (c.options as { mode?: number } | string | undefined) && (c.options as { mode?: number }).mode;
const mkdirs = () => calls.filter((c) => c.fn === 'mkdir' && c.path.startsWith(home));
const created = (fn: string) => calls.filter((c) => c.fn === fn && c.path.startsWith(home));

describe('restrictive modes on evidence and spool paths', () => {
  it('spool: root dir 0700; stream, status and epoch files 0600', async () => {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool('sess-1', 'hooks', '{"hookEvent":"{}"}\n');
    expect(mkdirs().length).toBeGreaterThan(0);
    expect(mkdirs().every((c) => mode(c) === 0o700)).toBe(true);
    const files = [...created('writeFile'), ...created('appendFile')];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((c) => mode(c) === 0o600)).toBe(true);
    const names = files.map((c) => c.path);
    expect(names.some((p) => p.endsWith('epoch.json') || p.includes('epoch.json'))).toBe(true);
    expect(names.some((p) => /status/.test(p))).toBe(true);
  });

  it('verdict store: evidence dir 0700 and the verdict file 0600 (via atomicReplace)', async () => {
    const { recordVerdict } = await import('../verdict-store.js');
    await recordVerdict('k'.repeat(64), {
      class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1',
    } as never);
    expect(mkdirs().length).toBeGreaterThan(0);
    expect(mkdirs().every((c) => mode(c) === 0o700)).toBe(true);
    const files = created('writeFile');
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((c) => mode(c) === 0o600)).toBe(true);
  });
});
