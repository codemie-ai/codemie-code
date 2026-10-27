/**
 * Ticket ids from tool calls: which tools count (case-insensitive name globs) and which input
 * fields are read. Only key-like fields are scanned, so free text a tool carries — an issue
 * description, a comment body — is never read.
 */

import { extractTicketMentions } from '@/agents/core/ticket-parser.js';

/** Default tool-name globs: every Jira-flavoured MCP tool (`mcp__claude_ai_Atlassian__getJiraIssue`, `mcp__atlassian__jira_get_issue`, ...). */
export const DEFAULT_TICKET_TOOLS: readonly string[] = ['mcp__*jira*'];

/** Input fields that carry an issue key rather than free text. */
export const TICKET_KEY_FIELDS: ReadonlySet<string> = new Set(['issueIdOrKey', 'issueKey', 'issue_key', 'key', 'parent', 'jql']);

/** Longest field value scanned, so a pasted log inside a JQL string cannot stall the report. */
const MAX_VALUE_CHARS = 64 * 1024;

/** Ids collected from one call, before the per-session cap is applied. */
const MAX_IDS_PER_CALL = 20;

/** Deepest nesting walked; real tool inputs are a level or two deep. */
const MAX_DEPTH = 8;

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
}

/** A matcher for tool names: true when any glob matches the whole name, ignoring case. */
export function compileToolMatcher(globs: readonly string[]): (name: string) => boolean {
  const patterns = globs.map((glob) => glob.trim()).filter(Boolean).map(globToRegExp);
  return (name) => patterns.some((pattern) => pattern.test(name));
}

/**
 * Distinct ticket ids found in the key-like fields of a tool input, at any nesting depth,
 * upper-cased, first-seen order. Strings in other fields are ignored.
 */
export function ticketsFromToolInput(input: unknown, fields: ReadonlySet<string> = TICKET_KEY_FIELDS): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    const entries = Array.isArray(value) ? value.map((item) => [undefined, item] as const) : Object.entries(value);
    for (const [key, item] of entries) {
      if (key !== undefined && fields.has(key) && typeof item === 'string') {
        for (const id of extractTicketMentions(item.slice(0, MAX_VALUE_CHARS), MAX_IDS_PER_CALL)) found.add(id);
      } else {
        walk(item, depth + 1);
      }
    }
  };
  walk(input, 0);
  return [...found];
}
