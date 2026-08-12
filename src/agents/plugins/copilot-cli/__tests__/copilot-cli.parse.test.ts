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
  // Real shape: the tool NAME and arguments appear only on tool.execution_start;
  // tool.execution_complete carries just toolCallId plus a boolean `success`.
  {
    type: 'tool.execution_start',
    timestamp: '2026-06-16T06:21:05Z',
    data: { toolCallId: 'c1', toolName: 'view', arguments: { path: '/repo/app/a.ts' } },
  },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:05Z', data: { toolCallId: 'c1', success: true } },
  {
    type: 'tool.execution_start',
    timestamp: '2026-06-16T06:21:06Z',
    data: { toolCallId: 'c2', toolName: 'view', arguments: { path: '/repo/app/b.ts' } },
  },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:06Z', data: { toolCallId: 'c2', success: true } },
  {
    type: 'tool.execution_start',
    timestamp: '2026-06-16T06:21:07Z',
    data: { toolCallId: 'c3', toolName: 'bash', arguments: {} },
  },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:07Z', data: { toolCallId: 'c3', success: false } },
  {
    type: 'tool.execution_start',
    timestamp: '2026-06-16T06:21:07.5Z',
    data: { toolCallId: 'c4', toolName: 'edit', arguments: { path: '/repo/app/a.ts', old_str: 'a', new_str: 'b' } },
  },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:07.6Z', data: { toolCallId: 'c4', success: true } },
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

  it('emits raw per-model usage buckets among the messages', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const usageRows = (parsed.messages as CopilotUsageMessage[]).filter((m) => m.usage);

    expect(usageRows).toHaveLength(1);
    expect(usageRows[0].model).toBe('gpt-5.4');
    // RAW — cache-inclusive. readCopilotCli performs the decomposition.
    expect(usageRows[0].usage.inputTokens).toBe(1431122);
    expect(usageRows[0].requests).toBe(22);
  });

  it('emits Claude-shaped per-turn records so native synthesis derives turns and models', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const turns = (parsed.messages as Array<{ type?: string; message?: { model?: string }; cwd?: string }>).filter(
      (m) => m.type === 'assistant'
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].message!.model).toBe('gpt-5.4');
    expect(turns[0].cwd).toBe('/repo/app');
  });

  it('pairs tool.execution_start with _complete by toolCallId for names and outcomes', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');

    expect(parsed.metrics!.tools).toEqual({ view: 2, bash: 1, edit: 1 });
    expect(parsed.metrics!.toolStatus!.view).toEqual({ success: 2, failure: 0 });
    expect(parsed.metrics!.toolStatus!.bash).toEqual({ success: 0, failure: 1 });
  });

  it('does not record a file operation for a FAILED write', async () => {
    const f = join(dir, 'failed-write.jsonl');
    writeFileSync(
      f,
      [
        { type: 'tool.execution_start', data: { toolCallId: 'ok', toolName: 'create', arguments: { path: '/written.ts' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'ok', success: true } },
        { type: 'tool.execution_start', data: { toolCallId: 'bad', toolName: 'edit', arguments: { path: '/never-written.ts' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'bad', success: false } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );

    const parsed = await newAdapter().parseSessionFile(f, 'sess-failed');
    const paths = parsed.metrics!.fileOperations!.map((o) => o.path);

    expect(paths).toEqual(['/written.ts']);
    // The failed call still counts as a tool invocation, just not as a file change.
    expect(parsed.metrics!.toolStatus!.edit).toEqual({ success: 0, failure: 1 });
  });

  it('ignores an orphaned completion with no matching start', async () => {
    const orphan = join(dir, 'orphan.jsonl');
    writeFileSync(
      orphan,
      JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'gone', success: true } }) + '\n'
    );

    const parsed = await newAdapter().parseSessionFile(orphan, 'sess-orphan');
    expect(parsed.metrics!.tools).toEqual({});
  });

  it('records file writes from tool arguments but not reads', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const paths = parsed.metrics!.fileOperations!.map((o) => `${o.type}:${o.path}`);

    expect(paths).toContain('edit:/repo/app/a.ts');
    // `view` carries a path too, but it is a read and must not count as a change.
    expect(paths.some((p) => p.startsWith('view:'))).toBe(false);
  });

  it('extracts skill invocations so the Source column can classify the session', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    expect(parsed.metrics!.skillInvocations).toEqual({ 'superpowers:brainstorming': 1 });
  });

  it('captures user prompts', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    expect(parsed.metrics!.userPrompts).toEqual([{ count: 1, text: 'hello there' }]);
  });

  it('reads the real content-based Copilot transcript fields', async () => {
    const contentFile = join(dir, 'content-shaped.jsonl');
    writeFileSync(
      contentFile,
      [
        {
          type: 'session.start',
          timestamp: '2026-08-11T11:29:15.489Z',
          data: {
            sessionId: 'cp-content',
            copilotVersion: '1.0.79',
            startTime: '2026-08-11T11:29:15.437Z',
            context: {
              cwd: '/repo/app',
              gitRoot: '/repo/app',
              branch: 'main',
              repository: 'org/app',
            },
          },
        },
        {
          type: 'user.message',
          timestamp: '2026-08-11T11:29:21.539Z',
          data: { content: 'Hi from content' },
        },
        {
          type: 'assistant.message',
          timestamp: '2026-08-11T11:29:25.092Z',
          data: {
            model: 'gpt-5.5-2026-04-24',
            content: 'Hello from content',
            outputTokens: 11,
            toolRequests: [{ toolCallId: 'tool-1', name: 'view', arguments: { path: '/repo/app/a.ts' } }],
          },
        },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    );

    const parsed = await newAdapter().parseSessionFile(contentFile, 'cp-content');
    const turnRecords = parsed.messages as Array<{
      type?: string;
      message?: { role?: string; content?: string; model?: string };
    }>;

    expect(parsed.metrics!.userPrompts).toEqual([{ count: 1, text: 'Hi from content' }]);
    expect(turnRecords.find((m) => m.type === 'user')?.message?.content).toBe('Hi from content');
    expect(turnRecords.find((m) => m.type === 'assistant')?.message).toMatchObject({
      role: 'assistant',
      model: 'gpt-5.5-2026-04-24',
      content: 'Hello from content',
      toolRequests: [{ toolCallId: 'tool-1', name: 'view', arguments: { path: '/repo/app/a.ts' } }],
    });
  });

  it('merges session.shutdown line totals into the per-file operations without duplicating', async () => {
    const parsed = await newAdapter().parseSessionFile(file, 'sess-1');
    const ops = parsed.metrics!.fileOperations!;

    // /repo/app/a.ts appears in BOTH the edit tool call and shutdown.filesModified;
    // it must be recorded once, not twice.
    expect(ops.filter((o) => o.path === '/repo/app/a.ts')).toHaveLength(1);
    expect(ops[0]).toMatchObject({ path: '/repo/app/a.ts', linesAdded: 12, linesRemoved: 4 });
  });

  it('attributes line totals to a file shutdown actually lists as modified', async () => {
    // Tools touched /read-only.ts first, but shutdown says only /changed.ts was modified.
    // Putting the churn on the first entry would credit lines to a file that never changed.
    const f = join(dir, 'attribution.jsonl');
    writeFileSync(
      f,
      [
        { type: 'tool.execution_start', data: { toolCallId: 'x', toolName: 'edit', arguments: { path: '/read-only.ts' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'x', success: true } },
        {
          type: 'session.shutdown',
          data: { codeChanges: { linesAdded: 30, linesRemoved: 2, filesModified: ['/changed.ts'] } },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );

    const parsed = await newAdapter().parseSessionFile(f, 'sess-attr');
    const ops = parsed.metrics!.fileOperations!;
    const changed = ops.find((o) => o.path === '/changed.ts')!;
    const readOnly = ops.find((o) => o.path === '/read-only.ts')!;

    expect(changed.linesAdded).toBe(30);
    expect(changed.linesRemoved).toBe(2);
    expect(readOnly.linesAdded ?? 0).toBe(0);
  });

  it('adds files that only session.shutdown knows about', async () => {
    const extra = join(dir, 'extra.jsonl');
    writeFileSync(
      extra,
      JSON.stringify({
        type: 'session.shutdown',
        data: { codeChanges: { linesAdded: 5, linesRemoved: 1, filesModified: ['/only/in/shutdown.ts'] } },
      }) + '\n'
    );

    const parsed = await newAdapter().parseSessionFile(extra, 'sess-extra');
    const ops = parsed.metrics!.fileOperations!;

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ path: '/only/in/shutdown.ts', linesAdded: 5, linesRemoved: 1 });
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
    const usageRows = (parsed.messages as CopilotUsageMessage[]).filter((m) => m.usage);

    expect(parsed.usageMeta!.usagePartial).toBe(true);
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0].usage.outputTokens).toBe(296);
    // Without shutdown there are no line totals, but the edit tool call is still recorded.
    expect(parsed.metrics!.fileOperations).toEqual([{ type: 'edit', path: '/repo/app/a.ts' }]);
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

/**
 * Only the newest Copilot CLI builds put `model` on each `assistant.message`. Older ones
 * (1.0.17 and every 0.0.x) omit it, so the model must be recovered from the other events
 * that do carry it — otherwise the report shows "unknown model" for most sessions.
 */
describe('CopilotCliSessionAdapter — model attribution fallbacks', () => {
  function write(name: string, lines: unknown[]): string {
    const p = join(dir, name);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
  }

  function modelsOf(parsed: Awaited<ReturnType<CopilotCliSessionAdapter['parseSessionFile']>>): string[] {
    return (parsed.messages as Array<{ type?: string; message?: { model?: string } }>)
      .filter((m) => m.type === 'assistant')
      .map((m) => m.message?.model)
      .filter((m): m is string => !!m);
  }

  it('prefers the per-turn model when present', async () => {
    const f = write('per-turn.jsonl', [
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { model: 'claude-sonnet-4.6', outputTokens: 5 } },
    ]);
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual(['claude-sonnet-4.6']);
  });

  it('falls back to the model in effect from session.model_change', async () => {
    const f = write('model-change.jsonl', [
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { outputTokens: 5 } },
      { type: 'assistant.message', data: { outputTokens: 7 } },
    ]);
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual(['gpt-5.2', 'gpt-5.2']);
  });

  it('tracks a mid-session model switch chronologically', async () => {
    const f = write('switch.jsonl', [
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { outputTokens: 1 } },
      { type: 'session.model_change', data: { previousModel: 'gpt-5.2', newModel: 'claude-sonnet-4.6' } },
      { type: 'assistant.message', data: { outputTokens: 1 } },
    ]);
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual(['gpt-5.2', 'claude-sonnet-4.6']);
  });

  it('backfills from shutdown modelMetrics when the session used exactly one model', async () => {
    const f = write('single-model.jsonl', [
      { type: 'assistant.message', data: { outputTokens: 5 } },
      { type: 'assistant.message', data: { outputTokens: 9 } },
      {
        type: 'session.shutdown',
        data: { modelMetrics: { 'gpt-5.2': { requests: { count: 2 }, usage: { inputTokens: 10, outputTokens: 14 } } } },
      },
    ]);
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual(['gpt-5.2', 'gpt-5.2']);
  });

  it('does NOT guess when the session used several models and turns are unlabelled', async () => {
    const f = write('ambiguous.jsonl', [
      { type: 'assistant.message', data: { outputTokens: 5 } },
      {
        type: 'session.shutdown',
        data: {
          modelMetrics: {
            'gpt-5.2': { usage: { outputTokens: 3 } },
            'claude-sonnet-4.5': { usage: { outputTokens: 2 } },
          },
        },
      },
    ]);
    // Attributing an unlabelled turn to one of two models would be a fabrication.
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual([]);
  });

  it('leaves the model unknown when no source carries it', async () => {
    const f = write('none.jsonl', [{ type: 'assistant.message', data: { outputTokens: 5 } }]);
    expect(modelsOf(await newAdapter().parseSessionFile(f, 's'))).toEqual([]);
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
