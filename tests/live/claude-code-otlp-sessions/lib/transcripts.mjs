// Transcript builders (line shapes copied from the external harness C:\Users\OlehPrusak\codemie-eval\harness.mjs).
// All builders return arrays of JSONL lines; writeTranscript/appendTranscript put them on disk.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MODEL = 'claude-opus-5-5';

export const ts = (base, plusSec) => new Date(Date.parse(base) + plusSec * 1000).toISOString();

/** Real Claude Code line shapes. */
export const L = {
  user: (sid, uuid, time, text) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid, sessionId: sid, timestamp: time, gitBranch: 'main', cwd: '/repo', message: { role: 'user', content: text } }),
  assistant: (sid, uuid, msgId, time, { out = 1000, tools = [], model = MODEL, input = 10, cacheRead = 50000 } = {}) =>
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'assistant', uuid, sessionId: sid, timestamp: time, gitBranch: 'main', cwd: '/repo', requestId: `req-${msgId}`,
      message: {
        id: msgId, role: 'assistant', model, stop_reason: tools.length ? 'tool_use' : 'end_turn',
        content: [{ type: 'text', text: 'ok' }, ...tools.map((t, i) => ({ type: 'tool_use', id: `tu-${msgId}-${i}`, name: t, input: t === 'Edit' ? { file_path: '/repo/a.ts' } : {} }))],
        usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: input === 0 ? 0 : 100, service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: input === 0 ? 0 : 100 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } },
      },
    }),
  record: (obj) => JSON.stringify(obj),
};

export function writeTranscript(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length ? lines.join('\n') + '\n' : '');
}
export function appendTranscript(path, lines) {
  appendFileSync(path, lines.join('\n') + '\n');
}

/** An ordinary session: `prompts` prompts, each followed by 3 assistant requests (Edit, Bash, then Agent/none). */
export function ordinarySession(sid, t0, { prompts = 4 } = {}) {
  const lines = [];
  let n = 0;
  for (let p = 0; p < prompts; p += 1) {
    lines.push(L.user(sid, `u-${p}`, ts(t0, n++), `prompt ${p}`));
    for (let r = 0; r < 3; r += 1) {
      const tools = r === 0 ? ['Edit'] : r === 1 ? ['Bash'] : p === 0 ? ['Agent'] : [];
      lines.push(L.assistant(sid, `a-${p}-${r}`, `msg-${p}-${r}`, ts(t0, n++), { out: 1000 + p * 10 + r, tools }));
    }
  }
  return lines;
}

/** Re-key the same lines to another session id (continuation copy: same uuid/ids/timestamps, sessionId rewritten). */
export const copyTo = (lines, sid) => lines.map((l) => { const o = JSON.parse(l); o.sessionId = sid; return JSON.stringify(o); });

/** Parent transcript's tail record that points at the continuation. */
export const continuedInRecord = (parentSid, childSid, time) =>
  L.record({ type: 'continued-in', timestamp: time, sessionId: parentSid, continuedInSessionId: childSid });

/**
 * Lines Claude Code copies into a continuation WITHOUT a uuid but WITH a timestamp (queue-operation,
 * file-history snapshots, attachments). They carry the parent's old times, which is how a continued
 * session's start can end up at a copied line (EPMCDME-16992 acceptance criterion 2).
 */
export function copiedNoUuidLines(childSid, t0) {
  return [
    L.record({ type: 'queue-operation', operation: 'enqueue', timestamp: t0, sessionId: childSid, content: 'copied queued prompt' }),
    L.record({ type: 'file-history-snapshot', messageId: 'snap-1', snapshot: { messageId: 'snap-1', trackedFileBackups: {}, timestamp: ts(t0, 1) }, isSnapshotUpdate: false, timestamp: ts(t0, 1), sessionId: childSid }),
  ];
}

/** The synthetic/housekeeping own lines a continuation gets before the user does anything. */
export function continuationHousekeeping(childSid, time) {
  return [
    L.record({ type: 'permission-mode', permissionMode: 'auto', sessionId: childSid }),
    L.assistant(childSid, `c-syn-${childSid.slice(0, 4)}`, `msg-syn-${childSid.slice(0, 4)}`, time, { out: 0, input: 0, cacheRead: 0, model: '<synthetic>' }),
    L.record({ type: 'last-prompt', leafUuid: 'a-3-2', sessionId: childSid }),
  ];
}

/** Own `/exit` lines of a continuation (local command records, no model request). */
export function exitCommandLines(childSid, time) {
  return [
    L.record({ type: 'user', uuid: `exit-u-${childSid.slice(0, 4)}`, parentUuid: null, isSidechain: false, sessionId: childSid, timestamp: time, message: { role: 'user', content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>' } }),
    L.record({ type: 'user', uuid: `exit-o-${childSid.slice(0, 4)}`, parentUuid: null, isSidechain: false, sessionId: childSid, timestamp: ts(time, 0.1), message: { role: 'user', content: '<local-command-stdout>Goodbye!</local-command-stdout>' } }),
  ];
}

/**
 * Continuation pair. Returns { parentLines, childLines }:
 *   parent = ordinary session + continued-in record
 *   child  = (no-uuid copies) + copies of every parent line + own lines
 */
export function continuation({ parentSid, childSid, t0 = '2026-11-01T17:44:35.647Z', continuedAt = '2026-11-01T19:43:28.390Z', parentPrompts = 4, noUuidCopies = false, own = [] }) {
  const base = ordinarySession(parentSid, t0, { prompts: parentPrompts });
  const parentLines = [...base, continuedInRecord(parentSid, childSid, continuedAt)];
  const copies = copyTo(base, childSid);
  const childLines = [...(noUuidCopies ? copiedNoUuidLines(childSid, t0) : []), ...copies, ...own];
  return { parentLines, childLines };
}

/** Records Claude Code appends when a session is reopened (resume) and nothing else happens. */
export const reopenRecords = (sid, time = '2026-11-07T18:17:46.000Z', leafUuid = 'a-0-2') => [
  L.record({ type: 'permission-mode', permissionMode: 'auto', sessionId: sid }),
  L.record({ type: 'attachment', uuid: `att-${sid}`, timestamp: time, sessionId: sid, attachment: { type: 'hook_success', hookEvent: 'SessionStart', content: '' } }),
  L.record({ type: 'last-prompt', leafUuid, sessionId: sid }),
];

/** A reopen followed by a real prompt and answer. */
export const reopenWithPrompt = (sid, t, { out = 123 } = {}) => [
  L.user(sid, `n-u-${sid.slice(0, 4)}`, t, 'new prompt'),
  L.assistant(sid, `n-a-${sid.slice(0, 4)}`, `msg-n-${sid.slice(0, 4)}`, ts(t, 5), { out, tools: ['Edit'] }),
];
