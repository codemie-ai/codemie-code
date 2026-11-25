/**
 * EPMCDME-16971: SubagentStop must not proceed with sync when no session record exists yet
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseHookEvent } from '@/agents/core/types.js';

const ID = 'e5f6a7b8-0000-4000-8000-000000000016';

describe('ensureOwnGeneration without a session record', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'own-generation-missing-'));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    process.env.CODEMIE_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not return "own" (proceed) for a SubagentStop when no record exists yet', async () => {
    const { ensureOwnGeneration } = await import('../own-generation.js');
    const event = {
      hook_event_name: 'SubagentStop',
      session_id: 'native-subagent-1',
      transcript_path: '/tmp/transcript.jsonl',
      permission_mode: 'default',
    } as BaseHookEvent;

    const result = await ensureOwnGeneration(event, ID, undefined, { hookProcess: true });

    // Expected: 'deferred' (not ready yet, nothing synced). Actual (bug): 'own' -> performIncrementalSync
    // -> "Session metadata not found" / "Session not found".
    expect(result).toBe('deferred');
  });
});
