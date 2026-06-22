import { describe, it, expect } from 'vitest';
import { stripClear } from '../strip-clear.js';

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

describe('stripClear', () => {
  it('returns the original array unchanged when there is no /clear', () => {
    const msgs = [normalUser, assistant];
    expect(stripClear(msgs)).toEqual([normalUser, assistant]);
  });

  it('returns messages after the /clear sentinel (sentinel excluded)', () => {
    // Real-world shape: post-/clear file starts with the sentinel, then new messages
    const msgs = [xmlClear, normalUser, assistant];
    expect(stripClear(msgs)).toEqual([normalUser, assistant]);
  });

  it('trims to after the LAST sentinel when multiple are present', () => {
    const a = { type: 'user', message: { role: 'user', content: 'task a' } };
    const b = { type: 'user', message: { role: 'user', content: 'task b' } };
    const msgs = [normalUser, assistant, xmlClear, a, assistant, xmlClear, b, assistant];
    expect(stripClear(msgs)).toEqual([b, assistant]);
  });

  it('returns an empty array when /clear is the final message', () => {
    expect(stripClear([normalUser, assistant, xmlClear])).toEqual([]);
  });

  it('handles array-content /clear the same as string-content', () => {
    const msgs = [arrayXmlClear, normalUser, assistant];
    expect(stripClear(msgs)).toEqual([normalUser, assistant]);
  });

  it('returns an empty array unchanged', () => {
    expect(stripClear([])).toEqual([]);
  });
});
