/**
 * msgraph.js `emails --read` — full body contract test
 *
 * Runs the skill script as a child process with a preload that replaces
 * `https.request` (Graph calls go through httpsRequest, not fetch) and a temp
 * HOME holding a fake token cache, so no network or real credentials are used.
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
const BODY_LENGTH = 8500;

const STUB_SOURCE = `
const https = require('node:https');
const { EventEmitter } = require('node:events');
const message = {
  subject: 'Long email',
  from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
  receivedDateTime: '2026-01-01T10:00:00Z',
  isRead: true,
  body: { contentType: 'html', content: '<p>' + 'a'.repeat(${BODY_LENGTH}) + '</p>' },
};
https.request = (_options, onResponse) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    onResponse(res);
    res.emit('data', Buffer.from(JSON.stringify(message)));
    res.emit('end');
  };
  return req;
};
`;

describe('msgraph.js emails --read', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('prints an HTML body longer than 2000 chars in full', async () => {
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
    // The script is CommonJS; the repo's "type": "module" would make node load it as ESM,
    // so run a copy from the temp dir, as it runs once installed under a skills directory.
    const script = join(stubDir, 'msgraph.js');
    copyFileSync(SCRIPT, script);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEMIE_HOME: home };
    delete env.NODE_ENV;
    delete env.VITEST;

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn('node', ['-r', stub, script, 'emails', '--read', 'MSG1'], { env });
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
    expect(result.stdout).toContain('a'.repeat(BODY_LENGTH));
  }, RUN_TIMEOUT_MS + 5_000);
});
