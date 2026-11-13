/**
 * Pi onSessionEnd: every transcript the run ledger names is claimed by its own ownership
 * sidecar, and no transcript gains a line — pi rebuilds a session from every line it holds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiPluginMetadata } from '../pi.plugin.js';
import { getPiRunLedgerPath } from '../pi.extension.js';

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'cm-pi-owner-1';
const TRANSCRIPT_LINE = '{"type":"session","id":"s1"}\n';
let codemieHome: string;
let projectDir: string;

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'pi-project-'));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(codemieHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function transcript(dir: string): string {
  mkdirSync(join(projectDir, dir), { recursive: true });
  const path = join(projectDir, dir, 'run.jsonl');
  writeFileSync(path, TRANSCRIPT_LINE);
  return path;
}

describe('Pi onSessionEnd ownership markers', () => {
  it('writes one sidecar per ledger transcript and leaves both transcripts unchanged', async () => {
    const first = transcript('a');
    const second = transcript('b');
    writeFileSync(
      join(codemieHome, 'sessions', `${SESSION}.json`),
      JSON.stringify({ sessionId: SESSION, agentName: 'pi', status: 'active', correlation: { status: 'pending' } }),
    );
    writeFileSync(
      getPiRunLedgerPath(SESSION),
      [{ t: 'boot' }, { t: 'session', file: first, piSessionId: 'p1' }, { t: 'session', file: second, piSessionId: 'p2' }]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );

    await PiPluginMetadata.lifecycle!.onSessionEnd!(0, { CODEMIE_SESSION_ID: SESSION });

    const sessionsDir = join(codemieHome, 'sessions');
    const owned = readdirSync(sessionsDir)
      .filter((file) => file.endsWith('-codemie-marker.json'))
      .map((file) => JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')).transcriptPath)
      .sort();
    expect(owned).toEqual([first, second]);
    expect(readFileSync(first, 'utf-8')).toBe(TRANSCRIPT_LINE);
    expect(readFileSync(second, 'utf-8')).toBe(TRANSCRIPT_LINE);
  });
});
