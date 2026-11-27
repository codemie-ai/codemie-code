/**
 * Integration test: `codemie sdk assistants list` reports a response-less
 * network failure with its real error code, not as a generic "HTTP 500".
 *
 * The CLI is run as a child process against a local HTTP server that answers
 * every request with a redirect to itself. axios (follow-redirects) gives up
 * with ERR_FR_TOO_MANY_REDIRECTS and no HTTP response; the SDK maps any
 * response-less failure to `ApiError("HTTP 500 error")`, which the CLI used to
 * print verbatim.
 *
 * Isolation: a private CODEMIE_HOME, HOME and working directory per test. The
 * SSO credential is written straight to the file store of that CODEMIE_HOME
 * (no keychain write), keyed by the local server URL.
 *
 * The CLI under test is `<root>/bin/codemie.js`, where <root> is
 * $CLI_ROOT_UNDER_TEST (a checkout with a built `dist/`) or this repository.
 * The variable is not CODEMIE_-prefixed because tests/setup/clean-env.ts
 * removes those from the worker environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { AddressInfo } from 'net';
import {
  deriveMachineEncryptionKey,
  deriveUrlStorageKey,
  encryptWithKey,
} from '../../src/utils/credential-crypto.js';

const CLI_ROOT = resolve(process.env.CLI_ROOT_UNDER_TEST || '.');
const CLI_ENTRY = join(CLI_ROOT, 'bin', 'codemie.js');

interface CliResult {
  status: number | null;
  output: string;
}

/** Async spawn: the redirect server lives in this process, so spawnSync would deadlock. */
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(CODEMIE_|CLAUDE_|ANTHROPIC_|OTEL_)/i.test(key)) inherited[key] = value;
    }
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...inherited, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status) => { clearTimeout(timer); resolvePromise({ status, output }); });
  });
}

describe('sdk assistants list - network error reporting', () => {
  let server: Server;
  let redirectRequests: number;
  let workDir: string;
  let codemieHome: string;
  let userHome: string;
  let origin: string;

  beforeEach(async () => {
    redirectRequests = 0;
    server = createServer((req, res) => {
      redirectRequests += 1;
      res.writeHead(302, { Location: req.url ?? '/' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    workDir = mkdtempSync(join(tmpdir(), 'codemie-sdk-neterr-'));
    codemieHome = join(workDir, 'codemie-home');
    userHome = join(workDir, 'user-home');
    const cwd = join(workDir, 'project');
    for (const dir of [codemieHome, userHome, cwd]) mkdirSync(dir, { recursive: true });

    const baseUrl = `${origin}/code-assistant-api`;
    const profileName = `neterr-${Date.now().toString(36)}`;
    writeFileSync(
      join(codemieHome, 'codemie-cli.config.json'),
      JSON.stringify({
        version: 2,
        activeProfile: profileName,
        profiles: {
          [profileName]: {
            name: profileName,
            provider: 'ai-run-sso',
            authMethod: 'sso',
            codeMieUrl: origin,
            baseUrl,
            model: 'test-model',
          },
        },
      }, null, 2),
    );

    const credentials = {
      cookies: { codemie_access_token: 'local-test-token' },
      apiUrl: baseUrl,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    mkdirSync(join(codemieHome, 'credentials'), { recursive: true });
    writeFileSync(
      join(codemieHome, 'credentials', `${deriveUrlStorageKey(baseUrl)}.enc`),
      encryptWithKey(JSON.stringify(credentials), deriveMachineEncryptionKey()),
    );
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(workDir, { recursive: true, force: true });
  });

  // @case sdk-network-error-reporting_TC_001
  it('reports ERR_FR_TOO_MANY_REDIRECTS instead of a generic HTTP 500', async () => {
    const result = await runCli(
      ['sdk', 'assistants', 'list', '--projects', 'p', '--page', '0', '--per-page', '5', '--json'],
      {
        CODEMIE_HOME: codemieHome,
        HOME: userHome,
        USERPROFILE: userHome,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      join(workDir, 'project'),
    );
    const diagnostic = `cli=${CLI_ENTRY} status=${result.status} redirects=${redirectRequests}\n${result.output}`;

    // The command reached the API, followed the redirect loop and failed on it.
    expect(result.status !== 0 && redirectRequests > 1, diagnostic).toBe(true); // repro:precondition

    expect(result.output, diagnostic).not.toContain('HTTP 500'); // repro:symptom
    expect(result.output, diagnostic).toContain('ERR_FR_TOO_MANY_REDIRECTS'); // repro:symptom
  });
});
