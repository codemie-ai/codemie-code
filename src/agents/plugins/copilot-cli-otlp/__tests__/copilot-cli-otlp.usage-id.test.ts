import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cop-otlp-usage-id-'));
process.env.CODEMIE_HOME = join(root, 'codemie');

import { buildUsageRows } from '../copilot-cli-otlp.request-usage.js';
import { buildDeferredUsageEvents } from '../copilot-cli-otlp.usage.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

afterAll(() => rmSync(root, { recursive: true, force: true }));

const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const events = readFileSync(join(import.meta.dirname, 'fixtures', 'events.usage-record-usage-id.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as CopilotEvent);
const view = (rows: Record<string, unknown>[]) =>
  rows.map((r) => [r.request_id, r.scope_kind, r.agent_id ?? null, r.input_tokens, r.cache_creation_5m_tokens, r.cache_read_tokens, r.output_tokens, r.thinking_tokens]);

// Copilot >= 1.0.115: no `usage.apiCallId`; the request id is `usage.accounting.usageId`.
const expected = [
  ['u1', 'main', null, 3, 14822, 0, 92, 71],
  ['u2', 'agent', 'agent-a', 3, 12754, 0, 19, 0],
  ['u3', 'agent', 'agent-b', 3, 108, 12754, 139, 0],
  ['u4', 'agent', 'agent-a', 3, 184, 12862, 90, 48],
  ['u5', 'main', null, 3, 496, 15003, 57, 34],
];

describe('session.usage_record keyed by accounting.usageId', () => {
  it('one Tier A row per record, exact tokens, sub-agent ids only on agent scope, no message-row duplicates', () => {
    const { rows, partial } = buildUsageRows(SID, events, 'full');
    expect(partial).toBe(false);
    expect(view(rows)).toEqual(expected);
  });

  it('incremental slices and the deferred pass agree and never repeat a request or event id', () => {
    const cut = events.findIndex((e) => e.id === 'a3');
    const first = buildUsageRows(SID, events.slice(0, cut), 'incremental');
    const second = buildUsageRows(SID, events.slice(cut), 'incremental', {
      priorSawUsageRecords: first.sawUsageRecords, pendingMessages: first.pendingMessages, initialModel: first.lastModel,
    });
    const deferred = buildDeferredUsageEvents({ session_id: SID }, events).filter((e) => e.type === 'agent.usage.request');
    const incremental = [...first.rows, ...second.rows];
    expect(view(incremental)).toEqual(expected);
    expect(view(deferred)).toEqual(expected);
    expect(incremental.map((r) => r.event_id)).toEqual(deferred.map((r) => r.event_id));
    expect(new Set(incremental.map((r) => r.event_id)).size).toBe(expected.length);
  });
});
