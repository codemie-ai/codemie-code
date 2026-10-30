/**
 * The detached sign-in entry point is the only producer of the lock's
 * succeededAt / failedAt+error stamps that waitForDetachedSsoLogin reports.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const authenticate = vi.fn();

vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: (...parts: string[]) => join(tempDir, ...parts),
  getDirname: () => '/fake/dist/providers/plugins/sso',
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), close: vi.fn() },
}));
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    authenticate = authenticate;
  },
}));

describe('sso-login entry point', () => {
  const originalArgv = process.argv;
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'sso-login-'));
    await writeFile(join(tempDir, 'sso-login.lock'), JSON.stringify({ pid: process.pid, startedAt: 1000 }));
    process.argv = ['node', 'sso-login', '--url', 'https://codemie.example.com'];
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    process.argv = originalArgv;
    exit.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  const readLock = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(tempDir, 'sso-login.lock'), 'utf-8'));

  it('stamps the lock with the sign-in error when authentication fails', async () => {
    authenticate.mockResolvedValue({ success: false, error: 'Authentication cancelled by user' });

    await import('../sso-login.js');

    expect(await readLock()).toMatchObject({ failedAt: expect.any(Number), error: 'Authentication cancelled by user' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stamps the lock as succeeded when authentication succeeds', async () => {
    authenticate.mockResolvedValue({ success: true });

    await import('../sso-login.js');

    const lock = await readLock();
    expect(lock).toMatchObject({ succeededAt: expect.any(Number) });
    expect(lock).not.toHaveProperty('failedAt');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
