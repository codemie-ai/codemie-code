// E2E driver for Copilot CLI funding publication (EPMCDME-17845); harness shared with drive.mjs / backend_app.py.
//
// REAL: the built CLI (`codemie hook --agent copilot-cli-otlp` child processes), the REAL proxy daemon process (spool,
//   evidence records, queued forwarder) sending over HTTP, the backend's router/ingestor/SQL (Postgres) and its
//   /overview handler (api_cost_usd, subscription_cost_usd, funding buckets).
// REPLAY: hook inputs have the shape of Copilot CLI hooks; the session transcript is the repo's usage fixture
//   (events.usage-record.jsonl) with timestamps moved to today. No live Copilot CLI session is driven.
// SYNTHETIC: credentials/JWT, config files, the launcher's exported env (what `codemie-copilot` would set), the
//   backend's authentication and application directory (backend_app.py).
//
// Exits non-zero when any assertion fails. Results: $E2E_OUT (json).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const need = (k) => { if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(2); } return process.env[k]; };
const CLI = need('CLI_REPO');
const WORK = need('E2E_WORK');
const API = need('E2E_API');
const OUT = need('E2E_OUT');
const CH = need('CODEMIE_HOME');
const HOME = need('HOME');
const HERE = dirname(fileURLToPath(import.meta.url));
const REG = pathToFileURL(join(HERE, 'no-keytar-register.mjs')).href;
const norm = (p) => p.replace(/\\/g, '/');
if (!norm(CH).startsWith(norm(WORK)) || !norm(HOME).startsWith(norm(WORK))) { console.error('refusing: CODEMIE_HOME/HOME are not under the scratch dir'); process.exit(9); }
const USER = 'probe@example.invalid';
const URL_ = `${API}/code-assistant-api`;
const PROFILE = 'copilot-p';
const win = (p) => p.replace(/\//g, '\\');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'none' })}.${b64({ email: USER, exp: 4102444800 })}.x`;
const w = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o, null, 2)); };
const results = [];
const trace = [];
const flush = (extra = {}) => writeFileSync(OUT, JSON.stringify({ results, trace, ...extra }, null, 2));
process.on('uncaughtException', (e) => { console.error(e); try { flush({ crashed: String(e) }); } catch { /* best effort */ } process.exit(1); });
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------- fixtures (SYNTHETIC creds/config, REAL files)
rmSync(WORK, { recursive: true, force: true });
const cwd = join(WORK, 'ws', 'repo');
mkdirSync(cwd, { recursive: true });
w(join(CH, 'codemie-cli.config.json'), {
  version: 2,
  // The ACTIVE profile is another CodeMie profile with another project: a launch must never be read as this one.
  activeProfile: 'active-p',
  workspace: {}, // already-decoupled config: migration 007 must not hoist the per-profile projects into a shared workspace
  profiles: {
    [PROFILE]: { provider: 'ai-run-sso', baseUrl: URL_, codeMieUrl: URL_, codeMieProject: 'work-proj', model: 'claude-sonnet-4.6' },
    'active-p': { provider: 'ai-run-sso', baseUrl: URL_, codeMieUrl: URL_, codeMieProject: 'active-proj', model: 'claude-sonnet-4.6' },
  },
});
w(join(CH, 'copilot-connectors.json'), { version: 1, connectors: { 'copilot-cli-otlp': { enabled: true, scope: 'user' } } });
const distImport = (p) => import(pathToFileURL(join(CLI, 'dist', p)).href);
const { CredentialStore } = await distImport('utils/security.js');
await CredentialStore.getInstance().storeSSOCredentials({ cookies: { codemie_access_token: jwt }, apiUrl: URL_, expiresAt: 4102444800000 }, URL_);

const COPILOT_HOME = join(WORK, 'copilot');
const fast = { OTLP_SEND_INTERVAL_MINUTES: '0.02', OTLP_SEND_MAX_ATTEMPTS: '1', OTLP_ALLOW_HOOKS_ONLY_FORWARD: 'true', COPILOT_HOME };
const stateFile = join(CH, 'proxy-daemon.json');
const daemonLog = openSync(join(WORK, 'daemon.log'), 'w');
const daemon = spawn(process.execPath, ['--import', REG, join(CLI, 'bin', 'proxy-daemon.js'), '--target-url', URL_, '--provider', 'ai-run-sso',
  '--profile', PROFILE, '--gateway-key', 'e2e-gateway-key', '--state-file', stateFile, '--sync-codemie-url', URL_], { env: { ...process.env, ...fast }, stdio: ['ignore', daemonLog, daemonLog] });
process.on('exit', () => { try { daemon.kill(); } catch { /* already gone */ } closeSync(daemonLog); });
for (let i = 0; i < 60 && !(existsSync(stateFile) && JSON.parse(readFileSync(stateFile, 'utf8')).port > 0); i++) await new Promise((r) => setTimeout(r, 500));
if (!existsSync(stateFile)) { console.error('daemon did not start; see', join(WORK, 'daemon.log')); process.exit(2); }
const PROXY = `http://127.0.0.1:${JSON.parse(readFileSync(stateFile, 'utf8')).port}`;

// ---------------------------------------------------------------- helpers
const FIXTURE = join(CLI, 'src', 'agents', 'plugins', 'copilot-cli-otlp', '__tests__', 'fixtures', 'events.usage-record.jsonl');
const today = new Date().toISOString().slice(0, 10);
function replayTranscript(sid) {
  const dir = join(COPILOT_HOME, 'session-state', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), readFileSync(FIXTURE, 'utf8').replaceAll('2026-01-01T', `${today}T`));
}
// What `codemie-copilot` exports into the Copilot process (SYNTHETIC): launch profile, loopback proxy, upstream, BYOK provider env.
const managedEnv = (sid) => ({
  CODEMIE_SESSION_ID: 'cm-' + sid.slice(0, 8), CODEMIE_COPILOT_NATIVE_SESSION_ID: sid, CODEMIE_PROFILE_NAME: PROFILE, CODEMIE_PROJECT: 'work-proj',
  CODEMIE_PROFILE_CONFIG: JSON.stringify({ name: PROFILE, provider: 'ai-run-sso', baseUrl: URL_, codeMieProject: 'work-proj' }),
  CODEMIE_BASE_URL: PROXY, CODEMIE_TARGET_API_URL: URL_, COPILOT_PROVIDER_BASE_URL: PROXY,
});
const nativeByokEnv = { COPILOT_PROVIDER_BASE_URL: PROXY, COPILOT_PROVIDER_TYPE: 'openai' }; // BYOK flags at the CodeMie proxy, no launcher
function hook(label, ev, sid, env, extra = {}) {
  const input = { sessionId: sid, cwd: win(cwd), timestamp: Date.now(), ...extra };
  const r = spawnSync(process.execPath, ['--import', REG, join(CLI, 'bin', 'codemie.js'), 'hook', '--agent', 'copilot-cli-otlp', '--event', ev],
    { input: JSON.stringify(input), encoding: 'utf8', timeout: 90_000, cwd, env: { ...process.env, ...fast, ...env } });
  trace.push({ step: label, kind: 'REPLAY hook (real CLI process)', event: ev, session: sid.slice(0, 8), exit: r.status, stdout: (r.stdout || '').trim().slice(0, 300) });
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path, headers = {}) => {
  for (let i = 0; ; i++) {
    try { return await (await fetch(`${API}${path}`, { headers })).json(); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 700)); }
  }
};
const stored = (sid) => get(`/_e2e/session/${sid}`);
const wire = (sid) => get(`/_e2e/requests?sid=${sid}`);
async function settle(sid, expect) {
  if (expect) for (let i = 0; i < 60 && (await stored(sid)).log_events === 0; i++) await sleep(1000);
  await sleep(expect ? 3000 : Number(process.env.E2E_NEGATIVE_WAIT_MS || 8000));
}
const find = (o, key) => (o && typeof o === 'object' ? (key in o ? o[key] : Object.values(o).map((v) => find(v, key)).find((v) => v !== undefined)) : undefined);
const overview = async () => {
  trace.push({ step: 'rollup', result: await (await fetch(`${API}/_e2e/rollup`, { method: 'POST' })).text().then((t) => t.slice(0, 200)) });
  const body = await get('/code-assistant-api/v1/analytics/cli-analytics/overview?time_period=last_7_days', { 'x-e2e-user': 'admin@example.invalid' });
  trace.push({ step: 'overview', body: JSON.stringify(body).slice(0, 1500) });
  return body;
};
const session = async (label, envOf) => {
  const sid = randomUUID();
  const env = envOf(sid);
  replayTranscript(sid);
  hook(`${label}: sessionStart`, 'sessionStart', sid, env, { source: 'new' });
  hook(`${label}: agentStop`, 'agentStop', sid, env);
  hook(`${label}: sessionEnd`, 'sessionEnd', sid, env, { reason: 'complete' });
  return sid;
};
const num = (v) => (typeof v === 'number' ? v : NaN);

// ================================================================ scenarios
await get('/_e2e/health');
await fetch(`${API}/_e2e/contracts/on`, { method: 'POST' });

// 1. CodeMie-launched, proof holds: stored as codemie / api_based under the launch profile's project; overview prices it as API.
const m1 = await session('managed', managedEnv);
await settle(m1, true);
const m1s = await stored(m1);
check('managed: stored with subscription_type codemie and funding_route api_based', m1s.dims[0]?.subscription_type === 'codemie' && m1s.dims[0]?.funding_route === 'api_based', m1s);
check('managed: stored under the launch profile project (not the active profile\'s)', m1s.dims[0]?.project_name === 'work-proj', m1s);
// work-proj sits on the selected global profile and no workspace mapping exists, so the origin is exactly `profile` (not none).
check('managed: persisted project_origin is profile', m1s.dims[0]?.project_origin === 'profile', m1s.dims[0]);
const m1h =(await wire(m1))[0]?.headers || {};
check('managed: wire carries contract, funding and codemie classification', m1h['x-codemie-publication-contract'] === '1' && m1h['x-codemie-funding-route'] === 'api_based' && m1h['x-codemie-subscription-type'] === 'codemie' && m1h['x-codemie-routed-via-codemie'] === 'true' && m1h['x-codemie-project'] === 'work-proj' && m1h['x-codemie-project-source'] === 'profile', m1h);
const o1 = await overview();
const api1 = num(find(o1, 'api_cost_usd'));
const funding1 = find(o1, 'funding') || {};
check('overview: managed session cost is in api_cost_usd with zero subscription_cost_usd', api1 > 0 && find(o1, 'subscription_cost_usd') === 0, { api1, sub: find(o1, 'subscription_cost_usd') });
check('overview: managed session cost is in funding.api_based (not unknown or subscription)', num(funding1.api_based?.cost_usd) > 0 && funding1.api_based?.session_count === 1 && !funding1.unknown?.session_count && !funding1.subscription?.session_count, funding1);

// 2. Never a CodeMie funding claim: native Copilot with BYOK flags at the proxy and an active CodeMie profile, and an unrelated BYOK endpoint.
const n1 = await session('native-byok', () => nativeByokEnv);
const n2 = await session('managed-other-byok', (sid) => ({ ...managedEnv(sid), COPILOT_PROVIDER_BASE_URL: 'https://byok.example.invalid/v1' }));
await settle(n2, false);
for (const [label, sid] of [['native BYOK', n1], ['managed shell, unrelated BYOK endpoint', n2]]) {
  const s = await stored(sid);
  const h = (await wire(sid))[0]?.headers || {};
  check(`${label}: no codemie classification or api_based funding stored`, s.dims[0]?.subscription_type !== 'codemie' && s.dims[0]?.funding_route !== 'api_based', s);
  check(`${label}: no funding or codemie headers on the wire`, !h['x-codemie-funding-route'] && h['x-codemie-subscription-type'] !== 'codemie', h);
}
const o2 = await overview();
const f2 = find(o2, 'funding') || {};
check('overview: negatives add nothing to api_cost_usd or funding.api_based', num(find(o2, 'api_cost_usd')) === api1 && f2.api_based?.session_count === 1 && num(f2.api_based?.cost_usd) === num(funding1.api_based?.cost_usd), { api1, f2 });

// 3. Unpinned inherited exports (a fresh nested native Copilot after a resume/continue launch): no new claim.
const n3 = await session('unpinned-nested', (sid) => { const { CODEMIE_COPILOT_NATIVE_SESSION_ID: _pin, ...rest } = managedEnv(sid); return rest; });
await settle(n3, false);
const n3s = await stored(n3);
const n3h = (await wire(n3))[0]?.headers || {};
check('unpinned nested native: no codemie classification, api_based funding or funding header', n3s.dims[0]?.subscription_type !== 'codemie' && n3s.dims[0]?.funding_route !== 'api_based' && !n3h['x-codemie-funding-route'], { n3s, n3h });

// 4. Independent collection controls: a Claude collection-generation change must not stop a recorded Copilot session in the real daemon sender.
const g1 = randomUUID();
const g1env = managedEnv(g1);
replayTranscript(g1);
hook('generation: sessionStart', 'sessionStart', g1, g1env, { source: 'new' });
await settle(g1, true);
const { updateClaudeAnalyticsPreferences } = await distImport('agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js');
await updateClaudeAnalyticsPreferences((p) => ({ ...p, collectionGeneration: p.collectionGeneration + 1 }));
const before = (await stored(g1)).counts.usage_requests;
hook('generation: agentStop', 'agentStop', g1, g1env);
hook('generation: sessionEnd', 'sessionEnd', g1, g1env, { reason: 'complete' });
for (let i = 0; i < 40 && (await stored(g1)).counts.usage_requests === before; i++) await sleep(1000);
const g1s = await stored(g1);
check('Claude generation change: recorded Copilot session still delivers usage and keeps api_based', g1s.counts.usage_requests > before && g1s.dims[0]?.funding_route === 'api_based', { before, g1s });
check('Claude generation change: no stop marker for the Copilot session', !existsSync(join(CH, 'analytics', 'state', 'evidence')) || !readdirSync(join(CH, 'analytics', 'state', 'evidence')).some((f) => f.endsWith('.stop.json')), readdirSync(join(CH, 'analytics', 'state', 'evidence')));

// 5. Sticky boundary: a recorded session that loses route proof sends nothing more (no legacy bytes).
const s1 = randomUUID();
const s1env = managedEnv(s1);
replayTranscript(s1);
hook('sticky: sessionStart', 'sessionStart', s1, s1env, { source: 'new' });
await settle(s1, true);
const s1before = await stored(s1);
hook('sticky: agentStop (proof lost)', 'agentStop', s1, { ...s1env, COPILOT_PROVIDER_BASE_URL: 'https://byok.example.invalid/v1' });
await settle(s1, false);
const s1after = await stored(s1);
check('sticky: after lost proof no usage or events reach the backend', s1after.counts.usage_requests === s1before.counts.usage_requests && s1after.log_events === s1before.log_events && s1after.dims[0]?.funding_route === 'api_based', { s1before, s1after });

flush();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} assertions held`);
process.exit(failed.length ? 1 : 0);
