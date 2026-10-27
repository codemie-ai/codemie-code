/**
 * Ticket ids from tool calls: which tools count (case-insensitive name globs) and which input
 * fields are read. Only key-like fields are scanned, so free text a tool carries — an issue
 * description, a comment body — is never read.
 */

import { extractTicketMentions } from '@/agents/core/ticket-parser.js';

/**
 * Default tool-name globs: Jira-flavoured MCP tools (`mcp__claude_ai_Atlassian__getJiraIssue`,
 * `mcp__atlassian__jira_get_issue`, ...) and Atlassian issue tools whose name does not say "jira"
 * (`mcp__claude_ai_Atlassian__createIssueLink`).
 */
export const DEFAULT_TICKET_TOOLS: readonly string[] = ['mcp__*jira*', 'mcp__*atlassian*__*issue*'];

/** Input fields that carry an issue key rather than free text. */
export const TICKET_KEY_FIELDS: ReadonlySet<string> = new Set([
  'issueIdOrKey', 'issueKey', 'issue_key', 'key', 'parent', 'jql', 'inwardIssue', 'outwardIssue',
]);

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

/** A string holding a JSON object or array (e.g. `additional_fields: '{"parent":"X-1"}'`), parsed; else undefined. */
function embeddedJson(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length > MAX_VALUE_CHARS || !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Distinct ticket ids found in the key-like fields of a tool input, at any nesting depth,
 * upper-cased, first-seen order. A key field may hold a string or an array of strings; JSON
 * encoded inside any string is walked too. Plain strings in other fields are ignored.
 */
export function ticketsFromToolInput(input: unknown, fields: ReadonlySet<string> = TICKET_KEY_FIELDS): string[] {
  const found = new Set<string>();
  const scan = (text: string): void => {
    for (const id of extractTicketMentions(text.slice(0, MAX_VALUE_CHARS), MAX_IDS_PER_CALL)) found.add(id);
  };
  const walk = (value: unknown, depth: number, inKeyField: boolean): void => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (inKeyField) scan(value);
      else {
        const parsed = embeddedJson(value);
        if (parsed !== undefined) walk(parsed, depth + 1, false);
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, inKeyField);
      return;
    }
    for (const [key, item] of Object.entries(value)) walk(item, depth + 1, fields.has(key));
  };
  walk(input, 0, false);
  return [...found];
}
