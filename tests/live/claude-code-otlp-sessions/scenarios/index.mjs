// Scenarios of the live suite. Each one drives the real hook process and the real daemon/forwarder and
// returns what the fake backend received for its sessions (`observe`). Checks are written for the
// FIXED behaviour; the same file run against a clean origin/main build (LIVE_REPO_ROOT) shows the bug.
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, hookInput } from '../lib/daemon.mjs';
import { native, postLogs } from '../lib/otlp-records.mjs';
import {
  MODEL, L, ts, writeTranscript, appendTranscript, ordinarySession, continuation, copiedNoUuidLines,
  continuationHousekeeping, exitCommandLines, continuedInRecord, reopenRecords, reopenWithPrompt,
} from '../lib/transcripts.mjs';

const T0 = '2026-11-01T17:44:35.647Z';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attrOf = (rec, key) => rec.attributes?.find((a) => a.key === key)?.value?.stringValue;
const nanoToMs = (n) => Number(BigInt(n) / 1_000_000n);

/** What the backend received for one session, in the terms the tickets are about. */
export function observe(backend, sid, markMs = 0) {
  const events = backend.hookEvents().filter((e) => e.session_id === sid);
  const types = {};
  for (const e of events) types[e.type ?? e.hook_event_name] = (types[e.type ?? e.hook_event_name] ?? 0) + 1;
  const usage = new Map();
  for (const e of events.filter((x) => x.type === 'agent.usage.request')) usage.set(`${e.request_id}|${e.message_id}`, e);
  const summaries = events.filter((e) => e.type === 'agent.session.summary');
  const last = summaries.filter((s) => s.is_final).at(-1) ?? summaries.at(-1) ?? null;
  const logs = backend.otlpLogRecords().filter((r) => attrOf(r, 'session.id') === sid);
  const hookTs = events.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
  const nativeTs = logs.map((r) => nanoToMs(r.timeUnixNano));
  const allTs = [...hookTs, ...nativeTs];
  return {
    hookEventTypes: types,
    usageRequests: usage.size,
    outputTokens: [...usage.values()].reduce((s, e) => s + (e.output_tokens ?? 0), 0),
    summaries: summaries.length,
    summary: last && { started_at: last.started_at, ended_at: last.ended_at, duration_ms: last.duration_ms, turns: last.turns, tool_calls: last.tool_calls },
    nativeForwarded: logs.map((r) => attrOf(r, 'event.name')),
    forwardedAfterMark: markMs ? allTs.filter((t) => t >= markMs).length : null,
    lastForwardedTs: allTs.length ? new Date(Math.max(...allTs)).toISOString() : null,
  };
}

/** Shared helpers for a scenario. */
function toolkit({ te, backend, daemon }) {
  const fire = async (sid, proj, name, extra = {}) => {
    const r = await runHook(te, hookInput({ sessionId: sid, transcriptPath: proj.transcriptPath(sid), cwd: proj.cwd, name, ...extra }));
    if (r.code !== 0) throw new Error(`hook ${name} for ${sid} exited ${r.code}: ${r.stderr.slice(-400)}`);
    return r;
  };
  const run = async (sid, proj, steps) => { for (const [name, extra] of steps) await fire(sid, proj, name, extra); };
  const standard = [['SessionStart', { source: 'startup', model: MODEL }], ['Stop', {}], ['SessionEnd', { reason: 'other' }]];
  const startup = [native.hook_registered, native.plugin_loaded, native.managed_settings_resolved, native.mcp_server_connection, native.hook_execution_start, native.hook_execution_complete];
  const postStartupRecords = (sid, atMs = Date.now()) => postLogs(daemon, startup.map((b, i) => b(sid, atMs + i * 40)));
  const settle = (ms = 9000) => sleep(ms);
  return { fire, run, standard, postStartupRecords, settle, te, backend, daemon };
}

const ok = (cond, message) => ({ ok: Boolean(cond), message });

export const scenarios = [
  {
    id: 'S1-ordinary-session',
    title: 'Ordinary session: usage, summary and native records are all forwarded (no regression)',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s1');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await postLogs(ctx.daemon, [native.user_prompt(sid, Date.now()), native.api_request(sid, Date.now() + 200)]);
      await k.run(sid, proj, k.standard);
      await k.settle();
      const o = observe(ctx.backend, sid);
      return { observed: o, checks: [
        ok(o.usageRequests === 6, `6 usage requests forwarded (got ${o.usageRequests})`),
        ok(o.summary?.started_at === T0, `summary starts at the first line (got ${o.summary?.started_at})`),
        ok(o.nativeForwarded.length === 2, `2 native records forwarded (got ${o.nativeForwarded.length})`),
      ] };
    },
  },
  {
    id: 'S2-continuation-no-own-work',
    title: '16992: continuation with only copies, synthetic placeholder and /exit lines reports nothing',
    async run(ctx) {
      const k = toolkit(ctx);
      const [P, C] = [randomUUID(), randomUUID()];
      const proj = ctx.te.project('s2');
      const { parentLines, childLines } = continuation({ parentSid: P, childSid: C, parentPrompts: 4 });
      writeTranscript(proj.transcriptPath(P), parentLines);
      writeTranscript(proj.transcriptPath(C), [...childLines, ...continuationHousekeeping(C, '2026-11-10T16:23:52.000Z'), ...exitCommandLines(C, '2026-11-10T16:23:53.000Z')]);
      await k.run(C, proj, k.standard);
      await k.settle();
      const o = observe(ctx.backend, C);
      return { observed: o, checks: [
        ok(o.usageRequests === 0, `0 usage requests (got ${o.usageRequests})`),
        ok(o.outputTokens === 0, `0 output tokens (got ${o.outputTokens})`),
        ok(!o.summary, `no summary (got ${JSON.stringify(o.summary)})`),
      ] };
    },
  },
  {
    id: 'S3-continuation-uuidless-copies',
    title: '16992 criterion 2: continuation whose copies include uuid-less lines starts at its own first line',
    async run(ctx) {
      const k = toolkit(ctx);
      const [P, C] = [randomUUID(), randomUUID()];
      const proj = ctx.te.project('s3');
      const ownStart = '2026-11-10T16:23:52.000Z';
      const own = [L.user(C, 'c-own-u', ownStart, 'own prompt'), L.assistant(C, 'c-own-a', 'msg-c-own', ts(ownStart, 5), { out: 321 })];
      const { parentLines, childLines } = continuation({ parentSid: P, childSid: C, noUuidCopies: true, own });
      writeTranscript(proj.transcriptPath(P), parentLines);
      writeTranscript(proj.transcriptPath(C), childLines);
      await k.run(C, proj, k.standard);
      await k.settle();
      const o = observe(ctx.backend, C);
      return { observed: o, checks: [
        ok(o.usageRequests === 1 && o.outputTokens === 321, `only the own request (got ${o.usageRequests} / ${o.outputTokens} tokens)`),
        ok(o.summary?.started_at === ownStart, `Started = own start ${ownStart} (got ${o.summary?.started_at})`),
        ok(o.summary?.turns === 1, `1 turn (got ${o.summary?.turns})`),
      ] };
    },
  },
  {
    id: 'S4-continuation-qa-case',
    title: '16992 QA case: uuid-less copies, then only a local /exit; Started must not be the parent\'s',
    async run(ctx) {
      const k = toolkit(ctx);
      const [P, C] = [randomUUID(), randomUUID()];
      const proj = ctx.te.project('s4');
      const { parentLines, childLines } = continuation({ parentSid: P, childSid: C, noUuidCopies: true, own: exitCommandLines(randomUUID(), '2026-11-10T16:23:52.000Z') });
      writeTranscript(proj.transcriptPath(P), parentLines);
      writeTranscript(proj.transcriptPath(C), childLines);
      await k.run(C, proj, k.standard);
      await k.settle();
      const o = observe(ctx.backend, C);
      return { observed: o, checks: [
        ok(o.usageRequests === 0, `0 usage requests (got ${o.usageRequests})`),
        ok(!o.summary || o.summary.started_at >= '2026-11-10', `no summary dated before the continuation (got ${o.summary?.started_at})`),
      ] };
    },
  },
  {
    id: 'S5-parent-and-child-both-reported-once',
    title: '16992: the parent keeps its own figures when the child is reported too',
    async run(ctx) {
      const k = toolkit(ctx);
      const [P, C] = [randomUUID(), randomUUID()];
      const proj = ctx.te.project('s5');
      const own = [L.user(C, 'c5-u', '2026-11-10T16:23:52.000Z', 'x'), L.assistant(C, 'c5-a', 'msg-c5', '2026-11-10T16:23:57.000Z', { out: 77 })];
      const { parentLines, childLines } = continuation({ parentSid: P, childSid: C, own });
      writeTranscript(proj.transcriptPath(P), parentLines);
      writeTranscript(proj.transcriptPath(C), childLines);
      await Promise.all([k.run(P, proj, k.standard), k.run(C, proj, k.standard)]);
      await k.settle();
      const p = observe(ctx.backend, P);
      const c = observe(ctx.backend, C);
      return { observed: { parent: p, child: c }, checks: [
        ok(p.usageRequests === 12, `parent keeps its 12 requests (got ${p.usageRequests})`),
        ok(c.usageRequests === 1 && c.outputTokens === 77, `child reports its own request only (got ${c.usageRequests} / ${c.outputTokens})`),
      ] };
    },
  },
  {
    id: 'S6-late-parent-record',
    title: '16992 (accepted D-2): parent record lands after the first pass; later passes send only own work',
    async run(ctx) {
      const k = toolkit(ctx);
      const [P, C] = [randomUUID(), randomUUID()];
      const proj = ctx.te.project('s6');
      const base = ordinarySession(P, T0, { prompts: 2 });
      const { childLines } = continuation({ parentSid: P, childSid: C, parentPrompts: 2 });
      writeTranscript(proj.transcriptPath(P), base);
      writeTranscript(proj.transcriptPath(C), childLines);
      await k.run(C, proj, [['SessionStart', { source: 'startup', model: MODEL }], ['Stop', {}]]);
      await k.settle(5000);
      const before = observe(ctx.backend, C);
      appendTranscript(proj.transcriptPath(P), [continuedInRecord(P, C, '2026-11-01T19:43:28.390Z')]);
      appendTranscript(proj.transcriptPath(C), [L.user(C, 'c6-u', '2026-11-10T16:23:52.000Z', 'x'), L.assistant(C, 'c6-a', 'msg-c6', '2026-11-10T16:23:57.000Z', { out: 55 })]);
      await k.run(C, proj, [['Stop', {}], ['SessionEnd', { reason: 'other' }]]);
      await k.settle();
      const after = observe(ctx.backend, C);
      return { observed: { afterFirstPass: before, afterAll: after }, checks: [
        ok(after.usageRequests === before.usageRequests + 1, `second pass adds only the own request (${before.usageRequests} -> ${after.usageRequests})`),
      ] };
    },
  },
  {
    id: 'S7-reopen-idle-hook-first',
    title: '16993: reopen without a prompt; native startup records arrive AFTER the SessionStart(resume) hook',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s7');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, k.standard);
      await k.settle(5000);
      const mark = Date.now();
      appendTranscript(proj.transcriptPath(sid), reopenRecords(sid, new Date(mark).toISOString()));
      await k.fire(sid, proj, 'SessionStart', { source: 'resume', model: MODEL });
      await k.postStartupRecords(sid);
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      await k.settle();
      const o = observe(ctx.backend, sid, mark);
      return { observed: o, checks: [
        ok(o.forwardedAfterMark === 0, `nothing stamped at or after the reopen reaches the backend (got ${o.forwardedAfterMark})`),
        ok(o.usageRequests === 6, `usage unchanged: 6 requests (got ${o.usageRequests})`),
      ] };
    },
  },
  {
    id: 'S8-reopen-idle-native-first',
    title: '16993 race: native startup records arrive BEFORE the SessionStart(resume) hook has marked the reopen',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s8');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, k.standard);
      await k.settle(5000);
      const mark = Date.now();
      appendTranscript(proj.transcriptPath(sid), reopenRecords(sid, new Date(mark).toISOString()));
      await k.postStartupRecords(sid, mark);
      await k.fire(sid, proj, 'SessionStart', { source: 'resume', model: MODEL });
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      await k.settle();
      const o = observe(ctx.backend, sid, mark);
      return { observed: o, checks: [
        ok(o.forwardedAfterMark === 0, `nothing stamped at or after the reopen reaches the backend (got ${o.forwardedAfterMark})`),
      ] };
    },
  },
  {
    id: 'S9-reopen-then-prompt',
    title: '16993: a reopened session that then does real work reports that work and its held records',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s9');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, k.standard);
      await k.settle(5000);
      const mark = Date.now();
      appendTranscript(proj.transcriptPath(sid), reopenRecords(sid, new Date(mark).toISOString()));
      await k.fire(sid, proj, 'SessionStart', { source: 'resume', model: MODEL });
      await k.postStartupRecords(sid);
      const t = new Date().toISOString();
      appendTranscript(proj.transcriptPath(sid), reopenWithPrompt(sid, t, { out: 123 }));
      await postLogs(ctx.daemon, [native.user_prompt(sid, Date.now()), native.api_request(sid, Date.now() + 300)]);
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      await k.settle();
      const o = observe(ctx.backend, sid, mark);
      return { observed: o, checks: [
        ok(o.usageRequests === 7, `the new request is reported: 7 requests (got ${o.usageRequests})`),
        ok(o.nativeForwarded.includes('api_request') && o.nativeForwarded.includes('user_prompt'), `native records of the active reopen are forwarded (got ${o.nativeForwarded.join(',')})`),
      ] };
    },
  },
  {
    id: 'S10-ordinary-resume-sources',
    title: 'startup/clear sources: native records of a session that was not reopened are never held',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s10');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, [['SessionStart', { source: 'startup', model: MODEL }], ['Stop', {}]]);
      await k.fire(sid, proj, 'SessionStart', { source: 'clear', model: MODEL });
      await k.postStartupRecords(sid);
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'clear' }]]);
      await k.settle();
      const o = observe(ctx.backend, sid);
      return { observed: o, checks: [
        ok(o.nativeForwarded.length === 6, `all 6 native records forwarded (got ${o.nativeForwarded.length})`),
        ok(o.usageRequests === 6, `usage reported once: 6 (got ${o.usageRequests})`),
      ] };
    },
  },
  {
    id: 'S11-reopen-after-spool-swept',
    title: '16993: reopen days later, after the sweep has already removed the spool of the session (the reporter case)',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s11');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, k.standard);
      await k.settle(5000);
      // What the sweep does once a session has been quiet past its grace: its spool and status files are gone.
      const spoolDir = join(ctx.te.codemieHome, 'proxy', 'otlp-spool');
      for (const f of readdirSync(spoolDir).filter((f) => f.startsWith(sid))) rmSync(join(spoolDir, f), { force: true });
      const mark = Date.now();
      appendTranscript(proj.transcriptPath(sid), reopenRecords(sid, new Date(mark).toISOString()));
      await k.fire(sid, proj, 'SessionStart', { source: 'resume', model: MODEL });
      await k.postStartupRecords(sid);
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      await k.settle();
      const o = observe(ctx.backend, sid, mark);
      return { observed: o, checks: [
        ok(o.forwardedAfterMark === 0, `nothing stamped at or after the reopen reaches the backend (got ${o.forwardedAfterMark})`),
      ] };
    },
  },
  {
    id: 'S12-two-idle-reopens-then-work',
    title: '16993: two prompt-less reopens in a row change nothing; real work afterwards is reported once',
    async run(ctx) {
      const k = toolkit(ctx);
      const sid = randomUUID();
      const proj = ctx.te.project('s12');
      writeTranscript(proj.transcriptPath(sid), ordinarySession(sid, T0, { prompts: 2 }));
      await k.run(sid, proj, k.standard);
      await k.settle(5000);
      const mark = Date.now();
      for (let i = 0; i < 2; i += 1) {
        appendTranscript(proj.transcriptPath(sid), reopenRecords(sid, new Date().toISOString()));
        await k.fire(sid, proj, 'SessionStart', { source: 'resume', model: MODEL });
        await k.postStartupRecords(sid);
        await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      }
      await k.settle(6000);
      const idle = observe(ctx.backend, sid, mark);
      appendTranscript(proj.transcriptPath(sid), reopenWithPrompt(sid, new Date().toISOString(), { out: 99 }));
      await k.run(sid, proj, [['Stop', {}], ['SessionEnd', { reason: 'prompt_input_exit' }]]);
      await k.settle();
      const after = observe(ctx.backend, sid, mark);
      return { observed: { afterIdleReopens: idle, afterWork: after }, checks: [
        ok(idle.forwardedAfterMark === 0 && idle.usageRequests === 6, `idle reopens change nothing (forwarded ${idle.forwardedAfterMark}, usage ${idle.usageRequests})`),
        ok(after.usageRequests === 7, `the new request is reported once (got ${after.usageRequests})`),
      ] };
    },
  },
];
