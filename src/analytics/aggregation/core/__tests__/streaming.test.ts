import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamJSONL } from '../streaming';

describe('streamJSONL', () => {
  it('parses single, concatenated, array, and multi-line JSON, and skips invalid', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dir = await mkdtemp(join(tmpdir(), 'codemie-test-'));
    const file = join(dir, 'test.jsonl');

    const lines = [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ b: 2 }) + JSON.stringify({ c: 3 }),
      JSON.stringify([{ d: 4 }, { e: 5 }]),
      '{\n  "f": 6,\n  "g": {"h":7}\n}',
      '{"bad": "unterminated'
    ];

    await writeFile(file, lines.join('\n') + '\n', 'utf-8');

    const objs: any[] = [];
    for await (const o of streamJSONL(file)) {
      objs.push(o);
    }

    expect(objs).toEqual(expect.arrayContaining([
      { a: 1 },
      { b: 2 },
      { c: 3 },
      { d: 4 },
      { e: 5 },
      { f: 6, g: { h: 7 } }
    ]));

    await rm(dir, { recursive: true, force: true });
    spy.mockRestore();
  });
});
