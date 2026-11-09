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
    // Nested usage.output_tokens_details.thinking_tokens.
    expect(r.thinkingTokens).toBe(28);
    expect(r.cacheReadTokens).toBe(40);
    // Nested cache_creation.* priority over the flat cache_creation_input_tokens aggregate.
    expect(r.cacheCreation5mTokens).toBe(5);
    expect(r.cacheCreation1hTokens).toBe(10);
    // Nested server_tool_use.* fields.
    expect(r.webSearchRequests).toBe(2);
    expect(r.webFetchRequests).toBe(1);
    // stop_reason is a sibling of usage on message, not nested inside usage.
    expect(r.stopReason).toBe('end_turn');
    expect(r.gitBranch).toBe('feature/epmcdme-15301');
    // Normal transcript lines without isApiErrorMessage default to false.
    expect(r.isApiError).toBe(false);
    expect(r.scopeKind).toBe('main');
    expect(r.scopeName).toBe('');
    expect(r.agentId).toBe('');
  });

  it('keeps the line\'s requestedModel and attributionSkill on the record', () => {
    const line = JSON.stringify({
      requestId: 'req_marked',
      requestedModel: 'claude-opus-5-5[1m]',
      attributionSkill: 'probe-skill',
      message: { id: 'msg_marked', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    expect(r.requestedModel).toBe('claude-opus-5-5[1m]');
    expect(r.attributionSkill).toBe('probe-skill');
  });

  it('reads requestedModel and attributionSkill as empty when the line has neither', () => {
    const r = parseUsageLine(lines[3], 'main', '', '', '') as OpenUsageRequest;

    expect(r.requestedModel).toBe('');
    expect(r.attributionSkill).toBe('');
  });

  it('falls back to the flat cache_creation_input_tokens as the 5m tier when the row has no cache_creation split', () => {
    const line = JSON.stringify({
      requestId: 'req_flat_only',
      message: {
        id: 'msg_flat_only',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 120 },
      },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    // Rows from older Claude Code versions/providers carry only the aggregate — it must not be lost.
    expect(r.cacheCreation5mTokens).toBe(120);
    expect(r.cacheCreation1hTokens).toBe(0);
  });

  it('derives the 5m tier as the aggregate minus the nested 1h tier when only 1h is split out', () => {
    const line = JSON.stringify({
      requestId: 'req_1h_only',
      message: {
        id: 'msg_1h_only',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 120,
          cache_creation: { ephemeral_1h_input_tokens: 20 },
        },
      },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    expect(r.cacheCreation5mTokens).toBe(100);
    expect(r.cacheCreation1hTokens).toBe(20);
  });

  it('never reports a negative 5m tier when the nested 1h tier exceeds the aggregate', () => {
    const line = JSON.stringify({
      requestId: 'req_inconsistent',
      message: {
        id: 'msg_inconsistent',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 40 } },
      },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    expect(r.cacheCreation5mTokens).toBe(0);
    expect(r.cacheCreation1hTokens).toBe(40);
  });

  it('keeps the nested split authoritative when it disagrees with the flat aggregate', () => {
    const line = JSON.stringify({
      requestId: 'req_split_wins',
      message: {
        id: 'msg_split_wins',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 10 },
        },
      },
    });

    const r = parseUsageLine(line, 'main', '', '', '') as OpenUsageRequest;

    expect(r.cacheCreation5mTokens).toBe(5);
    expect(r.cacheCreation1hTokens).toBe(10);
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

  it('defaults thinkingTokens to null (not 0) when message.usage carries no output_tokens_details', () => {
    // lines[1]/lines[2] carry no output_tokens_details block at all.
    const req = parseUsageLine(lines[1], 'main', '', '', '');

    expect(req?.thinkingTokens).toBeNull();
  });

  it('reads thinkingTokens from the nested message.usage.output_tokens_details.thinking_tokens field', () => {
    const req = parseUsageLine(lines[3], 'main', '', '', '');

    expect(req?.thinkingTokens).toBe(28);
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
      cacheReadTokens: 3, outputTokens: 4, thinkingTokens: 7, webSearchRequests: 5, webFetchRequests: 6,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: 'main',
    };
    const b: OpenUsageRequest = {
      ...a,
      inputTokens: 1, cacheCreation5mTokens: 9, cacheCreation1hTokens: 1,
      cacheReadTokens: 30, outputTokens: 1, thinkingTokens: 2, webSearchRequests: 0, webFetchRequests: 60,
      timestamp: '',
    };

    const merged = mergeUsageRequest(a, b);

    expect(merged.inputTokens).toBe(10);
    expect(merged.cacheCreation5mTokens).toBe(9);
    expect(merged.cacheCreation1hTokens).toBe(2);
    expect(merged.cacheReadTokens).toBe(30);
    expect(merged.outputTokens).toBe(4);
    expect(merged.thinkingTokens).toBe(7);
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
      cacheReadTokens: 0, outputTokens: 1, thinkingTokens: 0, webSearchRequests: 0, webFetchRequests: 0,
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

  it('treats a null thinkingTokens as "no info" when merging — the other side\'s value wins', () => {
    const a: OpenUsageRequest = {
      requestId: 'r1', messageId: 'm1', model: 'm', modelRaw: 'm-raw', timestamp: 't1',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, thinkingTokens: null, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: '',
    };
    const b: OpenUsageRequest = { ...a, thinkingTokens: 15 };

    expect(mergeUsageRequest(a, b).thinkingTokens).toBe(15);
    expect(mergeUsageRequest(b, a).thinkingTokens).toBe(15);
  });

  it('keeps thinkingTokens null when both records have no thinking-tokens info', () => {
    const a: OpenUsageRequest = {
      requestId: 'r1', messageId: 'm1', model: 'm', modelRaw: 'm-raw', timestamp: 't1',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, thinkingTokens: null, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: '',
    };

    expect(mergeUsageRequest(a, { ...a }).thinkingTokens).toBeNull();
  });

  it('merges agentType like every other non-numeric field: b wins when non-empty, else a', () => {
    const first = parseUsageLine(lines[3], 'agent', '', 'agent-1', 'Explore') as OpenUsageRequest;
    const laterWithoutAgentType = { ...first, agentType: '' };

    expect(mergeUsageRequest(first, laterWithoutAgentType).agentType).toBe('Explore');
    expect(mergeUsageRequest(laterWithoutAgentType, first).agentType).toBe('Explore');
  });

  it('takes scopeKind and scopeName together from one side', () => {
    const base = parseUsageLine(lines[3], 'main', '', '', '') as OpenUsageRequest;
    const skill: OpenUsageRequest = { ...base, scopeKind: 'skill', scopeName: 'probe-skill' };
    const main: OpenUsageRequest = { ...base, scopeKind: 'main', scopeName: '' };
    const noScope = { ...base, scopeKind: '', scopeName: '' } as unknown as OpenUsageRequest;

    const skillThenMain = mergeUsageRequest(skill, main);
    expect([skillThenMain.scopeKind, skillThenMain.scopeName]).toEqual(['main', '']);
    const mainThenSkill = mergeUsageRequest(main, skill);
    expect([mainThenSkill.scopeKind, mainThenSkill.scopeName]).toEqual(['skill', 'probe-skill']);
    const skillThenNone = mergeUsageRequest(skill, noScope);
    expect([skillThenNone.scopeKind, skillThenNone.scopeName]).toEqual(['skill', 'probe-skill']);
  });
});

describe('mergeUsageRequest - requestedModel', () => {
  it('keeps a non-empty requestedModel from either side', () => {
    const first = parseUsageLine(lines[3], 'main', '', '', '') as OpenUsageRequest;
    const marked = { ...first, requestedModel: 'claude-opus-5-5[1m]' };

    expect(mergeUsageRequest(marked, first).requestedModel).toBe('claude-opus-5-5[1m]');
    expect(mergeUsageRequest(first, marked).requestedModel).toBe('claude-opus-5-5[1m]');
  });

  it('reads a stored record that lacks requestedModel as empty', () => {
    const { requestedModel: _dropped, ...stored } = parseUsageLine(lines[3], 'main', '', '', '') as OpenUsageRequest;

    expect(mergeUsageRequest(stored, stored).requestedModel).toBe('');
  });
});

describe('buildUsageRequestEvent', () => {
  it('maps every emitted OpenUsageRequest field to its snake_case event field, with an explicit type, and keeps requestedModel / attributionSkill internal', () => {
    const req: OpenUsageRequest = {
      requestId: 'req-1', messageId: 'msg-1', model: 'resolved-model', modelRaw: 'literal-model', timestamp: '2026-10-01T00:00:00.000Z',
      speed: 'fast', inferenceGeo: 'us', serviceTier: 'priority',
      inputTokens: 10, cacheCreation5mTokens: 1, cacheCreation1hTokens: 2,
      cacheReadTokens: 3, outputTokens: 4, thinkingTokens: 9, webSearchRequests: 5, webFetchRequests: 6,
      scopeKind: 'skill', scopeName: 'brainstorming', agentId: 'agent-7', agentType: 'Explore',
      stopReason: 'end_turn', isApiError: false, gitBranch: 'main',
      requestedModel: 'claude-opus-5-5[1m]', attributionSkill: 'brainstorming',
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
      output_tokens_partial: false,
      thinking_tokens: 9,
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

  it('flags output_tokens_partial when the merged request never received a stop_reason', () => {
    const req: OpenUsageRequest = {
      requestId: 'req-1', messageId: 'msg-1', model: 'm', modelRaw: 'm-raw', timestamp: 't',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 3, thinkingTokens: null, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'agent', scopeName: 'Explore', agentId: 'a1', agentType: 'Explore',
      stopReason: '', isApiError: false, gitBranch: '',
    };

    expect(buildUsageRequestEvent('s', req).output_tokens_partial).toBe(true);
    expect(buildUsageRequestEvent('s', { ...req, stopReason: 'end_turn' }).output_tokens_partial).toBe(false);
  });

  it('does not flag an API-error request without stop_reason as output_tokens_partial', () => {
    const req: OpenUsageRequest = {
      requestId: 'req-1', messageId: 'msg-1', model: 'm', modelRaw: 'm-raw', timestamp: 't',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, thinkingTokens: null, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'agent', scopeName: 'Explore', agentId: 'a1', agentType: 'Explore',
      stopReason: '', isApiError: true, gitBranch: '',
    };

    expect(buildUsageRequestEvent('s', req).output_tokens_partial).toBe(false);
  });

  it('passes a null thinkingTokens through as thinking_tokens: null, so the backend stores it as NULL rather than 0', () => {
    const req: OpenUsageRequest = {
      requestId: 'req-1', messageId: 'msg-1', model: 'm', modelRaw: 'm-raw', timestamp: 't',
      speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
      inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, thinkingTokens: null, webSearchRequests: 0, webFetchRequests: 0,
      scopeKind: 'main', scopeName: '', agentId: '', agentType: '',
      stopReason: '', isApiError: false, gitBranch: '',
    };

    const event = buildUsageRequestEvent('session-123', req);

    expect(event.thinking_tokens).toBeNull();
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

  it('isolates API-error rows from normal rows with the same request id and model', () => {
    const normal = usageRequestKey({ requestId: 'req_1', messageId: 'msg_1', model: 'm' });
    const apiError = usageRequestKey({
      requestId: 'req_1',
      messageId: 'msg_2',
      model: 'm',
      isApiError: true,
    });

    expect(apiError).not.toBe(normal);
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
