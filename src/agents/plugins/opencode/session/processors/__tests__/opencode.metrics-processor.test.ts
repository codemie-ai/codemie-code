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

    // OpenCode never emits numeric additions/deletions, so the old code that
    // read file.additions produced zeros for every edit.
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
});
