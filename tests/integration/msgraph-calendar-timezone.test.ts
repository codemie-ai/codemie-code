/**
 * msgraph.js calendar — timezone label and all-day range contract test
 *
 * Runs the skill script as a child process with a preload that replaces
 * `https.request` and a temp HOME holding a fake token cache, so no network
 * or real credentials are used.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(
  REPO_ROOT, 'src', 'agents', 'plugins', 'claude', 'plugin', 'skills', 'msgraph', 'scripts', 'msgraph.js'
);
const RUN_TIMEOUT_MS = 20_000;

const STUB_SOURCE = `
const https = require('node:https');
const { EventEmitter } = require('node:events');
const allDay = (subject, s, e) => ({
  subject, isAllDay: true,
  start: { dateTime: s + 'T00:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: e + 'T00:00:00.0000000', timeZone: 'UTC' },
  organizer: { emailAddress: { name: 'Org' } },
});
const payload = { value: [
  {
    subject: 'Timed', isAllDay: false,
    start: { dateTime: '2026-11-23T08:30:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-23T09:30:00.0000000', timeZone: 'UTC' },
    organizer: { emailAddress: { name: 'Org' } },
  },
  allDay('OneDay', '2026-11-23', '2026-11-24'),
  allDay('ThreeDay', '2026-11-23', '2026-11-26'),
] };
https.request = (_options, onResponse) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    onResponse(res);
    res.emit('data', Buffer.from(JSON.stringify(payload)));
    res.emit('end');
  };
  return req;
};
`;

describe('msgraph.js calendar timezone and all-day formatting', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function run(tz: string, cliArgs: string[]): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), 'msgraph-home-'));
    const stubDir = mkdtempSync(join(tmpdir(), 'msgraph-stub-'));
    dirs.push(home, stubDir);

    writeFileSync(
      join(home, '.ms_graph_token_cache.json'),
      JSON.stringify({
        access_token: 'fake',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        username: 'x',
      })
    );
    const stub = join(stubDir, 'stub.cjs');
    writeFileSync(stub, STUB_SOURCE);
    // Run a copy from the temp dir: the script is CommonJS and the repo is "type": "module"
    const script = join(stubDir, 'msgraph.js');
    copyFileSync(SCRIPT, script);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEMIE_HOME: home, TZ: tz };
    delete env.NODE_ENV;
    delete env.VITEST;

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn('node', ['-r', stub, script, 'calendar', ...cliArgs], { env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error('msgraph.js timed out'));
      }, RUN_TIMEOUT_MS);
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (stderr += d));
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
    });

    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  it('labels timed events with the local UTC offset and all-day events as dates', async () => {
    const out = await run('Asia/Tbilisi', []);
    expect(out).toContain('2026-11-23 12:30 (UTC+4)');
    expect(out).toContain('2026-11-23 (all day)');
  }, RUN_TIMEOUT_MS + 5_000);

  it('shows the inclusive last day for all-day events in the busy view', async () => {
    const out = await run('Asia/Tbilisi', ['--availability', '--start', '2026-11-23T00:00:00', '--end', '2026-11-30T00:00:00']);
    expect(out).toContain('2026-11-23 (all day) — 2026-11-23 (all day): OneDay');
    expect(out).toContain('2026-11-23 (all day) — 2026-11-25 (all day): ThreeDay');
  }, RUN_TIMEOUT_MS + 5_000);

  it('labels the zone as UTC when the local zone is UTC', async () => {
    const out = await run('UTC', []);
    expect(out).toContain('2026-11-23 08:30 (UTC)');
  }, RUN_TIMEOUT_MS + 5_000);
});
