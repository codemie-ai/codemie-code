/**
 * Actions of `codemie proxy analytics consent grant|revoke|list`: confirmation gate, Claude-only
 * guard, identity requirement and the effect on the real consent store.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let work: string;
const identityMock = vi.fn();
const promptMock = vi.fn();

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return { ...actual, getCodemiePath: (...p: string[]) => join(tempDir, ...p), resolveHomeDir: (r = '') => join(tempDir, 'home', r) };
});
vi.mock('@/utils/project-root.js', () => ({ resolveProjectRoot: () => work }));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({ currentEvidenceIdentity: identityMock }));
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const id = { api_identity: 'https://api.example.com', owner_hash: 'o'.repeat(64) };

describe('consent grant / revoke / list actions', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  let tty: boolean | undefined;

  beforeEach(async () => {
    // Canonical like the code's paths: on Windows tmpdir() may be the 8.3 short form (RUNNER~1).
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'codemie-consent-cmd-')));
    work = join(tempDir, 'repo');
    await mkdir(join(work, 'sub'), { recursive: true });
    identityMock.mockReset().mockResolvedValue(id);
    promptMock.mockReset();
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
    tty = process.stdin.isTTY;
    process.exitCode = 0;
  });
  afterEach(async () => {
    process.stdin.isTTY = tty as boolean;
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  const run = async (args: string[]) => {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(args, { from: 'user' });
  };
  const store = async () => {
    const { consentStorePath } = await import('@/agents/core/evidence/consent-store.js');
    return readFile(consentStorePath(), 'utf-8').then((s) => JSON.parse(s) as { entries: unknown[] }, () => ({ entries: [] }));
  };
  const said = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().join(' ');

  it('--yes connects the folder for the signed-in owner', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    expect((await store()).entries).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  it('a project name the raw header cannot carry is refused with an explanation before any consent is saved', async () => {
    await run(['consent', 'grant', work, '--project', 'Проект', '--yes']);
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('Latin-1');
    expect((await store()).entries).toHaveLength(0);
  });

  it('a Latin-1 project name that already works is still connected', async () => {
    await run(['consent', 'grant', work, '--project', 'Café', '--yes']);
    expect(process.exitCode).toBe(0);
    expect((await store()).entries).toHaveLength(1);
  });

  it('without --yes and without a TTY it refuses (exit 1) and the store is untouched', async () => {
    process.stdin.isTTY = false as never;
    await run(['consent', 'grant', work, '--project', 'Proj-A']);
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('--yes');
    expect(promptMock).not.toHaveBeenCalled();
    expect((await store()).entries).toHaveLength(0);
  });

  it('an interactive "no" changes nothing', async () => {
    process.stdin.isTTY = true as never;
    promptMock.mockResolvedValue({ ok: false });
    await run(['consent', 'grant', work, '--project', 'Proj-A']);
    expect(said(out)).toContain('Nothing changed');
    expect((await store()).entries).toHaveLength(0);
  });

  it('a Copilot connector is refused for both actions and nothing is written', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes', '--copilot-cli-otlp']);
    expect(process.exitCode).toBe(1);
    expect((await store()).entries).toHaveLength(0);
    process.exitCode = 0;
    await run(['consent', 'revoke', work, '--copilot-chat-otlp']);
    expect(process.exitCode).toBe(1);
  });

  it('without a signed-in identity connect refuses and does not write', async () => {
    identityMock.mockResolvedValue(null);
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('Sign in');
    expect((await store()).entries).toHaveLength(0);
  });

  it('disconnect removes the entry', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    await run(['consent', 'revoke', work]);
    expect((await store()).entries).toHaveLength(0);
    expect(said(out)).toContain('Disconnected');
  });

  it('disconnecting a subfolder of a connected parent names the covering parent and the exact command', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    out.mockClear();
    await run(['consent', 'revoke', join(work, 'sub')]);
    expect((await store()).entries).toHaveLength(1); // the parent entry is untouched
    expect(said(out)).not.toContain('is not connected');
    expect(said(out)).toContain('still covered');
    expect(said(out)).toContain('consent revoke');
    expect(said(out)).toContain('Proj-A');
  });

  it('an unconnected folder still reports nothing to change', async () => {
    await run(['consent', 'revoke', work]);
    expect(said(out)).toContain('is not connected');
  });

  it('consent list prints every entry and says so when there are none', async () => {
    await run(['consent', 'list']);
    expect(said(out)).toContain('No work-consent folders');
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    out.mockClear();
    await run(['consent', 'list']);
    expect(said(out)).toContain('Proj-A');
    expect(said(out)).toContain(work);
    const { listConsents } = await import('@/agents/core/evidence/consent-store.js');
    const listed = await listConsents(id);
    expect(listed.kind === 'ok' ? listed.entries : []).toHaveLength(1);
  });

  it('consent list shows only the signed-in account\'s folders', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    identityMock.mockResolvedValue({ ...id, owner_hash: 'p'.repeat(64) });
    out.mockClear();
    await run(['consent', 'list']);
    expect(said(out)).toContain('No work-consent folders');
    expect(said(out)).not.toContain('Proj-A');
  });

  it('consent list reports an unreadable store as an error, not as none', async () => {
    const { consentStorePath } = await import('@/agents/core/evidence/consent-store.js');
    await mkdir(join(tempDir), { recursive: true });
    await writeFile(consentStorePath(), '{ not json');
    out.mockClear();
    await run(['consent', 'list']);
    expect(said(out)).not.toContain('No work-consent folders');
    expect(said(err)).toContain('cannot be read');
    expect(process.exitCode).toBe(1);
  });

  it('the deprecated connect-folder / disconnect-folder still work with one stderr notice each', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await run(['connect-folder', work, '--project', 'Proj-A', '--yes']);
    expect((await store()).entries).toHaveLength(1);
    await run(['disconnect-folder', work]);
    expect((await store()).entries).toHaveLength(0);
    const notices = write.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('Deprecated:'));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('codemie proxy analytics consent grant');
    expect(notices[1]).toContain('codemie proxy analytics consent revoke');
  });
});
