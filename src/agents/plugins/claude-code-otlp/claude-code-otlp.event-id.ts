import { createHash } from 'node:crypto';

/**
 * Deterministic `event_id` templates for the Claude Code adapter.
 *
 * The id is the backend's dedup key (`day + hash(type + session + event_id)`, first record wins),
 * so a record that can be sent again with *newer values* must get a new id, while an exact resend
 * must keep the old one. Templates therefore use a natural key only for records whose content is
 * immutable for that key (`agent.git.snapshot`'s head, the summary's phase + end time, the
 * compaction boundary). Records that grow between passes — `agent.usage.request` (more tokens as
 * the request streams), `agent.subagent.usage` (cumulative usage as the agent file grows) — include
 * their content in the id instead, so the backend stores the updated row and can max()/latest it.
 * Everything else (`agent.session.env`, native hook events) falls back to `contentKey(payload +
 * resolved timestamp)`: a repeated identical env snapshot becomes a new row, which is harmless
 * because the backend keeps the latest value by timestamp, while A → B → A is no longer dropped.
 */
type EventRecord = Record<string, unknown>;

type EventIdTemplate = (payload: EventRecord) => string | null;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `null` when a required part is missing, so the content-hash fallback applies. */
function keyed(prefix: string, ...parts: string[]): string | null {
  return parts.every((part) => part.length > 0) ? [prefix, ...parts].join(':') : null;
}

/** Stable JSON with object keys sorted at every level, so equal content serialises equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as EventRecord;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 (hex) of {@link canonicalJson} — the content-addressed discriminator. */
function contentKey(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const EVENT_ID_TEMPLATES: Record<string, EventIdTemplate> = {
  'agent.git.snapshot': (payload) => keyed('git-snapshot', str(payload['git_head_end'])),
  // These two are cumulative: a later pass re-sends them with more tokens/usage, and the backend
  // must store the newer row (it groups by request id / takes the latest subagent row).
  'agent.usage.request': (payload) => contentKey(payload),
  'agent.subagent.usage': (payload) => contentKey(payload),
  'agent.session.summary': (payload) =>
    keyed(
      'summary',
      payload['is_final'] === true ? 'final' : 'incremental',
      str(payload['timestamp']) || str(payload['started_at'])
    ),
  'agent.session.compact.done': (payload) => keyed('compact-done', str(payload['timestamp'])),
};

/**
 * The Claude `event_id` for `event`: `<type>:<session_id>:<discriminator>`. Synthetic records
 * with an immutable natural key use their template; everything else (env snapshots, native hook
 * events, unknown types, a template whose key is missing) hashes its canonical payload plus the
 * resolved timestamp.
 */
export function buildClaudeEventId(
  event: EventRecord,
  payload: EventRecord,
  timestamp: string
): string {
  const type = str(event['type']);
  const discriminator = EVENT_ID_TEMPLATES[type]?.(payload) ?? contentKey({ ...payload, timestamp });
  return `${type}:${str(event['session_id'])}:${discriminator}`;
}
