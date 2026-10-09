/**
 * Tests for `agent.usage.request` extraction and merge: `parseUsageLine`,
 * `mergeUsageRequest`, and `buildUsageRequestEvent`.
 *
 * Fixtures: `fixtures/transcript-usage.jsonl` is the proxy shape (no top-level `requestId`,
 * so `requestId === ''` and `messageId` carries `message.id`);
 * `fixtures/transcript-usage-direct.jsonl` is the direct Claude Code shape (top-level
 * `requestId = req_...` plus `message.id = msg_...`, two rows of one response and one row of a
 * second).
 *
 * `fixtures/transcript-usage.jsonl` — one line with no `message.usage`
 * (must parse to `null`), two lines sharing the same `message.id` where the
 * second has a higher `output_tokens` and a non-empty `stop_reason` the first
 * lacks (feeds `mergeUsageRequest`), and one fully-populated "normal" line
 * (round-trips every field, including the `model`/`modelRaw` resolution split).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsageLine, mergeUsageRequest, buildUsageRequestEvent, usageRequestKey } from '../usage-request.js';
import type { OpenUsageRequest } from '../parse-state.js';

let lines: string[];
let directLines: string[];

beforeAll(async () => {
  const raw = await readFile(join(__dirname, 'fixtures', 'transcript-usage.jsonl'), 'utf-8');
  lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const directRaw = await readFile(join(__dirname, 'fixtures', 'transcript-usage-direct.jsonl'), 'utf-8');
  directLines = directRaw.split('\n').filter((l) => l.trim().length > 0);
});

describe('parseUsageLine', () => {
  it('returns null for a line with no message.usage block', () => {
    expect(lines).toHaveLength(4);
    const result = parseUsageLine(lines[0], 'main', '', '', '');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(() => parseUsageLine('not valid json {{{', 'main', '', '', '')).not.toThrow();
    expect(parseUsageLine('not valid json {{{', 'main', '', '', '')).toBeNull();
  });

  it('returns null for a usage-bearing line with neither requestId nor message.id, instead of collapsing it onto a shared ::model key', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-01T00:00:04.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    expect(parseUsageLine(line, 'main', '', '', '')).toBeNull();
  });

  it('extracts every field from a fully-populated line', () => {
    const req = parseUsageLine(lines[3], 'main', '', '', '');

    expect(req).not.toBeNull();
    const r = req as OpenUsageRequest;

    // No top-level requestId in the proxy shape; message.id lands in messageId.
    expect(r.requestId).toBe('');
    expect(r.messageId).toBe('msg_normal_1');
    // modelRaw is the transcript's own literal message.model (unresolved).
    expect(r.modelRaw).toBe('claude-sonnet-4-5-20250929');
    // model is resolved via parseBackendModelName (x-litellm-model-name) first.
    expect(r.model).toBe('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(r.timestamp).toBe('2026-10-01T00:00:03.000Z');
    expect(r.speed).toBe('fast');
    expect(r.inferenceGeo).toBe('us');
    expect(r.serviceTier).toBe('priority');
    expect(r.inputTokens).toBe(300);
    expect(r.outputTokens).toBe(75);
    expect(r.cacheReadTokens).toBe(40);
    // Nested cache_creation.* fields, not the flat cache_creation_input_tokens.
    expect(r.cacheCreation5mTokens).toBe(5);
    expect(r.cacheCreation1hTokens).toBe(10);
    // Nested server_tool_use.* fields.
    expect(r.webSearchRequests).toBe(2);
    expect(r.webFetchRequests).toBe(1);
    // stop_reason is a sibling of usage on message, not nested inside usage.
    expect(r.stopReason).toBe('end_turn');
    expect(r.gitBranch).toBe('feature/epmcdme-15301');
    // No documented source field for isApiError on a real transcript line — defaults false.
    expect(r.isApiError).toBe(false);
    expect(r.scopeKind).toBe('main');
    expect(r.scopeName).toBe('');
    expect(r.agentId).toBe('');
  });

  it('reads the top-level requestId and message.id separately from a direct-session line', () => {
    const r = parseUsageLine(directLines[0], 'main', '', '', '') as OpenUsageRequest;

    expect(r.requestId).toBe('req_011CfrTbrJgSQRWgsdY5FZFc');
    expect(r.messageId).toBe('msg_011CfrTbrWLhWiotBBJC62pV');
  });

  it('keeps a line with a top-level requestId but no message.id', () => {
    const line = JSON.stringify({
      requestId: 'req_only',
      message: { role: 'assistant', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    expect(r.requestId).toBe('req_only');
    expect(r.messageId).toBe('');
  });

  it('passes scopeKind/scopeName/agentId/agentType through verbatim from its own parameters', () => {
    const req = parseUsageLine(lines[3], 'agent', 'reviewer', 'agent-42', 'Explore');

    expect(req?.scopeKind).toBe('agent');
    expect(req?.scopeName).toBe('reviewer');
    expect(req?.agentId).toBe('agent-42');
    expect(req?.agentType).toBe('Explore');
  });

  it('defaults agentType to empty for a main-scoped line', () => {
    const req = parseUsageLine(lines[3], 'main', '', '', '');

    expect(req?.agentType).toBe('');
  });
});

describe('mergeUsageRequest', () => {
  it('keeps the max output_tokens and the non-empty stop_reason across two records for the same message.id', () => {
    const first = parseUsageLine(lines[1], 'main', '', '', '');
    const second = parseUsageLine(lines[2], 'main', '', '', '');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const a = first as OpenUsageRequest;
    const b = second as OpenUsageRequest;

    expect(a.messageId).toBe(b.messageId);
    expect(a.outputTokens).toBe(50);
    expect(a.stopReason).toBe('');
    expect(b.outputTokens).toBe(120);
    expect(b.stopReason).toBe('tool_use');

    const merged = mergeUsageRequest(a, b);

    expect(merged.outputTokens).toBe(Math.max(a.outputTokens, b.outputTokens));
    expect(merged.outputTokens).toBe(120);
    expect(merged.stopReason).toBe('tool_use');
    // Numeric fields take the max even when equal.
    expect(merged.inputTokens).toBe(Math.max(a.inputTokens, b.inputTokens));
    // Merge returns a new object — neither input is mutated.
    expect(a.outputTokens).toBe(50);
    expect(b.outputTokens).toBe(120);
  });

  it('merges the two rows of one direct-session response into one record with both ids', () => {
    const a = parseUsageLine(directLines[0], 'main', '', '', '') as OpenUsageRequest;
    const b = parseUsageLine(directLines[1], 'main', '', '', '') as OpenUsageRequest;

    expect(usageRequestKey(a)).toBe(usageRequestKey(b));
    const merged = mergeUsageRequest(a, b);

    expect(merged.requestId).toBe('req_011CfrTbrJgSQRWgsdY5FZFc');
    expect(merged.messageId).toBe('msg_011CfrTbrWLhWiotBBJC62pV');
    expect(merged.outputTokens).toBe(Math.max(a.outputTokens, b.outputTokens));
  });

  it('keeps messageId when only the earlier record has it', () => {
    const a = parseUsageLine(lines[1], 'main', '', '', '') as OpenUsageRequest;
    const merged = mergeUsageRequest(a, { ...a, messageId: '' });

    expect(merged.messageId).toBe('msg_pair_1');
  });

  it('takes every numeric field as Math.max of the two inputs', () => {
    const a: OpenUsageRequest = {
      requestId: 'r1', messageId: 'm1', model: 'm', modelRaw: 'm-raw', timestamp: 't1',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 10, cacheCreation5mTokens: 1, cacheCreation1hTokens: 2,
      cacheReadTokens: 3, outputTokens: 4, webSearchRequests: 5, webFetchRequests: 6,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: 'main',
    };
    const b: OpenUsageRequest = {
      ...a,
      inputTokens: 1, cacheCreation5mTokens: 9, cacheCreation1hTokens: 1,
      cacheReadTokens: 30, outputTokens: 1, webSearchRequests: 0, webFetchRequests: 60,
      timestamp: '',
    };

    const merged = mergeUsageRequest(a, b);

    expect(merged.inputTokens).toBe(10);
    expect(merged.cacheCreation5mTokens).toBe(9);
    expect(merged.cacheCreation1hTokens).toBe(2);
    expect(merged.cacheReadTokens).toBe(30);
    expect(merged.outputTokens).toBe(4);
    expect(merged.webSearchRequests).toBe(5);
    expect(merged.webFetchRequests).toBe(60);
    // Non-numeric fields: b's value wins when non-empty, else a's.
    expect(merged.timestamp).toBe('t1');
  });

  it('does not mutate either input and returns a new object', () => {
    const a: OpenUsageRequest = {
      requestId: 'r1', messageId: 'm1', model: 'm', modelRaw: 'm-raw', timestamp: 't1',
      speed: '', inferenceGeo: '', serviceTier: '',
      inputTokens: 1, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 1, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: '',
    };
    const b: OpenUsageRequest = { ...a, outputTokens: 2, stopReason: 'end_turn', isApiError: true };
    const aCopy = { ...a };
    const bCopy = { ...b };

    const merged = mergeUsageRequest(a, b);

    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
    expect(merged).not.toBe(a);
    expect(merged).not.toBe(b);
    // isApiError: once true, stays true across merges.
    expect(merged.isApiError).toBe(true);
  });

  it('merges agentType like every other non-numeric field: b wins when non-empty, else a', () => {
    const first = parseUsageLine(lines[3], 'agent', '', 'agent-1', 'Explore') as OpenUsageRequest;
    const laterWithoutAgentType = { ...first, agentType: '' };

    expect(mergeUsageRequest(first, laterWithoutAgentType).agentType).toBe('Explore');
    expect(mergeUsageRequest(laterWithoutAgentType, first).agentType).toBe('Explore');
  });
});

describe('buildUsageRequestEvent', () => {
  it('maps every OpenUsageRequest field to its snake_case event field, with an explicit type', () => {
    const req: OpenUsageRequest = {
      requestId: 'req-1', messageId: 'msg-1', model: 'resolved-model', modelRaw: 'literal-model', timestamp: '2026-10-01T00:00:00.000Z',
      speed: 'fast', inferenceGeo: 'us', serviceTier: 'priority',
      inputTokens: 10, cacheCreation5mTokens: 1, cacheCreation1hTokens: 2,
      cacheReadTokens: 3, outputTokens: 4, webSearchRequests: 5, webFetchRequests: 6,
      scopeKind: 'skill', scopeName: 'brainstorming', agentId: 'agent-7', agentType: 'Explore',
      stopReason: 'end_turn', isApiError: false, gitBranch: 'main',
    };

    const event = buildUsageRequestEvent('session-123', req);

    expect(event).toEqual({
      type: 'agent.usage.request',
      session_id: 'session-123',
      request_id: 'req-1',
      message_id: 'msg-1',
      model_raw: 'literal-model',
      model: 'resolved-model',
      speed: 'fast',
      inference_geo: 'us',
      service_tier: 'priority',
      input_tokens: 10,
      cache_creation_5m_tokens: 1,
      cache_creation_1h_tokens: 2,
      cache_read_tokens: 3,
      output_tokens: 4,
      web_search_requests: 5,
      web_fetch_requests: 6,
      scope_kind: 'skill',
      scope_name: 'brainstorming',
      agent_id: 'agent-7',
      agent_type: 'Explore',
      stop_reason: 'end_turn',
      is_api_error: false,
      git_branch: 'main',
      timestamp: '2026-10-01T00:00:00.000Z',
    });
    // No event_id/schema_version here — those are stamped later, daemon-side.
    expect(event).not.toHaveProperty('event_id');
    expect(event).not.toHaveProperty('schema_version');
  });
});

describe('usageRequestKey', () => {
  it('prefers requestId over messageId', () => {
    expect(usageRequestKey({ requestId: 'req_1', messageId: 'msg_1', model: 'm' })).toBe('req_1::m');
  });

  it('falls back to messageId when requestId is empty', () => {
    expect(usageRequestKey({ requestId: '', messageId: 'msg_1', model: 'm' })).toBe('msg_1::m');
  });

  it('gives different keys to the same messageId under different models', () => {
    const a = usageRequestKey({ requestId: '', messageId: 'msg_1', model: 'm1' });
    const b = usageRequestKey({ requestId: '', messageId: 'msg_1', model: 'm2' });

    expect(a).not.toBe(b);
  });
});

describe('buildUsageRequestEvent - direct session', () => {
  it('emits the API request id as request_id and message.id as message_id', () => {
    const req = parseUsageLine(directLines[2], 'main', '', '', '') as OpenUsageRequest;

    const event = buildUsageRequestEvent('session-direct', req);

    expect(event.request_id).toBe('req_011CfrTdvHcHvpWuQRM5zwz8');
    expect(event.message_id).toBe('msg_011CfrTdvaxJgBE1TDcwFnce');
  });
});
