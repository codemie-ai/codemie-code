import { describe, it, expect } from 'vitest';
import { resolveCommandFields } from '../event-fields/command-fields.js';

describe('resolveCommandFields', () => {
  it.each([
    ['/simplify foo-test', 'simplify'],
    ['/sdlc-factory:sdlc-standard test args', 'sdlc-factory:sdlc-standard'],
    ['  /Review\nmultiline args', 'Review'],
    ['/simplify', 'simplify'],
  ])('parses %j as %j', (prompt, expected) => {
    expect(resolveCommandFields(prompt)).toEqual({ command_name: expected });
  });

  it.each([
    ['plain text', 'test message'],
    ['empty prompt', ''],
    ['bare slash', '/'],
    ['absolute path', '/Users/foo/bar is broken'],
    ['url', 'https://example.com/a'],
    ['slash mid-prompt', 'run /simplify please'],
    ['machine-injected tag', '<task-notification>/x</task-notification>'],
    ['slash then space', '/ simplify'],
  ])('returns empty for %s', (_label, prompt) => {
    expect(resolveCommandFields(prompt)).toEqual({ command_name: '' });
  });
});
