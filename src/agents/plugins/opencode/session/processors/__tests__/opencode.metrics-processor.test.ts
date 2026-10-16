/**
 * Tests for the OpenCode metrics processor.
 *
 * Focused on the extraction rules that were previously broken or absent:
 * diff-derived line counts, per-file apply_patch operation kinds (the only
 * route to files_deleted), turn-level errors, and the bare model id.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { OpenCodeMetricsProcessor, countDiffLines } from '../opencode.metrics-processor.js';
import { getSessionMetricsPath } from '../../../../../core/session/session-config.js';
import type { ParsedSession } from '../../../../../core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../../../core/session/BaseProcessor.js';
import type { MetricDelta } from '../../../../../core/metrics/types.js';

const OC_SESSION_ID = 'ses_test';

let sessionId: string;

const context: ProcessingContext = {
  apiBaseUrl: 'http://localhost',
  cookies: '',
  clientType: 'codemie-opencode',
  version: '1.0.0',
  dryRun: true,
  gitBranch: 'main',
  agentSessionId: OC_SESSION_ID,
};

/** Build a ParsedSession in the SQLite shape (parts pre-loaded via partsMap). */
function buildSession(
  messages: Array<Record<string, unknown>>,
  partsMap: Record<string, Array<Record<string, unknown>>>
): ParsedSession {
  return {
    sessionId,
    agentName: 'OpenCode CLI',
    messages: messages as never,
    metadata: {
      storagePath: '/nonexistent/storage',
      openCodeSessionId: OC_SESSION_ID,
      projectPath: '/repo',
      partsMap,
      storageType: 'sqlite',
    },
  } as unknown as ParsedSession;
}

function toolPart(
  id: string,
  tool: string,
  state: Record<string, unknown>
): Record<string, unknown> {
  return { id, messageID: 'msg-a', sessionID: OC_SESSION_ID, type: 'tool', callID: `call-${id}`, tool, state };
}

const assistantMessage = {
  id: 'msg-a',
  sessionID: OC_SESSION_ID,
  role: 'assistant',
  time: { created: 1_700_000_000_000 },
  providerID: 'codemie-proxy',
  modelID: 'kimi-k2.7-code',
};

async function run(session: ParsedSession): Promise<MetricDelta[]> {
  const result = await new OpenCodeMetricsProcessor().process(session, context);
  expect(result.success).toBe(true);

  const path = getSessionMetricsPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as MetricDelta);
}

/** Flatten every file operation across deltas. */
function fileOps(deltas: MetricDelta[]): NonNullable<MetricDelta['fileOperations']> {
  return deltas.flatMap(d => d.fileOperations ?? []);
}

beforeEach(() => {
  sessionId = `test-oc-metrics-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  rmSync(getSessionMetricsPath(sessionId), { force: true });
});

describe('countDiffLines', () => {
  it('counts added and removed content lines', () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,5 @@',
      ' unchanged',
      '+added one',
      '+added two',
      '-removed one',
    ].join('\n');

    // The ---/+++ header pair and @@ hunk markers are not content.
    expect(countDiffLines(patch)).toEqual({ linesAdded: 2, linesRemoved: 1 });
  });

  it('returns zeros for absent or non-string patches', () => {
    expect(countDiffLines(undefined)).toEqual({ linesAdded: 0, linesRemoved: 0 });
    expect(countDiffLines('')).toEqual({ linesAdded: 0, linesRemoved: 0 });
    expect(countDiffLines({ not: 'a patch' })).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
});

describe('OpenCodeMetricsProcessor', () => {
  it('counts every line of a write as an addition', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'write', {
        status: 'completed',
        input: { filePath: 'src/new.ts', content: 'a\nb\nc' },
      })],
    }));

    const ops = fileOps(deltas);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'write', path: 'src/new.ts', linesAdded: 3 });
  });

  it('derives edit line counts from the filediff patch', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'edit', {
        status: 'completed',
        input: { filePath: 'src/a.ts' },
        metadata: {
          filediff: { file: 'src/a.ts', patch: '@@ -1 +1,3 @@\n+one\n+two\n+three\n-old' },
        },
      })],
    }));

    // The retained v1 filediff path has no numeric additions/deletions.
    expect(fileOps(deltas)[0]).toMatchObject({ type: 'edit', linesAdded: 3, linesRemoved: 1 });
  });

  it('maps apply_patch per-file kinds onto create/modify/delete', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'apply_patch', {
        status: 'completed',
        input: {},
        metadata: {
          files: [
            { filePath: 'src/added.ts', type: 'add', patch: '@@\n+one\n+two' },
            { filePath: 'src/changed.ts', type: 'update', patch: '@@\n+new\n-old' },
            { filePath: 'src/gone.ts', type: 'delete', patch: '@@\n-a\n-b' },
          ],
        },
      })],
    }));

    const ops = fileOps(deltas);
    expect(ops.map(op => op.type)).toEqual(['write', 'edit', 'delete']);
    // files_deleted was structurally unreachable before this mapping existed.
    expect(ops.find(op => op.type === 'delete')).toMatchObject({
      path: 'src/gone.ts',
      linesRemoved: 2,
    });
    expect(ops.find(op => op.type === 'write')).toMatchObject({ linesAdded: 2 });
  });

  it('records a failed tool without inventing an apiErrorMessage', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'read', {
        status: 'error',
        input: { filePath: 'missing.ts' },
        error: 'ENOENT: no such file or directory',
      })],
    }));

    expect(deltas).toHaveLength(1);
    expect(deltas[0].toolStatus).toEqual({ read: { success: 0, failure: 1 } });
    // Parity with codemie-claude: tool failures surface as failed_tool_calls
    // only. Promoting them to apiErrorMessage would push raw tool stderr into
    // the error_messages wire field, which filterErrorTools does not scrub.
    expect(deltas[0].apiErrorMessage).toBeUndefined();
    expect(deltas[0].fileOperations).toBeUndefined();
  });

  it('reports a turn-level failure as an api error', async () => {
    const deltas = await run(buildSession([
      { ...assistantMessage, error: { name: 'MessageAbortedError', data: { message: 'aborted by user' } } },
    ], { 'msg-a': [] }));

    expect(deltas).toHaveLength(1);
    expect(deltas[0].recordId).toBe('msg-a:error');
    expect(deltas[0].apiErrorMessage).toBe('MessageAbortedError: aborted by user');
  });

  it('emits an error delta even when the turn produced nothing else', async () => {
    const deltas = await run(buildSession([
      { ...assistantMessage, error: { name: 'ProviderError' } },
    ], { 'msg-a': [] }));

    // The old "skip when no tools and no file ops" guard swallowed these.
    expect(deltas).toHaveLength(1);
    expect(deltas[0].apiErrorMessage).toBe('ProviderError');
  });

  it('strips the provider prefix from the model id', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } })],
    }));

    // Was 'codemie-proxy/kimi-k2.7-code', which splits one model across two
    // buckets in backend analytics.
    expect(deltas[0].models).toEqual(['kimi-k2.7-code']);
  });

  it('stamps the branch from the processing context on every delta', async () => {
    const deltas = await run(buildSession([
      { id: 'msg-u', sessionID: OC_SESSION_ID, role: 'user', time: { created: 1 } },
      assistantMessage,
    ], {
      'msg-u': [{ id: 'pu', messageID: 'msg-u', sessionID: OC_SESSION_ID, type: 'text', text: 'do it' }],
      'msg-a': [toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } })],
    }));

    expect(deltas.length).toBeGreaterThan(1);
    // Including the prompt delta — otherwise prompts and tools split across two
    // branch buckets in the aggregator.
    for (const delta of deltas) {
      expect(delta.gitBranch).toBe('main');
    }
  });

  it('gives each tool call its own record and skips in-flight tools', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [
        toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } }),
        toolPart('p2', 'read', { status: 'completed', input: { filePath: 'b.ts' } }),
        toolPart('p3', 'bash', { status: 'running', input: {} }),
      ],
    }));

    expect(deltas.map(d => d.recordId)).toEqual(['msg-a:call-p1', 'msg-a:call-p2']);
  });

  it('does not re-emit deltas on a second pass', async () => {
    const session = buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } })],
    });

    const first = await run(session);
    const second = await run(session);

    // Stable recordIds are what make the incremental sync timer safe to run.
    expect(second).toHaveLength(first.length);
  });

  it('picks up tools appended to a message after an earlier pass', async () => {
    const parts = [toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } })];
    const first = await run(buildSession([assistantMessage], { 'msg-a': parts }));
    expect(first).toHaveLength(1);

    parts.push(toolPart('p2', 'write', {
      status: 'completed',
      input: { filePath: 'b.ts', content: 'x' },
    }));
    const second = await run(buildSession([assistantMessage], { 'msg-a': parts }));

    // With a bare message-id recordId the message was claimed on the first pass
    // and every tool it accumulated afterwards was lost.
    expect(second.map(d => d.recordId)).toEqual(['msg-a:call-p1', 'msg-a:call-p2']);
  });

  it('carries no token or cost fields', async () => {
    const deltas = await run(buildSession([assistantMessage], {
      'msg-a': [toolPart('p1', 'read', { status: 'completed', input: { filePath: 'a.ts' } })],
    }));

    // codemie-claude sends none, so codemie-opencode sends none.
    for (const delta of deltas) {
      expect(delta).not.toHaveProperty('tokens');
      expect(delta).not.toHaveProperty('cost');
    }
  });

  describe('F5-8 v2 file-diff metadata', () => {
    const patch = '@@ -1,1 +1,2 @@\n+one\n+two\n-old';

    it.each(['edit', 'patch', 'apply_patch'])('maps v2 statuses and numeric counts through real %s deltas', async tool => {
      const files = [
        { file: join('src', 'added.ts'), status: 'added', additions: 7, deletions: 0, patch },
        { file: join('src', 'modified.ts'), status: 'modified', additions: 4, deletions: 3, patch },
        { file: join('src', 'deleted.ts'), status: 'deleted', additions: 0, deletions: 9, patch },
      ];
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('v2', tool, { status: 'completed', input: {}, metadata: { files } })],
      }));
      expect(fileOps(deltas)).toEqual([
        { type: 'write', path: files[0].file, linesAdded: 7 },
        { type: 'edit', path: files[1].file, linesAdded: 4, linesRemoved: 3 },
        { type: 'delete', path: files[2].file, linesRemoved: 9 },
      ]);
      expect(deltas[0].recordId).toBe('msg-a:call-v2');
      expect(deltas[0].toolStatus).toEqual({ [tool]: { success: 1, failure: 0 } });
    });

    it.each([
      [0, 0, undefined, undefined],
      [0, undefined, undefined, 1],
      [undefined, 0, 2, undefined],
      [undefined, undefined, 2, 1],
      [-1, 6, 2, 6],
      [8, -1, 8, 1],
      ['5', 1.5, 2, 1],
      [null, NaN, 2, 1],
      [Infinity, -Infinity, 2, 1],
    ])('validates counts independently: additions=%j deletions=%j', async (additions, deletions, linesAdded, linesRemoved) => {
      const file = join('src', 'counts.ts');
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('counts', 'edit', {
          status: 'completed', input: {},
          metadata: { files: [{ file, status: 'modified', additions, deletions, patch }] },
        })],
      }));
      const operation = fileOps(deltas)[0];
      expect(operation).toMatchObject({ type: 'edit', path: file });
      expect(operation.linesAdded).toBe(linesAdded);
      expect(operation.linesRemoved).toBe(linesRemoved);
    });

    it('does not invent counts when both numbers and patch are absent', async () => {
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('empty', 'patch', {
          status: 'completed', metadata: { files: [{ file: 'empty.ts', status: 'modified' }] },
        })],
      }));
      expect(fileOps(deltas)).toEqual([{ type: 'edit', path: 'empty.ts' }]);
    });

    it.each(['patch', 'apply_patch'])('keeps legacy %s precedence and supports mixed lists', async tool => {
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('mixed', tool, {
          status: 'completed', metadata: { files: [
            { filePath: 'legacy.ts', file: 'ignored-v2.ts', type: 'delete', status: 'added', additions: 99, patch },
            { relativePath: 'relative.ts', type: 'add', patch },
            { file: 'v2.ts', status: 'modified', additions: 5, deletions: 6 },
            null, [], 'not a file', 42, {}, { file: '' }, { file: 7, status: 'added' },
            { file: 'bad-status.ts', status: 'renamed' },
          ] },
        })],
      }));
      expect(fileOps(deltas)).toEqual([
        { type: 'delete', path: 'legacy.ts', linesAdded: 2, linesRemoved: 1 },
        { type: 'write', path: 'relative.ts', linesAdded: 2, linesRemoved: 1 },
        { type: 'edit', path: 'v2.ts', linesAdded: 5, linesRemoved: 6 },
      ]);
    });

    it.each(['filediff', 'diff'])('preserves legacy edit %s over v2 files', async field => {
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('legacy', 'edit', {
          status: 'completed', input: { filePath: 'legacy.ts' }, metadata: {
            [field]: field === 'filediff' ? { patch } : patch,
            files: [{ file: 'ignored.ts', status: 'added', additions: 99 }],
          },
        })],
      }));
      expect(fileOps(deltas)).toEqual([{ type: 'edit', path: 'legacy.ts', linesAdded: 2, linesRemoved: 1 }]);
    });

    it.each([{ files: [] }, { files: [null, {}, { file: 'bad.ts', status: 'unknown' }] }, { files: null }])('keeps the existing edit fallback for invalid/empty files %j', async ({ files }) => {
      const deltas = await run(buildSession([assistantMessage], {
        'msg-a': [toolPart('invalid', 'edit', { status: 'completed', input: { filePath: 'fallback.ts' }, metadata: { files } })],
      }));
      expect(fileOps(deltas)).toEqual([{ type: 'edit', path: 'fallback.ts' }]);
    });

    it('keeps v2 pending/failed tools out of file metrics and remains idempotent', async () => {
      const metadata = { files: [{ file: 'new.ts', status: 'added', additions: 2, deletions: 0 }] };
      const session = buildSession([assistantMessage], {
        'msg-a': [
          toolPart('done', 'patch', { status: 'completed', metadata }),
          toolPart('running', 'patch', { status: 'running', metadata }),
          toolPart('failed', 'patch', { status: 'error', metadata, error: 'failed' }),
        ],
      });
      const first = await run(session);
      const second = await run(session);
      expect(second).toEqual(first);
      expect(fileOps(second)).toEqual([{ type: 'write', path: 'new.ts', linesAdded: 2 }]);
      expect(second.map(delta => delta.recordId)).toEqual(['msg-a:call-done', 'msg-a:call-failed']);
    });
  });
});
