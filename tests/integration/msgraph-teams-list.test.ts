/**
 * msgraph.js `teams --teams-list` — joinedTeams / memberOf fallback contract test
 *
 * Runs the skill script as a child process with a preload that replaces
 * `https.request`, routes on the request path and logs every requested path.
 * A temp HOME holds a fake token cache, so no network or real credentials are used.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(
  REPO_ROOT, 'src', 'agents', 'plugins', 'claude', 'plugin', 'skills', 'msgraph', 'scripts', 'msgraph.js'
);
const RUN_TIMEOUT_MS = 20_000;
const GRAPH = 'https://graph.microsoft.com/v1.0';

interface Route {
  match: string;
  status: number;
  body: object;
}

// First route whose `match` is a substring of options.path wins; unmatched paths get 404.
const STUB_SOURCE = `
const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const routes = JSON.parse(process.env.MSGRAPH_ROUTES);
https.request = (options, onResponse) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    fs.appendFileSync(process.env.MSGRAPH_LOG, options.path + '\\n');
    const route = routes.find(r => options.path.includes(r.match));
    const res = new EventEmitter();
    res.statusCode = route ? route.status : 404;
    res.headers = {};
    onResponse(res);
    res.emit('data', Buffer.from(JSON.stringify(route ? route.body : {})));
    res.emit('end');
  };
  return req;
};
`;

const team = (id: string, displayName: string) => ({
  id,
  displayName,
  description: '',
  resourceProvisioningOptions: ['Team'],
});
const nonTeam = (id: string, displayName: string) => ({
  id,
  displayName,
  resourceProvisioningOptions: [] as string[],
});
const noOptions = (id: string, displayName: string) => ({ id, displayName });
const teamLine = (t: { id: string; displayName: string }) => `${t.id.slice(0, 36)}  ${t.displayName}`;

const JOINED_403: Route = { match: '/me/joinedTeams', status: 403, body: { error: { code: 'Forbidden' } } };

describe('msgraph.js teams --teams-list', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runTeamsList(routes: Route[], args: string[] = []) {
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
    const log = join(stubDir, 'requests.log');

    // os.homedir() reads USERPROFILE on Windows, HOME elsewhere
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEMIE_HOME: home,
      MSGRAPH_ROUTES: JSON.stringify(routes),
      MSGRAPH_LOG: log,
    };
    delete env.NODE_ENV;
    delete env.VITEST;

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn('node', ['-r', stub, script, 'teams', '--teams-list', ...args], { env });
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

    const paths = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { ...result, paths };
  }

  const memberOfPaths = (paths: string[]) => paths.filter(p => p.includes('/me/memberOf'));

  it('falls back to memberOf and lists teams from every page', async () => {
    const teamA = team('11111111-1111-1111-1111-111111111111-extra', 'Team Alpha');
    const result = await runTeamsList([
      JOINED_403,
      {
        match: 'skiptoken=p2',
        status: 200,
        body: { value: [teamA, nonTeam('g3', 'Page Two Group')] },
      },
      {
        match: '/me/memberOf',
        status: 200,
        body: {
          value: [nonTeam('g1', 'Security Group'), noOptions('g2', 'Distribution List')],
          '@odata.nextLink': `${GRAPH}/me/memberOf?$skiptoken=p2`,
        },
      },
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([teamLine(teamA)]);
    for (const name of ['Security Group', 'Distribution List', 'Page Two Group']) {
      expect(result.stdout).not.toContain(name);
    }
    expect(result.paths[0]).toContain('/me/joinedTeams');
    const member = memberOfPaths(result.paths);
    expect(member).toHaveLength(2);
    expect(member[0]).not.toContain('skiptoken=p2');
    expect(member[1]).toContain('skiptoken=p2');
  }, RUN_TIMEOUT_MS + 5_000);

  it('single-page memberOf returns the team and requests no further page', async () => {
    const teamA = team('22222222-2222-2222-2222-222222222222', 'Team Beta');
    const result = await runTeamsList([
      JOINED_403,
      {
        match: '/me/memberOf',
        status: 200,
        body: { value: [nonTeam('g1', 'Some Group'), teamA] },
      },
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([teamLine(teamA)]);
    expect(result.stdout).not.toContain('Some Group');
    expect(memberOfPaths(result.paths)).toHaveLength(1);
  }, RUN_TIMEOUT_MS + 5_000);

  describe('joinedTeams succeeds', () => {
    const teams = [
      { id: '33333333-3333-3333-3333-333333333333', displayName: 'Joined One', description: 'd1' },
      { id: '44444444-4444-4444-4444-444444444444', displayName: 'Joined Two', description: 'd2' },
    ];
    const joinedOk: Route = { match: '/me/joinedTeams', status: 200, body: { value: teams } };

    it('never requests memberOf (plain output)', async () => {
      const result = await runTeamsList([joinedOk]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual(teams.map(teamLine));
      expect(memberOfPaths(result.paths)).toHaveLength(0);
    }, RUN_TIMEOUT_MS + 5_000);

    it('never requests memberOf (--json)', async () => {
      const result = await runTeamsList([joinedOk], ['--json']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(JSON.stringify(teams, null, 2));
      expect(memberOfPaths(result.paths)).toHaveLength(0);
    }, RUN_TIMEOUT_MS + 5_000);
  });

  it('fallback --json returns only team groups', async () => {
    const teamA = team('55555555-5555-5555-5555-555555555555', 'Team Gamma');
    const result = await runTeamsList(
      [
        JOINED_403,
        {
          match: '/me/memberOf',
          status: 200,
          body: { value: [nonTeam('g1', 'Plain Group'), teamA] },
        },
      ],
      ['--json']
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([teamA]);
    expect(result.stdout).not.toContain('Plain Group');
  }, RUN_TIMEOUT_MS + 5_000);

  describe.each([500, 403])('later memberOf page failing with %i', status => {
    it('exits 1 with empty stdout', async () => {
      const result = await runTeamsList([
        JOINED_403,
        { match: 'skiptoken=p2', status, body: { error: { code: 'Failure' } } },
        {
          match: '/me/memberOf',
          status: 200,
          body: {
            value: [team('66666666-6666-6666-6666-666666666666', 'Team Delta')],
            '@odata.nextLink': `${GRAPH}/me/memberOf?$skiptoken=p2`,
          },
        },
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toBe('');
    }, RUN_TIMEOUT_MS + 5_000);
  });
});
