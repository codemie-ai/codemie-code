import { describe, it, expect } from 'vitest';
import { resolveTicketSources, resolveTicketTools, TicketOptionsError } from '../options.js';
import { DEFAULT_TICKET_TOOLS } from '../tool-tickets.js';

describe('resolveTicketSources', () => {
  it('defaults to every source, and to tool,branch under --redact', () => {
    expect([...resolveTicketSources(undefined, false)]).toEqual(['tool', 'branch', 'prompt']);
    expect([...resolveTicketSources(undefined, true)]).toEqual(['tool', 'branch']);
  });

  it('lets --redact opt back in to prompts explicitly', () => {
    expect([...resolveTicketSources('tool, PROMPT', true)]).toEqual(['tool', 'prompt']);
  });

  it('turns extraction off with none', () => {
    expect(resolveTicketSources('none', false).size).toBe(0);
  });

  it('says that none cannot be combined, instead of calling it invalid', () => {
    expect(() => resolveTicketSources('none,tool', false)).toThrow(/none turns ticket extraction off and cannot be combined/);
  });

  it('rejects unknown and empty values', () => {
    expect(() => resolveTicketSources('tool,title', false)).toThrow(TicketOptionsError);
    expect(() => resolveTicketSources(' , ', false)).toThrow(TicketOptionsError);
  });
});

describe('resolveTicketTools', () => {
  it('prefers the flag, then the config key, then the built-in default', () => {
    expect(resolveTicketTools('mcp__*rally*, mcp__*jira*', ['ignored'])).toEqual(['mcp__*rally*', 'mcp__*jira*']);
    expect(resolveTicketTools(undefined, ['mcp__*rally*'])).toEqual(['mcp__*rally*']);
    expect(resolveTicketTools(undefined, undefined)).toEqual([...DEFAULT_TICKET_TOOLS]);
    expect(resolveTicketTools(undefined, [42, ''])).toEqual([...DEFAULT_TICKET_TOOLS]);
  });

  it('rejects an empty flag value', () => {
    expect(() => resolveTicketTools(' ,', undefined)).toThrow(TicketOptionsError);
  });
});
