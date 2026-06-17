import { describe, it, expect } from 'vitest';
import { isClearMessage, splitByClear } from '../claude-clear-boundary.js';

const xmlClear = {
  type: 'user',
  message: { role: 'user', content: '<command-name>/clear</command-name>' },
};

const arrayXmlClear = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: '<command-name>/clear</command-name>' }],
  },
};

const normalUser = {
  type: 'user',
  message: { role: 'user', content: 'help me fix this bug' },
};

const assistant = { type: 'assistant', message: { role: 'assistant' } };

describe('isClearMessage', () => {
  it('detects string-content /clear', () => {
    expect(isClearMessage(xmlClear)).toBe(true);
  });

  it('detects array text-block /clear', () => {
    expect(isClearMessage(arrayXmlClear)).toBe(true);
  });

  it('returns false for a normal user message', () => {
    expect(isClearMessage(normalUser)).toBe(false);
  });

  it('returns false for an assistant message', () => {
    expect(isClearMessage(assistant)).toBe(false);
  });

  it('returns false for null / non-object', () => {
    expect(isClearMessage(null)).toBe(false);
    expect(isClearMessage('string')).toBe(false);
  });
});

describe('splitByClear', () => {
  it('returns one segment when there is no /clear', () => {
    const msgs = [normalUser, assistant];
    const result = splitByClear(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([normalUser, assistant]);
  });

  it('splits at a single /clear into two segments (clear itself excluded)', () => {
    const msgs = [normalUser, assistant, xmlClear, normalUser, assistant];
    const result = splitByClear(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([normalUser, assistant]);
    expect(result[1]).toEqual([normalUser, assistant]);
  });

  it('splits at two /clears into three segments', () => {
    const a = { type: 'user', message: { role: 'user', content: 'task a' } };
    const b = { type: 'user', message: { role: 'user', content: 'task b' } };
    const c = { type: 'user', message: { role: 'user', content: 'task c' } };
    const msgs = [a, assistant, xmlClear, b, assistant, xmlClear, c, assistant];
    const result = splitByClear(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([a, assistant]);
    expect(result[1]).toEqual([b, assistant]);
    expect(result[2]).toEqual([c, assistant]);
  });

  it('produces an empty last segment when /clear is the final message', () => {
    const msgs = [normalUser, assistant, xmlClear];
    const result = splitByClear(msgs);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual([]);
  });

  it('handles array-content /clear the same as string-content', () => {
    const msgs = [normalUser, assistant, arrayXmlClear, normalUser];
    const result = splitByClear(msgs);
    expect(result).toHaveLength(2);
  });

  it('returns [[]] for an empty array', () => {
    expect(splitByClear([])).toEqual([[]]);
  });
});
