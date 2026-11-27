// @case codex_apply_patch_synced_records_TC_001
// Codex edits files through apply_patch, a custom_tool_call in the rollout. The per-call
// records the CLI syncs to the platform must count it as a tool and carry its file operations.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/greeting.ts',
  '+export const greeting = "hello";',
  '+export const target = "world";',
  '*** Update File: src/index.ts',
  '@@',
  '-import { old } from "./old.js";',
  '+import { greeting } from "./greeting.js";',
  '*** End Patch',
].join('\n');

interface SyncedRecord {
  recordId: string;
  tools?: Record<string, number>;
  fileOperations?: unknown[];
}

/** A Codex rollout: one turn with a regular tool call and one apply_patch call with its result. */
function rolloutRecords(): unknown[] {
  return [
    { timestamp: '2026-11-10T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-11-10T10:00:01.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_exec', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
    { timestamp: '2026-11-10T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_exec', output: 'src' } },
    { timestamp: '2026-11-10T10:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_patch', name: 'apply_patch', input: PATCH } },
    {
      timestamp: '2026-11-10T10:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call_patch',
        success: true,
        stdout: 'Success. Updated the following files:\nA src/greeting.ts\nM src/index.ts\n',
        stderr: '',
        changes: {
          'src/greeting.ts': { type: 'add', content: 'export const greeting = "hello";\nexport const target = "world";\n' },
          'src/index.ts': { type: 'update', unified_diff: '@@\n-import { old } from "./old.js";\n+import { greeting } from "./greeting.js";\n' },
        },
      },
    },
    { timestamp: '2026-11-10T10:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_patch', output: '{"output":"Success.","metadata":{"exit_code":0,"duration_seconds":0.0}}' } },
    { timestamp: '2026-11-10T10:00:30.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' } },
  ];
}

describe('Codex synced per-call metrics — apply_patch edits', () => {
  const sessionId = `codemie-session-${Math.random().toString(36).slice(2, 10)}`;
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'codex-apply-patch-sync-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    writeFileSync(join(tempHome, 'sessions', `${sessionId}.json`), JSON.stringify({ sessionId, startTime: 0 }));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  it('synced records count apply_patch with one file operation per touched file', async () => {
    const { CodexMetricsProcessor } = await import('../session/processors/codex.metrics-processor.js');
    const session = {
      sessionId,
      agentName: 'Codex CLI',
      metadata: {
        codexSessionId: '019e0e09-0000-7000-8000-000000000001',
        projectPath: join(tempHome, 'work'),
        createdAt: '2026-11-10T10:00:00.000Z',
        branch: 'feat/example',
        model: 'gpt-5.4',
      },
      messages: rolloutRecords(),
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] },
    } as unknown as import('../../../core/session/BaseSessionAdapter.js').ParsedSession;

    const result = await new CodexMetricsProcessor().process(session, {} as never);

    const metricsPath = join(tempHome, 'sessions', `${sessionId}_metrics.jsonl`);
    const records = existsSync(metricsPath)
      ? readFileSync(metricsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as SyncedRecord)
      : [];
    // The rollout was parsed and produced synced metric records (the regular tool call is there)
    expect({ success: result.success, execRecorded: records.some((r) => r.tools?.exec_command === 1) }).toEqual({ success: true, execRecorded: true }); // repro:precondition

    const patchRecord = records.find((r) => r.tools?.apply_patch === 1);
    expect({ tools: patchRecord?.tools, fileOperations: patchRecord?.fileOperations }).toMatchObject({ tools: { apply_patch: 1 }, fileOperations: [{ type: 'write', path: 'src/greeting.ts', linesAdded: 2, linesRemoved: 0 }, { type: 'edit', path: 'src/index.ts', linesAdded: 1, linesRemoved: 1 }] }); // repro:symptom
  });
});
