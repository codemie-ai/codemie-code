import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeActiveDuration } from '../codex.active-duration.js';

describe('computeActiveDuration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-active-'));
  });
  afterEach(async () => {
    // Async removal: a rollout stream closes only when the event loop runs, and on Windows the
    // file stays held until then.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const at = (s: number): string => new Date(Date.UTC(2026, 10, 10, 10, 0, 0) + s * 1000).toISOString();
  const START = Date.UTC(2026, 10, 10, 10, 0, 0);
  const started = (s: number, id: string): string =>
    JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', turn_attribution: { turn_id: id } } });
  const startedLegacy = (s: number, id: string): string =>
    JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
  const complete = (s: number, id: string): string =>
    JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_complete', turn_id: id } });
  const other = (s: number): string => JSON.stringify({ timestamp: at(s), type: 'response_item', payload: { type: 'message' } });

  function file(lines: string[]): string {
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('sums two turns separated by an idle hour', async () => {
    const path = file([started(0, 'a'), complete(60, 'a'), started(3660, 'b'), complete(3690, 'b')]);
    expect(await computeActiveDuration(path, 0, START + 10_000_000)).toBe(90_000);
  });

  it('accepts the legacy turn_id on task_started', async () => {
    const path = file([startedLegacy(0, 'a'), complete(10, 'a')]);
    expect(await computeActiveDuration(path, 0, START + 1_000_000)).toBe(10_000);
  });

  it('ends an interrupted turn at the last record before the next task_started', async () => {
    const path = file([started(0, 'a'), other(20), other(40), started(100, 'b'), complete(130, 'b')]);
    expect(await computeActiveDuration(path, 0, START + 1_000_000)).toBe(40_000 + 30_000);
  });

  it('ends an open turn at the last record of the file', async () => {
    const path = file([started(0, 'a'), other(25)]);
    expect(await computeActiveDuration(path, 0, START + 1_000_000)).toBe(25_000);
  });

  it('returns 0 when there are no turns', async () => {
    const path = file([other(1), other(2)]);
    expect(await computeActiveDuration(path, 0, START + 1_000_000)).toBe(0);
  });

  it('clips a turn at the run start and at the session end', async () => {
    const path = file([started(0, 'a'), complete(100, 'a')]);
    expect(await computeActiveDuration(path, START + 40_000, START + 1_000_000)).toBe(60_000);
    expect(await computeActiveDuration(path, 0, START + 70_000)).toBe(70_000);
  });

  it('counts a turn wholly before the run start as 0', async () => {
    const path = file([started(0, 'a'), complete(50, 'a')]);
    expect(await computeActiveDuration(path, START + 60_000, START + 1_000_000)).toBe(0);
  });

  it('skips unparsable lines', async () => {
    const path = file([started(0, 'a'), '{not json', complete(5, 'a')]);
    expect(await computeActiveDuration(path, 0, START + 1_000_000)).toBe(5_000);
  });

  it('returns 0 for a file that cannot be read', async () => {
    expect(await computeActiveDuration(join(dir, 'missing.jsonl'), 0, START)).toBe(0);
  });

  it('sums the two turns of the real rollout fixture', async () => {
    const path = join(__dirname, 'fixtures', 'rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl');
    const first = Date.parse('2026-05-11T08:27:32.911Z') - Date.parse('2026-05-11T08:27:17.493Z');
    const second = Date.parse('2026-05-11T08:44:58.544Z') - Date.parse('2026-05-11T08:32:57.430Z');
    expect(await computeActiveDuration(path, 0, Date.now())).toBe(first + second);
  });
});
