// Smoke test of the isolated pipeline:
//   real hook process (bin/codemie.js hook) -> temp spool -> real proxy daemon/forwarder (dist) -> fake backend
//   native OTLP/JSON log records POSTed to the isolated daemon like Claude Code does.
// Gate rule being proven: a session with hook events AND native OTel is forwarded (hooks + OTel);
// a session with ONLY native OTel records is never forwarded (completeness gate skips it).
// usage: node tests/live/claude-code-otlp-sessions/scripts/smoke.mjs [--keep]
import { randomUUID } from 'node:crypto';
import { createTestEnv } from '../lib/env.mjs';
import { createFakeBackend } from '../lib/fake-backend.mjs';
import { startDaemon, runHook, hookInput } from '../lib/daemon.mjs';
import { native, postLogs } from '../lib/otlp-records.mjs';
import { ordinarySession, writeTranscript, MODEL } from '../lib/transcripts.mjs';

const keep = process.argv.includes('--keep');
const te = createTestEnv({ keep });
const backend = await createFakeBackend();
let daemon;
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed += 1; };

try {
  console.log(`isolated root : ${te.root}`);
  console.log(`fake backend  : ${backend.url}`);
  daemon = await startDaemon(te, backend);
  console.log(`daemon        : ${daemon.url} (pid ${daemon.pid}, state ${daemon.stateFile})`);

  // --- Session T: tracked (hooks) + native OTel ---
  const T = randomUUID();
  const proj = te.project('smoke-project');
  const transcript = proj.transcriptPath(T);
  writeTranscript(transcript, ordinarySession(T, new Date(Date.now() - 600_000).toISOString(), { prompts: 2 }));
  const now = Date.now();
  const nativeStatus = await postLogs(daemon, [
    native.user_prompt(T, now, { prompt_length: 8 }),
    native.api_request(T, now + 500),
  ]);
  check(nativeStatus === 200, `daemon accepted native OTLP logs for tracked session (HTTP ${nativeStatus})`);
  const hooks = [];
  for (const [name, extra] of [['SessionStart', { source: 'startup', model: MODEL }], ['Stop', {}], ['SessionEnd', { reason: 'other' }]]) {
    const r = await runHook(te, hookInput({ sessionId: T, transcriptPath: transcript, cwd: proj.cwd, name, ...extra }));
    hooks.push({ name, code: r.code, ms: r.durationMs });
    if (r.code !== 0) console.log(`hook ${name} exit ${r.code}\n${r.stderr.slice(-600)}`);
  }
  console.log('hooks run     :', hooks.map((h) => `${h.name}(exit ${h.code}, ${h.ms}ms)`).join(', '));

  // --- Session O: OTel only (no hook ever fires for it) ---
  const O = randomUUID();
  await postLogs(daemon, [native.hook_registered(O, now), native.user_prompt(O, now + 100)]);

  const delivered = await backend.waitFor(() => backend.hookEvents().some((e) => e.session_id === T) && backend.otlpLogRecords().length > 0, { timeoutMs: 20_000 });
  check(delivered, 'hook events and native OTel for the tracked session reached the fake backend');

  // Outwait the OTel-only skip window (OTLP_SEND_MAX_ATTEMPTS=3 ticks of ~1.2 s) with margin.
  await new Promise((r) => setTimeout(r, 9_000));

  const attrOf = (rec, k) => rec.attributes?.find((a) => a.key === k)?.value?.stringValue;
  const logsT = backend.otlpLogRecords().filter((r) => attrOf(r, 'session.id') === T);
  const logsO = backend.otlpLogRecords().filter((r) => attrOf(r, 'session.id') === O);
  const evT = backend.hookEvents().filter((e) => e.session_id === T);

  console.log('\nbackend received:');
  for (const r of backend.requests) {
    console.log(`  +${String(r.tRelMs).padStart(6)}ms ${r.method} ${r.path}  ${r.bodyBytes}B  auth=${r.headers.cookie ? 'cookie' : r.headers.authorization ? 'bearer' : '-'} ctr=${r.headers['x-codemie-publication-contract'] ?? '-'}`);
  }
  console.log(`\nhook events for T : ${evT.map((e) => e.type ?? e.hook_event_name).join(', ') || '(none)'}`);
  console.log(`native logs for T : ${logsT.map((r) => attrOf(r, 'event.name')).join(', ') || '(none)'}`);
  console.log(`native logs for O : ${logsO.map((r) => attrOf(r, 'event.name')).join(', ') || '(none)'}`);

  check(evT.length > 0, 'tracked session: hook events forwarded');
  check(logsT.length >= 2, 'tracked session: native OTel records forwarded (hooks + OTel)');
  check(logsO.length === 0, 'OTel-only session: native records NEVER forwarded (completeness gate)');
  check(backend.requests.every((r) => r.headers.host?.startsWith('127.0.0.1')), 'every outbound request went to the fake backend on 127.0.0.1');
} catch (e) {
  failed += 1;
  console.error('SMOKE ERROR:', e?.stack ?? e);
  if (daemon) console.error('--- daemon log tail ---\n' + daemon.log().slice(-3000));
} finally {
  await daemon?.stop();
  await backend.stop();
  te.cleanup();
}
console.log(failed ? `\nSMOKE FAILED (${failed})` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
