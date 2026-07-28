/**
 * Copilot CLI session discovery unit tests.
 *
 * Discovery reads only workspace.yaml — never the transcript — and must skip session
 * directories that carry no events.jsonl (pre-schema sessions with nothing to parse).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';

let home: string;
const DAY = 24 * 60 * 60 * 1000;

function makeSession(
  id: string,
  createdAt: number,
  opts: { withEvents?: boolean; cwd?: string } = {}
): void {
  const { withEvents = true, cwd = '/repo/app' } = opts;
  const dir = join(home, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workspace.yaml'),
    [
      `id: ${id}`,
      `cwd: ${cwd}`,
      `git_root: ${cwd}`,
      'branch: main',
      `created_at: ${new Date(createdAt).toISOString()}`,
      `updated_at: ${new Date(createdAt + 1000).toISOString()}`,
    ].join('\n')
  );
  if (withEvents) {
    writeFileSync(join(dir, 'events.jsonl'), '{"type":"session.start","data":{}}\n');
  }
}

function newAdapter(): CopilotCliSessionAdapter {
  return new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
  process.env.COPILOT_HOME = home;
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('CopilotCliSessionAdapter.discoverSessions', () => {
  it('returns [] when session-state does not exist', async () => {
    expect(await newAdapter().discoverSessions()).toEqual([]);
  });

  it('honors COPILOT_HOME and points filePath at events.jsonl', async () => {
    makeSession('aaa', Date.now() - DAY);

    const found = await newAdapter().discoverSessions();

    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('aaa');
    expect(found[0].filePath).toBe(join(home, 'session-state', 'aaa', 'events.jsonl'));
    expect(found[0].projectPath).toBe('/repo/app');
    expect(found[0].agentName).toBe('copilot-cli');
    expect(found[0].updatedAt).toBeGreaterThan(found[0].createdAt);
  });

  it('skips session dirs with no events.jsonl', async () => {
    const now = Date.now();
    makeSession('has-events', now - DAY, { withEvents: true });
    makeSession('no-events', now - DAY, { withEvents: false });

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['has-events']);
  });

  it('honors maxAgeDays', async () => {
    const now = Date.now();
    makeSession('recent', now - 2 * DAY);
    makeSession('ancient', now - 90 * DAY);

    const found = await newAdapter().discoverSessions({ maxAgeDays: 30 });

    expect(found.map((d) => d.sessionId)).toEqual(['recent']);
  });

  it('defaults to a 30-day window', async () => {
    const now = Date.now();
    makeSession('inside', now - 10 * DAY);
    makeSession('outside', now - 45 * DAY);

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['inside']);
  });

  it('sorts newest-first and applies limit', async () => {
    const now = Date.now();
    makeSession('older', now - 5 * DAY);
    makeSession('newer', now - 1 * DAY);
    makeSession('middle', now - 3 * DAY);

    const adapter = newAdapter();

    expect((await adapter.discoverSessions()).map((d) => d.sessionId)).toEqual([
      'newer',
      'middle',
      'older',
    ]);
    expect((await adapter.discoverSessions({ limit: 2 })).map((d) => d.sessionId)).toEqual([
      'newer',
      'middle',
    ]);
  });

  it('filters by cwd when supplied, ignoring trailing slashes', async () => {
    const now = Date.now();
    makeSession('match', now - DAY, { cwd: '/repo/app' });
    makeSession('other', now - DAY, { cwd: '/somewhere/else' });

    const found = await newAdapter().discoverSessions({ cwd: '/repo/app/' });

    expect(found.map((d) => d.sessionId)).toEqual(['match']);
  });

  it('skips a session whose manifest is unreadable', async () => {
    const now = Date.now();
    makeSession('good', now - DAY);
    const broken = join(home, 'session-state', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'workspace.yaml'), 'id: [unclosed\n  : :');
    writeFileSync(join(broken, 'events.jsonl'), '{}\n');

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['good']);
  });

  it('excludes timestampless sessions unless asked for them', async () => {
    const dir = join(home, 'session-state', 'no-time');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.yaml'), 'id: no-time\ncwd: /repo/app\n');
    writeFileSync(join(dir, 'events.jsonl'), '{}\n');

    expect(await newAdapter().discoverSessions()).toEqual([]);

    const included = await newAdapter().discoverSessions({ includeTimestampless: true });
    expect(included.map((d) => d.sessionId)).toEqual(['no-time']);
  });
});
