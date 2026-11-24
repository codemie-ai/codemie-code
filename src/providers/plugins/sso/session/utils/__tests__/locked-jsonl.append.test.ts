/**
 * An append never glues its line to a torn one left by a cut write.
 *
 * Seam: `appendSessionFile` over a temp sessions directory; read back
 * with the tolerant and the strict JSONL readers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { appendSessionFile } = await import('../locked-jsonl.js');
const { readJSONL } = await import('../jsonl-reader.js');
const { readJSONLTolerant } = await import('@/agents/core/session/utils/jsonl-reader.js');

const SESSION_ID = 'torn-append';

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'torn-append-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime: 0 }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('an append after a torn line', () => {
  it('appendSessionFile: the new line is readable, the torn one skipped; the strict reader still rejects the file', async () => {
    const file = join(sessionsDir, `${SESSION_ID}_conversation.jsonl`);
    writeFileSync(file, '{"payloadId":"a"}\n{"payloadId":"tor');

    expect(await appendSessionFile('conversation', SESSION_ID, '{"payloadId":"b"}\n')).toBe(true);

    expect(await readJSONLTolerant(file)).toEqual([{ payloadId: 'a' }, { payloadId: 'b' }]);
    await expect(readJSONL(file)).rejects.toThrow(SyntaxError);
  });
});
