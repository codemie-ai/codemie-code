import { describe, expect, it } from 'vitest';
import { isCountedTranscriptLine, keepFirstAcrossCompaction, keepFirstByUuid } from '../transcript-lines.js';

describe('isCountedTranscriptLine', () => {
  it.each([
    ['an api-request-blob line', { type: 'api-request-blob', message: { role: 'user' } }, false],
    ['a system line with message', { type: 'system', message: {} }, false],
    ['a user line', { type: 'user', message: {} }, true],
    ['an assistant line', { type: 'assistant', message: {} }, true],
    ['a line with message and no type', { message: {} }, true],
    ['a line without message', { type: 'attachment' }, true],
    ['null', null, true],
    ['a string', 'text', true],
  ])('%s → %s', (_label, line, expected) => {
    expect(isCountedTranscriptLine(line)).toBe(expected);
  });
});

describe('keepFirstByUuid', () => {
  it('keeps the first of two user lines with the same uuid, in order', () => {
    const first = { type: 'user', uuid: 'u1', n: 1 };
    const middle = { type: 'assistant', uuid: 'a1' };
    const copy = { type: 'user', uuid: 'u1', n: 2 };

    expect(keepFirstByUuid([first, middle, copy])).toEqual([first, middle]);
  });

  it('keeps lines of other types with a repeated uuid', () => {
    const lines = [{ type: 'attachment', uuid: 'x1' }, { type: 'attachment', uuid: 'x1' }];

    expect(keepFirstByUuid(lines)).toEqual(lines);
  });

  it('keeps lines without a uuid', () => {
    const lines = [{ type: 'user' }, { type: 'user' }, { type: 'assistant', uuid: 7 }, { type: 'assistant', uuid: 7 }];

    expect(keepFirstByUuid(lines)).toEqual(lines);
  });

  it('drops a uuid already in the given set and adds the new ones to it', () => {
    const seen = new Set(['u1']);
    const kept = { type: 'assistant', uuid: 'a1' };

    expect(keepFirstByUuid([{ type: 'user', uuid: 'u1' }, kept], seen)).toEqual([kept]);
    expect([...seen]).toEqual(['u1', 'a1']);
  });
});

describe('keepFirstAcrossCompaction', () => {
  it('keeps the first copy when a compact_boundary lies between the copies', () => {
    const first = { type: 'user', uuid: 'u1', n: 1 };
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'cb' };
    const copy = { type: 'user', uuid: 'u1', n: 2 };

    expect(keepFirstAcrossCompaction([first, boundary, copy])).toEqual([first, boundary]);
  });

  it('keeps the last copy when no compact_boundary lies between the copies', () => {
    const echo = { type: 'user', uuid: 'u1', n: 1 };
    const init = { type: 'system', subtype: 'init', uuid: 's1' };
    const rewritten = { type: 'user', uuid: 'u1', n: 2 };
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'cb' };

    expect(keepFirstAcrossCompaction([echo, init, rewritten, boundary])).toEqual([init, rewritten, boundary]);
  });

  it('keeps lines that appear once and lines without a string uuid, in order', () => {
    const lines = [{ type: 'user' }, { type: 'assistant', uuid: 'a1' }, { type: 'user', uuid: 7 }, { type: 'user', uuid: 7 }, 'text'];

    expect(keepFirstAcrossCompaction(lines)).toEqual(lines);
  });
});
