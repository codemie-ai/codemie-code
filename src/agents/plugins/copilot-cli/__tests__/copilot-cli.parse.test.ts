/**
 * Copilot CLI transcript parsing unit tests.
 *
 * parseSessionFile turns events.jsonl into the unified ParsedSession: raw per-model usage
 * buckets in `messages` (readCopilotCli owns the conversion), plus the metrics that
 * populate the report's activity, tools and code-churn views.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';
import type { CopilotUsageMessage } from '../copilot-cli.usage.js';

let dir: string;
let file: string;

const LINES: unknown[] = [
  {
    type: 'session.start',
    timestamp: '2026-06-16T06:21:01.983Z',
    data: {
      sessionId: 'sess-1',
      copilotVersion: '1.0.48',
      startTime: '2026-06-16T06:21:01.967Z',
      context: {
        cwd: '/repo/app',
        gitRoot: '/repo/app',
        branch: 'main',
        repository: 'org/app',
        hostType: 'github',
      },
    },
  },
  { type: 'user.message', timestamp: '2026-06-16T06:21:02Z', data: { text: 'hello there' } },
  { type: 'skill.invoked', timestamp: '2026-06-16T06:21:03Z', data: { skill: 'superpowers:brainstorming' } },
  { type: 'assistant.message', timestamp: '2026-06-16T06:21:04Z', data: { model: 'gpt-5.4', outputTokens: 296 } },
  {
    type: 'tool.execution_complete',
    timestamp: '2026-06-16T06:21:05Z',
    data: { name: 'view', status: 'success', arguments: { path: '/repo/app/a.ts' } },
  },
  {
    type: 'tool.execution_complete',
    timestamp: '2026-06-16T06:21:06Z',
    data: { name: 'view', status: 'success', arguments: { path: '/repo/app/b.ts' } },
  },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:07Z', data: { name: 'bash', status: 'error' } },
  {
    type: 'session.shutdown',
    timestamp: '2026-06-16T06:21:08Z',
    data: {
      shutdownType: 'routine',
      totalPremiumRequests: 3,
      codeChanges: { linesAdded: 12, linesRemoved: 4, filesModified: ['/repo/app/a.ts'] },
      modelMetrics: {
        'gpt-5.4': {
          requests: { count: 22 },
          usage: {
            inputTokens: 1431122,
            outputTokens: 10684,
            cacheReadTokens: 1235968,
            cacheWriteTokens: 0,
            reasoningTokens: 4422,
          },
        },
      },
    },
  },
];

function newAdapter(): CopilotCliSessionAdapter {
  return new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-parse-'));
  file = join(dir, 'events.jsonl');
  writeFileSync(file, LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CopilotCliSessionAdapter.parseSessionFile', () => {
  it('maps session.start into metadata', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');

    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.agentName).toBe('GitHub Copilot CLI');
    expect(parsed.agentVersion).toBe('1.0.48');
    expect(parsed.metadata.projectPath).toBe('/repo/app');
    expect(parsed.metadata.branch).toBe('main');
    expect(parsed.metadata.gitBranch).toBe('main');
    expect(parsed.metadata.repository).toBe('org/app');
    expect(parsed.metadata.createdAt).toBe('2026-06-16T06:21:01.967Z');
  });

  it('emits raw per-model usage buckets as messages', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const messages = parsed.messages as CopilotUsageMessage[];

    expect(messages).toHaveLength(1);
    expect(messages[0].model).toBe('gpt-5.4');
    // RAW — cache-inclusive. readCopilotCli performs the decomposition.
    expect(messages[0].usage.inputTokens).toBe(1431122);
    expect(messages[0].requests).toBe(22);
  });

  it('extracts tool counts and success/failure status', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');

    expect(parsed.metrics!.tools).toEqual({ view: 2, bash: 1 });
    expect(parsed.metrics!.toolStatus!.view).toEqual({ success: 2, failure: 0 });
    expect(parsed.metrics!.toolStatus!.bash).toEqual({ success: 0, failure: 1 });
  });

  it('extracts skill invocations so the Source column can classify the session', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    expect(parsed.metrics!.skillInvocations).toEqual({ 'superpowers:brainstorming': 1 });
  });

  it('captures user prompts', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    expect(parsed.metrics!.userPrompts).toEqual([{ count: 1, text: 'hello there' }]);
  });

  it('records code changes from session.shutdown', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const ops = parsed.metrics!.fileOperations!;

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ path: '/repo/app/a.ts', linesAdded: 12, linesRemoved: 4 });
  });

  it('exposes premium requests and non-partial usage state', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');

    expect(parsed.usageMeta!.premiumRequests).toBe(3);
    expect(parsed.usageMeta!.usagePartial).toBe(false);
    expect(parsed.usageMeta!.usageUnavailableReason).toBeUndefined();
  });

  it('marks a shutdown-less session partial and keeps per-turn output', async () => {
    const noShutdown = join(dir, 'no-shutdown.jsonl');
    writeFileSync(noShutdown, LINES.slice(0, -1).map((l) => JSON.stringify(l)).join('\n') + '\n');

    const parsed = await newAdapter().parseSessionFile(noShutdown, 'sess-2');
    const messages = parsed.messages as CopilotUsageMessage[];

    expect(parsed.usageMeta!.usagePartial).toBe(true);
    expect(messages[0].usage.outputTokens).toBe(296);
    expect(parsed.metrics!.fileOperations).toEqual([]);
  });

  it('reports a reason when the transcript carries no usage at all', async () => {
    const noUsage = join(dir, 'no-usage.jsonl');
    writeFileSync(noUsage, JSON.stringify(LINES[0]) + '\n');

    const parsed = await newAdapter().parseSessionFile(noUsage, 'sess-3');

    expect(parsed.messages).toEqual([]);
    expect(parsed.usageMeta!.usageUnavailableReason).toBeTruthy();
  });

  it('degrades gracefully on a malformed transcript', async () => {
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json\n{"type":"session.start"\n');

    const parsed = await newAdapter().parseSessionFile(bad, 'sess-bad');

    expect(parsed.sessionId).toBe('sess-bad');
    expect(parsed.messages).toEqual([]);
    expect(parsed.metrics!.tools).toEqual({});
  });

  it('degrades gracefully on a missing transcript', async () => {
    const parsed = await newAdapter().parseSessionFile(join(dir, 'nope.jsonl'), 'sess-missing');
    expect(parsed.messages).toEqual([]);
  });
});

describe('CopilotCliSessionAdapter.processSession', () => {
  it('runs registered processors and aggregates their results', async () => {
    const adapter = newAdapter();
    const result = await adapter.processSession(file, 'sess-1', {} as never);

    expect(result.success).toBe(true);
    expect(result.failedProcessors).toEqual([]);
    expect(Object.keys(result.processors).length).toBeGreaterThan(0);
  });
});
