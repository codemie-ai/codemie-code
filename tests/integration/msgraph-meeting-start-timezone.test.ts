/**
 * msgraph.js transcripts --list — meeting start time is local time with a UTC offset label
 *
 * Regression for: meeting start times in the online-meetings listing (the view the call-notes
 * flow reads) were printed as bare UTC with no timezone label.
 *
 * Runs the skill script as a child process with a preload that replaces `https.request`
 * and a temp HOME holding a fake token cache, so no network or real credentials are used.
 * MSGRAPH_SCRIPT_UNDER_TEST points the test at another copy of msgraph.js (e.g. a built
 * dist/ copy); it defaults to the source copy in this repository.
 */

// @case msgraph_meeting_start_local_tz_TC_001

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = process.env.MSGRAPH_SCRIPT_UNDER_TEST
  ? resolve(process.env.MSGRAPH_SCRIPT_UNDER_TEST)
  : join(REPO_ROOT, 'src', 'agents', 'plugins', 'claude', 'plugin', 'skills', 'msgraph', 'scripts', 'msgraph.js');
const RUN_TIMEOUT_MS = 20_000;

// One online meeting starting 2026-11-23 08:30 UTC, as Graph returns it (zone-less dateTime + timeZone: UTC)
const STUB_SOURCE = `
const https = require('node:https');
const { EventEmitter } = require('node:events');
const payload = { value: [{
  id: 'evt-1', subject: 'Sprint review', isAllDay: false, isOnlineMeeting: true,
  onlineMeeting: { joinUrl: 'https://teams.example.invalid/l/meetup-join/1' },
  start: { dateTime: '2026-11-23T08:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-23T09:30:00.0000000', timeZone: 'UTC' },
}] };
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

describe('msgraph.js online meetings listing', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runTranscriptsList(tz: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const home = mkdtempSync(join(tmpdir(), 'msgraph-tz-home-'));
    const stubDir = mkdtempSync(join(tmpdir(), 'msgraph-tz-stub-'));
    dirs.push(home, stubDir);

    writeFileSync(
      join(home, '.ms_graph_token_cache.json'),
      JSON.stringify({ access_token: 'fake', expires_at: Math.floor(Date.now() / 1000) + 3600, username: 'x' })
    );
    const stub = join(stubDir, 'stub.cjs');
    writeFileSync(stub, STUB_SOURCE);
    // Run a copy from the temp dir: the script is CommonJS and the repo is "type": "module"
    const script = join(stubDir, 'msgraph.js');
    copyFileSync(SCRIPT, script);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEMIE_HOME: home, TZ: tz };
    delete env.NODE_ENV;
    delete env.VITEST;

    return new Promise((done, fail) => {
      const child = spawn('node', ['-r', stub, script, 'transcripts', '--list', '--start', '2026-11-23'], { env });
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
  }

  it('shows the meeting start in local time with a UTC offset label for a non-UTC user', async () => {
    const result = await runTranscriptsList('Asia/Tbilisi');
    const meetingLine = result.stdout.split('\n').find(l => l.includes('Sprint review'));

    expect(result.code, result.stderr).toBe(0); // repro:precondition
    expect(meetingLine, result.stdout).toBeDefined(); // repro:precondition
    expect(meetingLine).toContain('2026-11-23 12:30 (UTC+4)'); // repro:symptom
  }, RUN_TIMEOUT_MS + 5_000);
});
