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
    // Release the logger's file in the temp home first (before resetModules swaps the instance): Windows cannot delete an open file.
    await (await import('@/utils/logger.js')).logger.close();
    process.stdin.isTTY = tty as boolean;
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  it('--copilot-otlp is refused for both actions, nothing is written; --claude-otlp is accepted', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes', '--copilot-otlp']);
    expect(process.exitCode).toBe(1);
    expect(said(err)).toContain('only available for Claude Code');
    expect((await store()).entries).toHaveLength(0);
    process.exitCode = 0;
    await run(['consent', 'revoke', work, '--copilot-otlp']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes', '--claude-otlp']);
    expect(process.exitCode ?? 0).toBe(0);
    expect((await store()).entries).toHaveLength(1);
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

  describe('--all (the all-folders consent)', () => {
    const allEntries = async () => (await store()).entries as Array<Record<string, unknown>>;

    it('grant --all --yes writes one all-folders entry and says so', async () => {
      await run(['consent', 'grant', '--all', '--yes']);
      const entries = await allEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ all_folders: true, project: '*', folder: '*', owner_hash: id.owner_hash, api_identity: id.api_identity });
      expect(said(out)).toContain('every repository');
      expect(process.exitCode).toBe(0);
    });

    it('grant --all is idempotent', async () => {
      await run(['consent', 'grant', '--all', '--yes']);
      await run(['consent', 'grant', '--all', '--yes']);
      expect(await allEntries()).toHaveLength(1);
    });

    it('grant --all rejects --project and a path, and writes nothing', async () => {
      await run(['consent', 'grant', '--all', '--project', 'Proj-A', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(said(err)).toContain('--all');
      process.exitCode = 0;
      await run(['consent', 'grant', work, '--all', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(await allEntries()).toHaveLength(0);
    });

    it('grant --all without --yes and without a TTY refuses; an interactive no changes nothing', async () => {
      process.stdin.isTTY = false as never;
      await run(['consent', 'grant', '--all']);
      expect(process.exitCode).toBe(1);
      expect(said(err)).toContain('--yes');
      process.exitCode = 0;
      process.stdin.isTTY = true as never;
      promptMock.mockResolvedValue({ ok: false });
      await run(['consent', 'grant', '--all']);
      expect(said(out)).toContain('Nothing changed');
      expect(await allEntries()).toHaveLength(0);
    });

    it('grant --all is refused for a Copilot connector and without a signed-in identity', async () => {
      await run(['consent', 'grant', '--all', '--yes', '--copilot-otlp']);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      identityMock.mockResolvedValue(null);
      await run(['consent', 'grant', '--all', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(said(err)).toContain('Sign in');
      expect(await allEntries()).toHaveLength(0);
    });

    it('revoke --all removes only the all-folders entry', async () => {
      await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
      await run(['consent', 'grant', '--all', '--yes']);
      out.mockClear();
      await run(['consent', 'revoke', '--all']);
      const entries = await allEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].all_folders).toBeUndefined();
      expect(said(out)).toContain('all-repositories');
    });

    it('revoking a folder that has its own grant, under --all, says running sessions stop and new ones keep publishing', async () => {
      await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
      await run(['consent', 'grant', '--all', '--yes']);
      out.mockClear();
      await run(['consent', 'revoke', work]);
      expect(await allEntries()).toHaveLength(1);
      expect(said(out)).toContain('Disconnected');
      expect(said(out)).toContain('new sessions there keep publishing, sessions already running there stop');
      expect(said(out)).toContain('consent revoke --all');
    });

    it('revoke --all with nothing to remove says so; with a path it is rejected', async () => {
      await run(['consent', 'revoke', '--all']);
      expect(said(out)).toContain('Nothing to change');
      expect(process.exitCode).toBe(0);
      await run(['consent', 'revoke', work, '--all']);
      expect(process.exitCode).toBe(1);
      expect(said(err)).toContain('--all');
    });

    it('revoke of a folder never removes the all-folders entry and names `consent revoke --all`', async () => {
      await run(['consent', 'grant', '--all', '--yes']);
      out.mockClear();
      await run(['consent', 'revoke', work]);
      expect(await allEntries()).toHaveLength(1);
      expect(said(out)).toContain('still covered');
      expect(said(out)).toContain('consent revoke --all');
      expect(said(out)).not.toContain('is not connected');
    });

    it('list shows the entry as any repository', async () => {
      await run(['consent', 'grant', '--all', '--yes']);
      out.mockClear();
      await run(['consent', 'list']);
      expect(said(out)).toContain('any repository');
      expect(said(out)).not.toContain('*');
    });

    it('grant --help and revoke --help list --all; the hidden deprecated aliases do not', async () => {
      const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
      const consent = createProxyAnalyticsCommand().commands.find((c) => c.name() === 'consent')!;
      const help = (n: string) => consent.commands.find((c) => c.name() === n)!.helpInformation();
      expect(help('grant')).toContain('--all');
      expect(help('revoke')).toContain('--all');
      const analytics = createProxyAnalyticsCommand();
      for (const alias of ['connect-folder', 'disconnect-folder']) {
        expect(analytics.commands.find((c) => c.name() === alias)!.helpInformation()).not.toContain('--all');
      }
    });
  });

  it('in the local mode grant and grant --all hint the local install, never proxy connect', async () => {
    await writeFile(join(tempDir, 'analytics-sync.json'), JSON.stringify({
      webhookUrl: 'https://example.invalid/hook?sig=FAKE',
      format: 'json',
      includeExternal: 'never',
      at: '03:00',
      local: true,
      localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' },
    }));

    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    expect(said(out)).toContain('codemie analytics sync install');
    expect(said(out)).not.toContain('proxy connect');
    out.mockClear();
    await run(['consent', 'grant', '--all', '--yes']);
    expect(said(out)).toContain('codemie analytics sync install');
    expect(said(out)).not.toContain('proxy connect');
  });

  it('output without --all is unchanged (c)', async () => {
    await run(['consent', 'grant', work, '--project', 'Proj-A', '--yes']);
    expect(said(out)).toContain(`Folder:  ${work}`);
    expect(said(out)).toContain('Project: Proj-A');
    expect(said(out)).toContain('Connected');
    out.mockClear();
    await run(['consent', 'list']);
    expect(said(out)).toContain(`${work}  project Proj-A  ${id.api_identity}`);
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
