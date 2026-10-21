import { createHash } from 'node:crypto';

/**
 * Deterministic `event_id` templates for the Claude Code adapter.
 *
 * Only events this codebase builds itself — the synthetic/transcript-derived records — get a
 * template, because those are the ones whose id must survive a re-derivation (a state-loss
 * re-parse, the SessionEnd subagent backstop, a repeated `SessionStart`). Every native Claude
 * hook event is forwarded once per occurrence and never re-derived, so it needs no template: it
 * hashes its own payload plus timestamp (below).
 *
 * Every id keeps the `<type>:<session_id>:<discriminator>` shape; the templates only choose the
 * discriminator — the record's natural key where one exists, or a content hash when the record's
 * own content is its identity (`agent.session.env`). A missing natural key falls back to the same
 * content hash.
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

/** Envelope keys already encoded in the id prefix, not part of the snapshot's identity. */
const ENVELOPE_FIELDS = new Set(['type', 'session_id']);

/** `agent.session.env`'s identity is the snapshot itself, independent of the hook time. */
function snapshotIdentity(payload: EventRecord): string {
  const identity: EventRecord = {};
  for (const [field, value] of Object.entries(payload)) {
    if (!ENVELOPE_FIELDS.has(field)) identity[field] = value;
  }
  return contentKey(identity);
}

const EVENT_ID_TEMPLATES: Record<string, EventIdTemplate> = {
  'agent.session.env': (payload) => `env:${snapshotIdentity(payload)}`,
  'agent.git.snapshot': (payload) => keyed('git-snapshot', str(payload['git_head_end'])),
  'agent.usage.request': (payload) =>
    keyed('usage', str(payload['request_id']) || str(payload['message_id']), str(payload['model'])),
  'agent.subagent.usage': (payload) => keyed('subagent-usage', str(payload['agent_id'])),
  'agent.session.summary': (payload) =>
    keyed(
      'summary',
      payload['is_final'] === true ? 'final' : 'incremental',
      str(payload['timestamp']) || str(payload['started_at'])
    ),
  'agent.session.compact.done': (payload) => keyed('compact-done', str(payload['timestamp'])),
};

/**
 * The Claude `event_id` for `event`: `<type>:<session_id>:<discriminator>`. Synthetic/derived
 * records use their template; everything else (native hook events, unknown types, a template
 * whose natural key is missing) hashes its canonical payload plus the resolved timestamp.
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
