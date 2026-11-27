/**
 * The local doctor's folder row when a folder file is gone between the listing and its `stat`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatusDeps } from '../../../analytics/sync/status.js';

const gone = vi.hoisted(() => new Set<string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = async (path: string, ...rest: unknown[]) => {
    if (gone.has(String(path))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
    }
    return (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, stat };
});

const JOB = 'CodeMieLocalDoctorTestJob';
const NEWEST = new Date('2026-11-20T10:00:00.000Z');

let home: string;
let folder: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'local-doctor-'));
  vi.stubEnv('CODEMIE_HOME', home);
  folder = join(home, 'analytics', 'sessions');
  mkdirSync(folder, { recursive: true });
  for (const name of ['s1.hooks.jsonl', 's2.hooks.jsonl']) {
    writeFileSync(join(folder, name), '{}\n');
    utimesSync(join(folder, name), NEWEST, NEWEST);
  }
});
afterEach(async () => {
  gone.clear();
  await (await import('@/utils/logger.js')).logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function status(): StatusDeps {
  return {
    loadSettings: async () => ({
      webhookUrl: 'https://hooks.example.invalid/x?sig=FAKE',
      format: 'json',
      includeExternal: 'never',
      at: '03:00',
      taskName: JOB,
      local: true,
    }),
    schedulerFor: () => ({
      preflight: async () => undefined,
      register: async () => ({}),
      unregister: async () => false,
      query: async () => 'enabled' as const,
      exists: async () => 'present' as const,
    }),
    readLog: async () => null,
    readMarker: async () => null,
    now: () => new Date('2026-11-22T00:00:00.000Z'),
    print: () => undefined,
    modeLines: () => [],
  };
}

async function folderLine(): Promise<string> {
  const { localDoctorPlan } = await import('../local-doctor.js');
  return (await localDoctorPlan(status()).deliveryHealth({ json: false })).lines[0];
}

describe('localDoctorPlan — the analytics folder row', () => {
  it('leaves out a file gone at its stat: one of two sessions is counted', async () => {
    gone.add(join(folder, 's2.hooks.jsonl'));

    expect(await folderLine()).toBe('Local analytics folder: 1 session, newest 2026-11-20T10:00:00.000Z');
  });

  it('is the 0 sessions row when every file is gone at its stat', async () => {
    gone.add(join(folder, 's1.hooks.jsonl'));
    gone.add(join(folder, 's2.hooks.jsonl'));

    expect(await folderLine()).toBe('Local analytics folder: 0 sessions');
  });
});
