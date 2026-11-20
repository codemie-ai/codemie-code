import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectApplyPatchCalls, isApplyPatchItem, parseApplyPatch } from '../session/codex-apply-patch.js';
import type { CodexRolloutRecord } from '../codex-message-types.js';

const fixtureDir = join(__dirname, 'fixtures');

function load(name: string): CodexRolloutRecord[] {
  return readFileSync(join(fixtureDir, name), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CodexRolloutRecord);
}

const call = (callId: string, input: string, extra: Record<string, unknown> = {}): CodexRolloutRecord => ({
  timestamp: '2026-11-10T10:00:00.000Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input, ...extra },
} as unknown as CodexRolloutRecord);

const end = (callId: string, success: boolean): CodexRolloutRecord => ({
  type: 'event_msg',
  payload: { type: 'patch_apply_end', call_id: callId, success },
} as unknown as CodexRolloutRecord);

const output = (callId: string, output: string): CodexRolloutRecord => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output },
} as unknown as CodexRolloutRecord);

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

describe('parseApplyPatch', () => {
  it('maps Add File to write with its added line count', () => {
    expect(parseApplyPatch(wrap('*** Add File: a.ts\n+one\n+two'))).toEqual([
      { type: 'write', path: 'a.ts', linesAdded: 2, linesRemoved: 0, linesModified: 2 },
    ]);
  });

  it('maps Update File to edit and Delete File to delete', () => {
    const ops = parseApplyPatch(wrap('*** Update File: a.ts\n@@\n-old\n+new\n+more\n*** Delete File: b.ts'));
    expect(ops).toEqual([
      { type: 'edit', path: 'a.ts', linesAdded: 2, linesRemoved: 1, linesModified: 3 },
      { type: 'delete', path: 'b.ts', linesAdded: 0, linesRemoved: 0, linesModified: 0 },
    ]);
  });

  it('reports a move as one edit under the new path', () => {
    const ops = parseApplyPatch(wrap('*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b'));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'edit', path: 'new.ts', linesAdded: 1, linesRemoved: 1 });
  });

  it('handles a multi-file patch', () => {
    const ops = parseApplyPatch(wrap('*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-y\n+z'));
    expect(ops.map((o) => [o.type, o.path])).toEqual([['write', 'a.ts'], ['edit', 'b.ts']]);
  });
});

describe('collectApplyPatchCalls', () => {
  const patch = wrap('*** Add File: a.ts\n+x');

  it('marks a call failed when patch_apply_end says success=false, with no operations', () => {
    const [c] = collectApplyPatchCalls([call('c1', patch), end('c1', false)]);
    expect(c).toMatchObject({ callId: 'c1', ok: false, fileOperations: [] });
  });

  it('marks a call ok when patch_apply_end says success', () => {
    const [c] = collectApplyPatchCalls([call('c1', patch), end('c1', true)]);
    expect(c.ok).toBe(true);
    expect(c.fileOperations[0]).toMatchObject({ type: 'write', path: 'a.ts' });
  });

  it('prefers the apply end event over the tool output', () => {
    const [c] = collectApplyPatchCalls([call('c1', patch), output('c1', JSON.stringify({ metadata: { exit_code: 1 } })), end('c1', true)]);
    expect(c.ok).toBe(true);
  });

  it('treats a non-zero exit code in the output as failure and exit 0 as success', () => {
    const calls = collectApplyPatchCalls([
      call('bad', patch),
      output('bad', JSON.stringify({ output: 'x', metadata: { exit_code: 1 } })),
      call('good', patch),
      output('good', JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } })),
    ]);
    expect(calls.map((c) => [c.callId, c.ok])).toEqual([['bad', false], ['good', true]]);
  });

  it('prefers exit code 0 over failure-looking output text', () => {
    const [c] = collectApplyPatchCalls([
      call('c1', patch),
      output('c1', JSON.stringify({ output: 'Error handling added. Success', metadata: { exit_code: 0 } })),
    ]);
    expect(c.ok).toBe(true);
  });

  it('treats error text in the output as failure', () => {
    const [c] = collectApplyPatchCalls([call('c1', patch), output('c1', 'apply_patch verification failed: no match')]);
    expect(c.ok).toBe(false);
  });

  it('omits a call that only has status completed and no result', () => {
    expect(collectApplyPatchCalls([call('c1', patch, { status: 'completed' })])).toEqual([]);
  });

  it('recognizes a function_call apply_patch with JSON arguments', () => {
    const fc = {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'f1', name: 'apply_patch', arguments: JSON.stringify({ input: patch }) },
    } as unknown as CodexRolloutRecord;
    const [c] = collectApplyPatchCalls([fc, end('f1', true)]);
    expect(c.fileOperations).toHaveLength(1);
    expect(isApplyPatchItem({ type: 'function_call', name: 'apply_patch' })).toBe(true);
    expect(isApplyPatchItem({ type: 'function_call', name: 'exec_command' })).toBe(false);
  });

  it('does not parse or return calls in the skip set', () => {
    const calls = collectApplyPatchCalls([call('c1', patch), end('c1', true), call('c2', patch), end('c2', true)], new Set(['c1']));
    expect(calls.map((c) => c.callId)).toEqual(['c2']);
  });

  it('reads the failure fixture: both failure shapes fail, the pending call is omitted', () => {
    const calls = collectApplyPatchCalls(load('apply-patch-failures.jsonl'));
    expect(calls.map((c) => [c.callId, c.ok])).toEqual([['call_fail_end', false], ['call_fail_exit', false]]);
  });

  it('reads the real rollout fixture: 3 ok calls, updates are edits', () => {
    const calls = collectApplyPatchCalls(load('rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl'));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.ok)).toBe(true);
    expect(calls.flatMap((c) => c.fileOperations).every((o) => o.type === 'edit')).toBe(true);
  });
});
