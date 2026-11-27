/**
 * msgraph.js runner - runs the msgraph skill script offline as a child process
 *
 * Each run gets its own temp directory holding a fake token cache (used as HOME), a preload
 * that replaces `https.request` with a canned Graph response, and a copy of the script
 * (the script is CommonJS and the repo is "type": "module", so it must run outside the repo).
 * No network or real credentials are used.
 *
 * MSGRAPH_SCRIPT_UNDER_TEST points the runner at another copy of msgraph.js (e.g. a built
 * dist/ copy or an older build); it defaults to the source copy in this repository.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SCRIPT = join(
  REPO_ROOT, 'src', 'agents', 'plugins', 'claude', 'plugin', 'skills', 'msgraph', 'scripts', 'msgraph.js'
);

/** Upper bound for one script run; use `MSGRAPH_RUN_TIMEOUT_MS + 5_000` as the test timeout. */
export const MSGRAPH_RUN_TIMEOUT_MS = 20_000;

export interface MsgraphRunOptions {
  /** IANA timezone for the child process, e.g. 'Asia/Tbilisi' */
  tz: string;
  /** Arguments after the script path, e.g. ['calendar', '--availability'] */
  args: string[];
  /** JSON body every stubbed Graph request answers with (status 200) */
  graphResponse: unknown;
}

export interface MsgraphRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface MsgraphRunner {
  run(options: MsgraphRunOptions): Promise<MsgraphRunResult>;
  /** Removes every temp directory this runner created; call it from afterEach */
  cleanup(): void;
}

function stubSource(graphResponse: unknown): string {
  return `
const https = require('node:https');
const { EventEmitter } = require('node:events');
const body = Buffer.from(${JSON.stringify(JSON.stringify(graphResponse))});
https.request = (_options, onResponse) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    onResponse(res);
    res.emit('data', body);
    res.emit('end');
  };
  return req;
};
`;
}

export function createMsgraphRunner(): MsgraphRunner {
  const scriptUnderTest = process.env.MSGRAPH_SCRIPT_UNDER_TEST
    ? resolve(process.env.MSGRAPH_SCRIPT_UNDER_TEST)
    : DEFAULT_SCRIPT;
  const dirs: string[] = [];

  return {
    run({ tz, args, graphResponse }) {
      // One root per run, registered before anything else can throw, so cleanup never misses it
      const root = mkdtempSync(join(tmpdir(), 'msgraph-run-'));
      dirs.push(root);
      const home = join(root, 'home');
      mkdirSync(home);

      writeFileSync(
        join(home, '.ms_graph_token_cache.json'),
        JSON.stringify({ access_token: 'fake', expires_at: Math.floor(Date.now() / 1000) + 3600, username: 'x' })
      );
      const stub = join(root, 'stub.cjs');
      writeFileSync(stub, stubSource(graphResponse));
      const script = join(root, 'msgraph.js');
      copyFileSync(scriptUnderTest, script);

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEMIE_HOME: home, TZ: tz };
      delete env.NODE_ENV;
      delete env.VITEST;

      return new Promise((done, fail) => {
        const child = spawn('node', ['-r', stub, script, ...args], { env });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          fail(new Error(`msgraph.js timed out after ${MSGRAPH_RUN_TIMEOUT_MS}ms`));
        }, MSGRAPH_RUN_TIMEOUT_MS);
        child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        child.on('error', err => {
          clearTimeout(timer);
          fail(err);
        });
        child.on('close', code => {
          clearTimeout(timer);
          done({ code, stdout, stderr });
        });
      });
    },

    cleanup() {
      // maxRetries: on Windows a just-killed child can briefly hold a handle (EBUSY)
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
