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
    expect(ticketsFromToolInput({ jql: 'summary ~ "node-18" ORDER BY created' })).toEqual([]);
    expect(ticketsFromToolInput({ issueIdOrKey: 'epmcdme-77' })).toEqual(['EPMCDME-77']);
  });

  it('accepts any case in the value of a JQL issue-key clause', () => {
    expect(ticketsFromToolInput({ jql: 'key = epmcdme-7 OR key = EPMCDME-8' })).toEqual(['EPMCDME-7', 'EPMCDME-8']);
    expect(ticketsFromToolInput({ jql: 'issue in (ab-1, "cd-2") AND parent != \'ef-3\' AND issueKey NOT IN (gh-4)' })).toEqual(['AB-1', 'CD-2', 'EF-3', 'GH-4']);
    expect(ticketsFromToolInput({ jql: 'labels = utf-8 AND text ~ "key = sha-1"' })).toEqual([]);
  });

  it('never reads ids from JQL text-search values, in either case', () => {
    expect(ticketsFromToolInput({ jql: 'project = EPMCDME AND summary ~ "UTF-8 crash on GPT-4"' })).toEqual([]);
    expect(ticketsFromToolInput({ jql: "text ~ 'GPT-4 rollout' AND key = abc-1" })).toEqual(['ABC-1']);
    expect(ticketsFromToolInput({ jql: 'description !~ "SHA-256" OR parent = NUTLA-5' })).toEqual(['NUTLA-5']);
    expect(ticketsFromToolInput({ jql: 'project = EPMCDME AND text ~ "OAUTH-2 flow"' })).toEqual([]);
    expect(ticketsFromToolInput({ jql: "summary ~ 'NODE-18 upgrade'" })).toEqual([]);
    expect(ticketsFromToolInput({ jql: 'summary ~ UTF-8 AND key = CAKE-1' })).toEqual(['CAKE-1']);
  });

  it('never decodes JSON pasted into free-text fields', () => {
    // A Jira API response pasted into a comment or description must not attribute its keys.
    expect(ticketsFromToolInput({ issueIdOrKey: 'CAKE-1', description: '{"key":"LEAK-2"}', comment: '[{"key":"LEAK-3"}]', body: '{"issueKey":"LEAK-4"}' })).toEqual(['CAKE-1']);
    expect(ticketsFromToolInput({ fields: '{"parent":{"key":"XY-2"}}', update: '{"issuelinks":[{"add":{"outwardIssue":{"key":"XY-3"}}}]}' })).toEqual(['XY-2', 'XY-3']);
  });

  it('keeps a text search whole when it contains escaped quotes', () => {
    expect(ticketsFromToolInput({ jql: 'summary ~ "say \\"GPT-4\\" here" AND key = CAKE-1' })).toEqual(['CAKE-1']);
    expect(ticketsFromToolInput({ jql: "text ~ 'it\\'s GPT-4' AND key = CAKE-2" })).toEqual(['CAKE-2']);
    expect(ticketsFromToolInput({ jql: 'key = "CAKE-3" AND summary ~ "\\"UTF-8\\""' })).toEqual(['CAKE-3']);
  });

  it('never reads values of conditions on fields that do not hold issue keys', () => {
    expect(ticketsFromToolInput({ jql: 'fixVersion = "APP-2"' })).toEqual([]);
    expect(ticketsFromToolInput({ jql: 'fixVersion = APP-2 AND key = CAKE-1' })).toEqual(['CAKE-1']);
    expect(ticketsFromToolInput({ jql: 'labels in (GPT-4, UTF-8) AND sprint = OPS-3 AND issuekey = NUTLA-5' })).toEqual(['NUTLA-5']);
  });

  it('reads keys inside JQL issue functions in any case', () => {
    expect(ticketsFromToolInput({ jql: 'issue in linkedIssues(abc-7)' })).toEqual(['ABC-7']);
    expect(ticketsFromToolInput({ jql: 'issue in linkedIssues("CAKE-9", "is blocked by") OR parent in childIssuesOf(nutla-1)' })).toEqual(['CAKE-9', 'NUTLA-1']);
  });

  it('still reads an upper-case key that stands outside any condition', () => {
    expect(ticketsFromToolInput({ jql: 'ORDER BY created' })).toEqual([]);
    expect(ticketsFromToolInput({ jql: 'CAKE-807' })).toEqual(['CAKE-807']);
  });

  it('reads key fields of the configured Atlassian MCP tools and other spellings by convention', () => {
    // jira_add_issues_to_sprint and jira_create_issue, as configured in this environment.
    expect(ticketsFromToolInput({ sprintId: 42, issueKeys: ['NUTLA-858', 'NUTLA-859'] })).toEqual(['NUTLA-858', 'NUTLA-859']);
    expect(ticketsFromToolInput({ projectKey: 'NUTLA', summary: 'About CAKE-1', epicKey: 'CAKE-351', parentKey: 'NUTLA-851' })).toEqual(['CAKE-351', 'NUTLA-851']);
    // Snake-case spellings used by other Atlassian MCP servers.
    expect(ticketsFromToolInput({ issue_keys: 'AB-1,AB-2', epic_key: 'EP-3', inward_issue_key: 'IN-4', outward_issue_key: 'OUT-5', issue_ids_or_keys: ['ID-6'] }))
      .toEqual(['AB-1', 'AB-2', 'EP-3', 'IN-4', 'OUT-5', 'ID-6']);
  });

  it('does not treat project keys or look-alike names as key fields', () => {
    expect(ticketsFromToolInput({ projectKey: 'NUTLA-1', monkey: 'AB-1', keyboard: 'CD-2', issueSummary: 'EF-3' })).toEqual([]);
  });

  it('walks arrays and tolerates non-object input', () => {
    expect(ticketsFromToolInput({ issues: [{ issueKey: 'A1-1' }, { issue_key: 'B2-2' }] })).toEqual(['A1-1', 'B2-2']);
    expect(ticketsFromToolInput(undefined)).toEqual([]);
    expect(ticketsFromToolInput('CAKE-1')).toEqual([]);
  });
});
