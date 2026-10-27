import { describe, it, expect } from 'vitest';
import { compileToolMatcher, ticketsFromToolInput, DEFAULT_TICKET_TOOLS } from '../tool-tickets.js';

describe('compileToolMatcher', () => {
  it('matches the default Jira glob case-insensitively across MCP naming schemes', () => {
    const matches = compileToolMatcher(DEFAULT_TICKET_TOOLS);
    expect(matches('mcp__claude_ai_Atlassian__getJiraIssue')).toBe(true);
    expect(matches('mcp__atlassian__jira_get_issue')).toBe(true);
    expect(matches('mcp__claude_ai_Atlassian__getConfluencePage')).toBe(false);
    expect(matches('Bash')).toBe(false);
  });

  it('matches the whole name and treats regex characters literally', () => {
    const matches = compileToolMatcher(['mcp__rally.v2__*', ' ']);
    expect(matches('mcp__rally.v2__get_item')).toBe(true);
    expect(matches('mcp__rallyXv2__get_item')).toBe(false);
    expect(matches('prefix_mcp__rally.v2__get_item')).toBe(false);
  });

  it('matches nothing for an empty pattern list', () => {
    expect(compileToolMatcher([])('mcp__jira__get')).toBe(false);
  });
});

describe('ticketsFromToolInput', () => {
  it('reads key-like fields only, ignoring free text', () => {
    const input = {
      cloudId: 'eis.atlassian.net',
      issueIdOrKey: 'cake-807',
      fields: { summary: 'Follow up on NUTLA-12', description: 'see CAKEP-3', parent: { key: 'CAKE-800' } },
    };
    expect(ticketsFromToolInput(input)).toEqual(['CAKE-807', 'CAKE-800']);
  });

  it('extracts every key from a JQL string', () => {
    expect(ticketsFromToolInput({ jql: 'key in (CAKE-1, CAKE-2) OR parent = NUTLA-9' })).toEqual(['CAKE-1', 'CAKE-2', 'NUTLA-9']);
  });

  it('walks arrays and tolerates non-object input', () => {
    expect(ticketsFromToolInput({ issues: [{ issueKey: 'A1-1' }, { issue_key: 'B2-2' }] })).toEqual(['A1-1', 'B2-2']);
    expect(ticketsFromToolInput(undefined)).toEqual([]);
    expect(ticketsFromToolInput('CAKE-1')).toEqual([]);
  });
});
