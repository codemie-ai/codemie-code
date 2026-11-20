import { describe, it, expect } from 'vitest';
import { renderHint } from '../hint.js';

describe('renderHint', () => {
  it('renders the command variant', () => {
    expect(renderHint({ reason: 'Daemon stopped', command: 'codemie proxy start' })).toBe(
      'Daemon stopped — run: codemie proxy start'
    );
  });

  it('renders the action variant', () => {
    expect(renderHint({ reason: 'Config is invalid', action: 'fix or delete it' })).toBe(
      'Config is invalid — fix or delete it'
    );
  });

  it('prefers the command when both are given', () => {
    expect(renderHint({ reason: 'r', command: 'c', action: 'a' })).toBe('r — run: c');
  });

  it('returns the reason unchanged when there is no command or action', () => {
    expect(renderHint({ reason: 'Nothing to do' })).toBe('Nothing to do');
  });
});
