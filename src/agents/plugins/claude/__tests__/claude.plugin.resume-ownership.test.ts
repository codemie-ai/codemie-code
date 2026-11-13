/**
 * ClaudePlugin.resolveResumeOwnership resolves the id given to `--resume` against the real
 * session records on disk (temp CODEMIE_HOME), accepting either the native Claude id or the
 * CodeMie session id shown by `codemie analytics` / `codemie log list-sessions` (EPMCDME-17189).
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudePlugin } from '../claude.plugin.js';

const HOME = join(tmpdir(), `codemie-claude-resume-ownership-${process.pid}`);
const SESSIONS = join(HOME, 'sessions');
let previousHome: string | undefined;

function writeCompleted(codemieId: string, record: Record<string, unknown>): void {
  writeFileSync(join(SESSIONS, `completed_${codemieId}.json`), JSON.stringify(record));
}

function resolve(resumeId: string): ReturnType<ClaudePlugin['resolveResumeOwnership']> {
  return new ClaudePlugin().resolveResumeOwnership({
    resumeId,
    cwd: process.cwd(),
    env: process.env,
  });
}

beforeEach(() => {
  previousHome = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = HOME;
  mkdirSync(SESSIONS, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.CODEMIE_HOME;
  } else {
    process.env.CODEMIE_HOME = previousHome;
  }
  rmSync(HOME, { recursive: true, force: true });
});

describe('ClaudePlugin.resolveResumeOwnership', () => {
  it('resolves a CodeMie session id to the native id and keeps the session owned', async () => {
    writeCompleted('cm-1', {
      sessionId: 'cm-1',
      agentName: 'claude',
      correlation: { agentSessionId: 'native-1' },
    });

    const result = await resolve('cm-1');

    expect(result).toEqual({
      supported: true,
      owned: true,
      nativeResumeId: 'native-1',
      fallbackResumeCommand: 'claude --resume native-1',
      auditData: {
        nativeAgent: 'claude',
        nativeResumeId: 'native-1',
        codemieSessionId: 'cm-1',
      },
    });
  });

  it('resolves a native id to itself', async () => {
    writeCompleted('cm-1', {
      sessionId: 'cm-1',
      agentName: 'claude',
      correlation: { agentSessionId: 'native-1' },
    });

    const result = await resolve('native-1');

    expect(result.owned).toBe(true);
    expect(result.nativeResumeId).toBe('native-1');
  });

  it('reports an unknown id as not owned, with the fallback command using the given id', async () => {
    const result = await resolve('nope');

    expect(result).toEqual({
      supported: true,
      owned: false,
      nativeResumeId: undefined,
      fallbackResumeCommand: 'claude --resume nope',
      auditData: { nativeAgent: 'claude', nativeResumeId: 'nope' },
    });
  });

  it('keeps an owned record without a usable native id owned, with no id to rewrite', async () => {
    writeCompleted('cm-2', {
      sessionId: 'cm-2',
      agentName: 'claude',
      correlation: { agentSessionId: 'unknown' },
    });

    const result = await resolve('cm-2');

    expect(result.owned).toBe(true);
    expect(result.nativeResumeId).toBeUndefined();
  });
});
