import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cop-otlp-fixtures-'));
process.env.CODEMIE_HOME = join(root, 'codemie');

import { isCopilotCliHookInput } from '../copilot-cli-otlp.types.js';
import { extractStartCalls, extractEndCall } from '../copilot-cli-otlp.tool-payload.js';
import { buildUsageRows } from '../copilot-cli-otlp.request-usage.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

const dir = join(import.meta.dirname, 'fixtures');
const read = (name: string): string => readFileSync(join(dir, name), 'utf-8');
const hook = (name: string): Record<string, unknown> => JSON.parse(read(name)) as Record<string, unknown>;
const events = (name: string): CopilotEvent[] =>
  read(name).split('\n').filter(Boolean).map((l) => JSON.parse(l) as CopilotEvent);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('fixtures are sanitized', () => {
  for (const name of readdirSync(dir)) {
    it(`${name} has no paths, e-mail addresses or URLs`, () => {
      const text = read(name);
      expect(text).not.toMatch(/[\\/]/);
      expect(text).not.toContain('@');
      expect(text).not.toContain('http');
    });
  }
});

describe('hook payload fixtures', () => {
  it('every hook fixture passes the input guard', () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      expect(isCopilotCliHookInput(hook(name)), name).toBe(true);
    }
  });

  it('the batched preToolUse yields every call, with string args kept as a string', () => {
    const calls = extractStartCalls(hook('pre-tool-use.batched.json') as never);
    expect(calls.map((c) => c.toolUseId)).toEqual(['call_0001', 'call_0002', 'call_0003', 'call_0004']);
    expect(calls[1].toolArgs).toBe('<args>');
  });

  it('single preToolUse and both postToolUse shapes are understood', () => {
    expect(extractStartCalls(hook('pre-tool-use.single.json') as never)).toHaveLength(1);
    expect(extractEndCall(hook('post-tool-use.json') as never).success).toBe(true);
    expect(extractEndCall(hook('post-tool-use.object-args.json') as never).toolArgs).toEqual({ path: '<path>' });
    expect(extractEndCall(hook('post-tool-use-failure.json') as never).success).toBe(false);
  });

  it('the sub-agent agentStop carries an agentId', () => {
    expect(hook('agent-stop.sub-agent.json').agentId).toBe('agent-0001');
    expect(hook('agent-stop.json').agentId).toBeUndefined();
  });
});

describe('transcript fixtures', () => {
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('Tier A: mixed models with a sub-agent record', () => {
    const { rows, partial } = buildUsageRows(SID, events('events.usage-record.jsonl'), 'full');
    expect(partial).toBe(false);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.scope_kind === 'agent')).toHaveLength(1);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['claude-sonnet-4-6', 'gpt-5.3-codex', 'claude-haiku-4-5']));
  });

  it('Tier B: 193 requests, one row each, with the shutdown totals attached once', () => {
    const { rows, partial } = buildUsageRows(SID, events('events.193-requests.jsonl'), 'full');
    expect(partial).toBe(false);
    expect(rows).toHaveLength(193);
    expect(rows.reduce((sum, r) => sum + (r.input_tokens as number), 0)).toBe(200000);
    expect(rows.reduce((sum, r) => sum + (r.cache_read_tokens as number), 0)).toBe(300000);
    expect(rows.reduce((sum, r) => sum + (r.output_tokens as number), 0)).toBe(965);
  });

  it('Tier B: cumulative and reset resumes reconcile', () => {
    const cumulative = buildUsageRows(SID, events('events.resume-cumulative.jsonl'), 'full');
    expect(cumulative.partial).toBe(false);
    expect(cumulative.rows.reduce((sum, r) => sum + (r.input_tokens as number), 0)).toBe(250);

    const reset = buildUsageRows(SID, events('events.resume-reset.jsonl'), 'full');
    expect(reset.partial).toBe(false);
    expect(reset.rows.reduce((sum, r) => sum + (r.input_tokens as number), 0)).toBe(400);
  });
});
