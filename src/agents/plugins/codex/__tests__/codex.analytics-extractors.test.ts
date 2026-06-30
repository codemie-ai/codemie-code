import { describe, it, expect } from 'vitest';
import { extractCodexNamedInvocations, skillFromExecArgs } from '../session/codex-named-invocations.js';
import { extractCodexMetrics } from '../session/codex-metrics-extractor.js';
import { extractCodexDispatchEvents } from '../session/codex-dispatch-extractor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixtureDir = join(process.cwd(), 'tests/integration/session/fixtures/codex');

function loadFixture(name: string): unknown[] {
  return readFileSync(join(fixtureDir, name), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('extractCodexNamedInvocations', () => {
  it('detects skill reads from exec_command SKILL.md paths', () => {
    const records = loadFixture('turn-spawn-skill.jsonl');
    const named = extractCodexNamedInvocations(records);
    expect(named.skillInvocations).toEqual({ brainstorming: 1 });
    expect(named.agentInvocations).toEqual({ explorer: 1 });
  });

  it('parses skill name from exec_command JSON args', () => {
    const skill = skillFromExecArgs('{"cmd":"cat /tmp/.codex/plugins/foo/skills/using-superpowers/SKILL.md"}');
    expect(skill).toBe('using-superpowers');
  });
});

describe('extractCodexMetrics', () => {
  it('counts function_call tools and pairs outputs as success', () => {
    const records = loadFixture('turn-spawn-skill.jsonl');
    const metrics = extractCodexMetrics(records as never);
    expect(metrics.tools.exec_command).toBe(1);
    expect(metrics.tools.spawn_agent).toBe(1);
    expect(metrics.toolStatus.exec_command).toEqual({ success: 1, failure: 0 });
    expect(metrics.skillInvocations).toEqual({ brainstorming: 1 });
  });
});

describe('extractCodexDispatchEvents', () => {
  it('pairs spawn_agent with collab_waiting_end for agent duration', () => {
    const records = loadFixture('turn-spawn-skill.jsonl');
    const parsed = { sessionId: 's', agentName: 'codex', metadata: {}, messages: records, metrics: {} } as never;
    const events = extractCodexDispatchEvents(parsed);
    const agent = events.find((e) => e.kind === 'agent');
    expect(agent?.name).toBe('explorer');
    expect(agent?.durationMs).toBeGreaterThan(0);
    expect(agent?._toolUseId).toBeDefined();
    const skill = events.find((e) => e.kind === 'skill' && e.name === 'brainstorming');
    expect(skill).toBeDefined();
    expect(skill?.durationMs).toBeGreaterThan(0);
  });
});
