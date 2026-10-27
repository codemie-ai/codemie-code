import { describe, it, expect } from 'vitest';
import { compileToolMatcher, ticketsFromToolInput, DEFAULT_TICKET_TOOLS } from '../tool-tickets.js';

describe('compileToolMatcher', () => {
  it('matches the default Jira glob case-insensitively across MCP naming schemes', () => {
    const matches = compileToolMatcher(DEFAULT_TICKET_TOOLS);
    expect(matches('mcp__claude_ai_Atlassian__getJiraIssue')).toBe(true);
    expect(matches('mcp__atlassian__jira_get_issue')).toBe(true);
    expect(matches('mcp__claude_ai_Atlassian__createIssueLink')).toBe(true);
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

  it('reads issue-link endpoints and arrays of keys in a key field', () => {
    expect(ticketsFromToolInput({ type: 'Blocks', inwardIssue: 'CAKE-1', outwardIssue: 'CAKE-2' })).toEqual(['CAKE-1', 'CAKE-2']);
    expect(ticketsFromToolInput({ key: ['AB-1', 'CD-2'] })).toEqual(['AB-1', 'CD-2']);
  });

  it('reads key fields inside JSON encoded in a string, but not free text there', () => {
    const input = { summary: 'About NUTLA-9', additional_fields: '{"parent":"XY-1","description":"mentions Y-2"}' };
    expect(ticketsFromToolInput(input)).toEqual(['XY-1']);
    expect(ticketsFromToolInput({ additional_fields: '{not json' })).toEqual([]);
  });

  it('matches JQL case-sensitively, so free-text clauses produce no ids', () => {
    expect(ticketsFromToolInput({ jql: 'text ~ "utf-8" AND key = CAKE-1' })).toEqual(['CAKE-1']);
    expect(ticketsFromToolInput({ issueIdOrKey: 'epmcdme-77' })).toEqual(['EPMCDME-77']);
  });

  it('walks arrays and tolerates non-object input', () => {
    expect(ticketsFromToolInput({ issues: [{ issueKey: 'A1-1' }, { issue_key: 'B2-2' }] })).toEqual(['A1-1', 'B2-2']);
    expect(ticketsFromToolInput(undefined)).toEqual([]);
    expect(ticketsFromToolInput('CAKE-1')).toEqual([]);
  });
});
