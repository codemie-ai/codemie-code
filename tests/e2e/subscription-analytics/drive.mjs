// E2E driver for the subscription-analytics CLI connect flow (EPMCDME-16849).
//
// REAL: the built CLI (`codemie hook`, `codemie proxy analytics ...` as child processes), the REAL proxy daemon process
//   (bin/proxy-daemon.js: spool, stop markers, queued forwarder on its own timer) sending over HTTP, the backend's
//   router/ingestor/SQL (Postgres 17) and its analytics reader (backend_app.py /_e2e/visible).
// REPLAY: hook inputs have the shape of real Claude Code captures (evidence/fixtures/hookcap); the transcript is a real
//   Claude-written file with its session id rewritten per session. No live Claude Code session is driven.
// SYNTHETIC: credentials/JWT, config files, the canned backend responses (labelled `SYNTHETIC` below), the backend's
//   authentication and application directory (backend_app.py).
//
// Exits non-zero when any assertion fails. Results: $E2E_OUT (json).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const need = (k) => {
  if (!process.env[k]) {
    console.error(`missing env ${k}`);
    process.exit(2);
  }
  return process.env[k];
};
const CLI = need('CLI_REPO');
const WORK = need('E2E_WORK');
const API = need('E2E_API');
const PROFILE = process.env.E2E_PROFILE || 'claude-personal';
const TRANSCRIPT = need('E2E_TRANSCRIPT');
const OUT = need('E2E_OUT');
const CH = need('CODEMIE_HOME');
const HOME = need('HOME');
const USER = 'probe@example.invalid';
const HERE = dirname(fileURLToPath(import.meta.url));
const REG = pathToFileURL(join(HERE, 'no-keytar-register.mjs')).href;
const norm = (p) => p.replace(/\\/g, '/');
if (!norm(CH).startsWith(norm(WORK)) || !norm(HOME).startsWith(norm(WORK))) {
  console.error('refusing: CODEMIE_HOME/HOME are not under the scratch dir');
  process.exit(9);
}
const URL_ = `${API}/code-assistant-api`;
const win = (p) => p.replace(/\//g, '\\');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'none' })}.${b64({ email: USER, exp: 4102444800 })}.x`;
const w = (p, o) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o, null, 2));
};

const results = [];
process.on('uncaughtException', (e) => { console.error(e); try { writeFileSync(OUT, JSON.stringify({ results, trace, crashed: String(e) }, null, 2)); } catch { /* best effort */ } process.exit(1); });
const trace = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------- fixtures (SYNTHETIC creds/config, REAL files)
rmSync(WORK, { recursive: true, force: true });
const dirs = Object.fromEntries(['consented', 'unconsented', 'excluded', 'other'].map((n) => [n, join(WORK, 'ws', n)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
w(join(CH, 'codemie-cli.config.json'), {
  version: 2,
  activeProfile: PROFILE,
  profiles: { [PROFILE]: { provider: 'anthropic-subscription', codeMieProject: 'global-proj', codeMieUrl: URL_, model: 'x' } },
});
// the consented folder resolves to the work project through its workspace config (as a real work checkout does)
w(join(dirs.consented, '.codemie', 'codemie-cli.config.json'), {
  version: 2,
  activeProfile: PROFILE,
  profiles: { [PROFILE]: { provider: 'anthropic-subscription', model: 'x' } },
  workspace: { codeMieProject: 'work-proj', codeMieUrl: URL_ },
});
w(join(HOME, '.claude.json'), { oauthAccount: { organizationName: 'Personal Org (synthetic)' } });
w(join(HOME, '.claude', 'settings.json'), {});
const distImport = (p) => import(pathToFileURL(join(CLI, 'dist', p)).href);
const { CredentialStore } = await distImport('utils/security.js');
await CredentialStore.getInstance().storeSSOCredentials(
  { cookies: { codemie_access_token: jwt }, apiUrl: URL_, expiresAt: 4102444800000 },
  URL_
);

const fast = { OTLP_SEND_INTERVAL_MINUTES: '0.02', OTLP_SEND_MAX_ATTEMPTS: '1', OTLP_ALLOW_HOOKS_ONLY_FORWARD: 'true' };
const childEnv = (cwd) => ({ ...process.env, ...fast, ...(cwd ? { CLAUDE_PROJECT_DIR: cwd } : {}) });
const stateFile = join(CH, 'proxy-daemon.json');
const daemonLog = openSync(join(WORK, 'daemon.log'), 'w');
const daemon = spawn(
  process.execPath,
  ['--import', REG, join(CLI, 'bin', 'proxy-daemon.js'), '--target-url', URL_, '--provider', 'ai-run-sso', '--profile', PROFILE,
    '--gateway-key', 'e2e-gateway-key', '--client-type', 'claude-code-otlp', '--state-file', stateFile, '--sync-codemie-url', URL_],
  { env: childEnv(), stdio: ['ignore', daemonLog, daemonLog] }
);
process.on('exit', () => { try { daemon.kill(); } catch { /* already gone */ } closeSync(daemonLog); });
for (let i = 0; i < 60 && !(existsSync(stateFile) && JSON.parse(readFileSync(stateFile, 'utf8')).port > 0); i++) await new Promise((r) => setTimeout(r, 500));
if (!existsSync(stateFile)) { console.error('daemon did not start; see', join(WORK, 'daemon.log')); process.exit(2); }
const node = (args, opts = {}) =>
  spawnSync(process.execPath, ['--import', REG, ...args], { encoding: 'utf8', timeout: 90_000, env: childEnv(opts.cwd), ...opts });

// ---------------------------------------------------------------- helpers
const transcripts = join(WORK, 'transcripts');
const origSid = readFileSync(TRANSCRIPT, 'utf8').match(/"sessionId":"([^"]+)"/)[1];
function transcriptFor(sid) {
  const p = join(transcripts, `${sid}.jsonl`);
  if (!existsSync(p)) {
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(p, readFileSync(TRANSCRIPT, 'utf8').split(origSid).join(sid));
  }
  return p;
}
const newSid = () => randomUUID();

function hook(label, ev, sid, cwd, extra = {}) {
  const input = { hook_event_name: ev, session_id: sid, cwd: win(cwd), transcript_path: transcriptFor(sid), ...extra };
  const r = node([join(CLI, 'bin', 'codemie.js'), 'hook', '--agent', 'claude-code-otlp'], { input: JSON.stringify(input), cwd });
  trace.push({ step: label, kind: 'REPLAY hook (real CLI process)', event: ev, session: sid.slice(0, 8), exit: r.status, stdout: (r.stdout || '').trim().slice(0, 500) });
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The real daemon forwards on its own timer: wait until the session is stored (expect) or long enough for several
// forwarding passes to have run (a negative assertion).
async function tick(label, sid, expect = false) {
  if (expect) {
    for (let i = 0; i < 60; i++) {
      if ((await hookCountOf(sid)) > 0) break;
      await sleep(1000);
    }
    await sleep(2500);
  } else await sleep(Number(process.env.E2E_NEGATIVE_WAIT_MS || 6000));
  trace.push({ step: label, kind: 'waited for the real daemon forwarder', session: sid.slice(0, 8), expect });
}
function cli(label, args, cwd = CLI) {
  // NODE_ENV=test: bin/codemie.js skips its self-update check, which would otherwise `npm install -g` the INSTALLED CLI
  // from a fresh CODEMIE_HOME. Hook processes skip it by themselves.
  const r = node([join(CLI, 'bin', 'codemie.js'), ...args], { cwd, env: { ...childEnv(cwd), NODE_ENV: 'test' } });
  trace.push({ step: label, kind: 'real CLI command', args: args.join(' '), exit: r.status, stdout: (r.stdout || '').trim().slice(0, 300), stderr: (r.stderr || '').trim().slice(0, 300) });
  return r;
}
const retry = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 500)); } } };
const get = (path) => retry(async () => (await fetch(`${API}${path}`)).json());
const post = (path, body) => retry(async () => (await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json());
const stored = (sid) => get(`/_e2e/session/${sid}`);
const visible = async (sid, viewer, role) => (await get(`/_e2e/visible/${sid}?viewer=${encodeURIComponent(viewer)}&role=${role}`)).allowed;
const wire = (sid) => get(`/_e2e/requests?sid=${sid}`);
const hookCountOf = async (sid) => (await stored(sid)).log_events;
const markerDir = join(CH, 'analytics', 'state', 'evidence');
const markers = () => (existsSync(markerDir) ? readdirSync(markerDir).filter((f) => f.endsWith('.stop.json')) : []);
const markerOf = (sid) => {
  for (const f of markers()) {
    const j = JSON.parse(readFileSync(join(markerDir, f), 'utf8'));
    if (j.session_id === sid) return j;
  }
  return null;
};
const dropPolicyCache = () => {
  if (existsSync(markerDir)) for (const f of readdirSync(markerDir)) if (f.endsWith('.policy.json')) rmSync(join(markerDir, f));
};
const session = async (label, cwd) => {
  const sid = newSid();
  hook(`${label}: SessionStart`, 'SessionStart', sid, cwd, { source: 'startup' });
  hook(`${label}: Stop`, 'Stop', sid, cwd);
  return sid;
};

// ================================================================ scenarios
await post('/_e2e/contracts/on');

// 0. connect (REAL command), then consented personal-subscription work, visible to admins only
const connect = cli('connect-folder consented', ['proxy', 'analytics', 'connect-folder', win(dirs.consented), '--project', 'work-proj', '--yes']);
check('connect-folder exits 0', connect.status === 0, trace.at(-1));

const c1 = await session('consented c1', dirs.consented);
await tick('c1', c1, true);
const c1s = await stored(c1);
check('consented session is stored under the canonical project with origin linked_folder',
  c1s.dims[0]?.project_name === 'work-proj' && c1s.dims[0]?.project_origin === 'linked_folder', c1s);
check('consented session stored owner-attributed', (c1s.dims[0]?.owner_email || '').toLowerCase() === USER, c1s);
check('consented session wrote events', c1s.log_events > 0, c1s);
check('reader: super admin reads the consented session', await visible(c1, 'admin@example.invalid', 'super'));
check('reader: work-proj admin reads the consented session', await visible(c1, 'pa@example.invalid', 'project_admin'));
check('reader: another project admin does not', !(await visible(c1, 'x@example.invalid', 'other_admin')));
check('reader: the non-admin owner gains no access', !(await visible(c1, USER, 'owner')));
const c1w = await wire(c1);
const c1h = c1w[0]?.headers || {};
check('wire: contract, funding and consent headers sent from the frozen record',
  c1h['x-codemie-publication-contract'] === '1' && !!c1h['x-codemie-funding-route'] && c1h['x-codemie-work-consent'] === 'explicit-folder', c1h);

// 1. no consent -> personal, owner-only storage
const u1 = await session('unconsented u1', dirs.unconsented);
await tick('u1', u1, true);
const u1s = await stored(u1);
check('unconsented session is stored as personal', u1s.dims[0]?.project_origin === 'personal', u1s);
check('reader: the owner reads the personal session', await visible(u1, USER, 'owner'));
check('reader: a super admin does not read the personal session', !(await visible(u1, 'admin@example.invalid', 'super')));
const u1h = (await wire(u1))[0]?.headers || {};
check('wire: no consent header without consent', u1h['x-codemie-work-consent'] === undefined, u1h);

// 2. disabled and excluded
w(join(CH, 'claude-analytics.json'), { enabled: false });
const d1 = await session('disabled d1', dirs.consented);
await tick('d1', d1);
check('disabled: nothing stored, no marker', (await stored(d1)).dims.length === 0 && !markerOf(d1), await stored(d1));
w(join(CH, 'claude-analytics.json'), { enabled: true, excludedProjects: [win(dirs.excluded)] });
const x1 = await session('excluded x1', dirs.excluded);
await tick('x1', x1);
check('excluded: nothing stored, no marker', (await stored(x1)).dims.length === 0 && !markerOf(x1), await stored(x1));
w(join(CH, 'claude-analytics.json'), { enabled: true, excludedProjects: [] });

// 3. /clear: the old id ends, the new id starts fresh and is consented
hook('clear: old SessionEnd(clear)', 'SessionEnd', c1, dirs.consented, { reason: 'clear' });
const c2 = newSid();
hook('clear: new SessionStart(clear)', 'SessionStart', c2, dirs.consented, { source: 'clear' });
hook('clear: new Stop', 'Stop', c2, dirs.consented);
await tick('c2', c2, true);
check('/clear: the new session is consented and stored', (await stored(c2)).dims[0]?.project_origin === 'linked_folder', await stored(c2));

// 4. resume / fork of an unknown session: stopped, nothing published, the user is told once
const r1 = newSid();
const rs = hook('resume r1: SessionStart(resume)', 'SessionStart', r1, dirs.consented, { source: 'resume' });
hook('resume r1: Stop', 'Stop', r1, dirs.consented);
await tick('r1', r1);
check('resume of an unrecorded session: stop marker written', markerOf(r1)?.stop === true, markerOf(r1));
check('resume of an unrecorded session: nothing stored', (await stored(r1)).dims.length === 0, await stored(r1));
let notice;
try { notice = JSON.parse(rs.stdout.trim().split('\n').at(-1)); } catch { notice = null; }
check('notification: the hook prints one user-visible systemMessage and does not block Claude',
  /paused for this session/.test(notice?.systemMessage || '') && notice?.decision === undefined && rs.status === 0, { stdout: rs.stdout, exit: rs.status });
const again = hook('resume r1: later hook', 'UserPromptSubmit', r1, dirs.consented, { prompt: 'hi' });
check('notification is shown once, not on every hook', !/paused/.test(again.stdout || ''), again.stdout);

// 5-7. a session that already published is then stopped (folder change, disable+re-enable, consent revoked): the later hook
// spools nothing and no further request for it reaches the backend, and its stored rows stay.
async function stoppedAfter(label, sid, reason, trigger) {
  await tick(label, sid, true);
  const rows = await hookCountOf(sid);
  const requests = (await wire(sid)).length;
  trigger();
  await tick(`${label} after`, sid);
  const m = markerOf(sid);
  check(`${label}: stop marker written (${reason})`, m?.stop === true && m?.reason === reason, m);
  check(`${label}: no further request reached the backend`, (await wire(sid)).length === requests && rows > 0, { requests, now: (await wire(sid)).length, rows });
  check(`${label}: the already published rows stay`, (await hookCountOf(sid)) === rows, { rows, now: await hookCountOf(sid) });
}
const f1 = await session('folder f1', dirs.consented);
await stoppedAfter('folder change', f1, 'folder_changed', () => hook('folder f1: Stop from another folder', 'Stop', f1, dirs.unconsented));
const g1 = await session('generation g1', dirs.consented);
await stoppedAfter('disable then re-enable', g1, 'generation_changed', () => {
  cli('disable analytics', ['proxy', 'analytics', 'disable']);
  cli('enable analytics', ['proxy', 'analytics', 'enable']);
  hook('generation g1: Stop after re-enable', 'Stop', g1, dirs.consented);
});
const v1 = await session('revoke v1', dirs.consented);
await stoppedAfter('consent revoked', v1, 'consent_revoked', () => {
  cli('disconnect-folder consented', ['proxy', 'analytics', 'disconnect-folder', win(dirs.consented)]);
  hook('revoke v1: Stop', 'Stop', v1, dirs.consented);
});
cli('connect-folder consented again', ['proxy', 'analytics', 'connect-folder', win(dirs.consented), '--project', 'work-proj', '--yes']);

// 8. no duplicate consumption: replaying the same hooks and ticking again adds no rows
const before = await hookCountOf(c2);
hook('replay c2: Stop again', 'Stop', c2, dirs.consented);
await tick('c2 replay', c2);
check('no duplicate consumption: replayed hook adds no events', (await hookCountOf(c2)) === before, { before, after: await hookCountOf(c2) });

// 9. old backend (setting off): held, never reported as success; delivered once the backend advertises the contract
await post('/_e2e/contracts/off');
dropPolicyCache();
const o1 = await session('old-backend o1', dirs.consented);
await tick('o1 while off', o1);
check('old backend: nothing stored while the setting is off', (await stored(o1)).dims.length === 0, await stored(o1));
check('old backend: no request carried the contract to a legacy backend',
  (await wire(o1)).every((r) => r.headers['x-codemie-publication-contract'] === undefined) , await wire(o1));
hook('old-backend o1: later hook', 'UserPromptSubmit', o1, dirs.consented, { prompt: 'hi' });
const oOut = trace.filter((t) => t.session === o1.slice(0, 8)).map((t) => t.stdout || '').join(' ');
check('old backend: the user is told once that the backend is not ready (notice)', /not ready/.test(oOut) && (oOut.match(/paused for this session/g) || []).length === 1, oOut);
await post('/_e2e/contracts/on');
dropPolicyCache();
await tick('o1 after on', o1, true);
check('old backend: the held session is published once the contract is advertised', (await stored(o1)).dims[0]?.project_origin === 'linked_folder', await stored(o1));

// 10. SYNTHETIC canned backend responses: 422 requires-session and an accepted answer without the contract echo
const q1 = await session('requires-session q1', dirs.consented);
await post('/_e2e/fault', { sid: q1, status: 422, body: { reason: 'publication_contract_requires_session', disposition: 'discard' } });
await tick('q1', q1);
check('SYNTHETIC 422 requires_session: the session is stopped', markerOf(q1)?.stop === true && markerOf(q1)?.reason === 'requires_session', markerOf(q1));
const e1 = await session('no-echo e1', dirs.consented);
await post('/_e2e/fault', { sid: e1, status: 200, body: { accepted: 5, dropped: 0 } });
await tick('e1', e1);
check('SYNTHETIC 200 without contract echo: never acknowledged, the session is stopped', markerOf(e1)?.reason === 'response_unverified', markerOf(e1));

// ================================================================ result
writeFileSync(OUT, JSON.stringify({ results, trace }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
