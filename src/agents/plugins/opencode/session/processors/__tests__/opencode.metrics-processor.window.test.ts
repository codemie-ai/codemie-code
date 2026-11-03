/**
 * The run window keeps a record to its own slice of the transcript: [startTime, upper bound).
 *
 * Seam: OpenCodeMetricsProcessor over the real MetricsWriter and run window on a temp sessions directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedSession } from '../../../../../core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { OpenCodeMetricsProcessor } = await import('../opencode.metrics-processor.js');

const SESSION_ID = 'opencode-window';
const OC_SESSION_ID = 'ses_window';
const T = Date.parse('2026-09-03T12:00:00.000Z');

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

const assistant = (id: string, offsetMs: number) => ({
  id, sessionID: OC_SESSION_ID, role: 'assistant', time: { created: T + offsetMs }, modelID: 'kimi-k2.7-code',
});
const toolPart = (messageID: string) => ({
  id: `part-${messageID}`, messageID, sessionID: OC_SESSION_ID, type: 'tool', callID: 'call', tool: 'bash',
  state: { status: 'completed', input: {} },
});
const ids = ['before', 'inside', 'later'];
const session = {
  sessionId: SESSION_ID,
  agentName: 'OpenCode CLI',
  messages: [assistant('before', -1000), assistant('inside', 1000), assistant('later', 11_000)],
  metadata: {
    storagePath: '/nonexistent/storage',
    openCodeSessionId: OC_SESSION_ID,
    storageType: 'sqlite',
    partsMap: Object.fromEntries(ids.map((id) => [id, [toolPart(id)]])),
  },
} as unknown as ParsedSession;

const recordIds = () => readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
  .map((line) => (JSON.parse(line) as { recordId: string }).recordId);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'opencode-window-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime: T }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('OpenCodeMetricsProcessor run window', () => {
  it('writes only the message inside [startTime, recordsBeforeMs)', async () => {
    const result = await new OpenCodeMetricsProcessor().process(session, { gitBranch: 'main', recordsBeforeMs: T + 10_000 } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside:call']);
  });

  it('a hook process without recordsBeforeMs has no upper bound, only the start bound', async () => {
    const result = await new OpenCodeMetricsProcessor().process(session, { gitBranch: 'main', hookProcess: true } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside:call', 'later:call']);
  });
});
