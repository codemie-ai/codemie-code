/**
 * Ticket ids from tool calls: which tools count (case-insensitive name globs) and which input
 * fields are read. Only key-like fields are scanned, so free text a tool carries — an issue
 * description, a comment body — is never read.
 */

import { TICKET_RE, extractTicketMentions } from '@/agents/core/ticket-parser.js';

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

/**
 * Fields holding query text rather than a bare key. Free-text clauses (`text ~ "utf-8"`) would
 * otherwise produce ids, so a query is matched case-sensitively — except the value of an issue-key
 * clause (`key = epmcdme-7`, `issue in (a-1, B-2)`, `parent != x-3`), where Jira accepts any case.
 */
const QUERY_FIELDS: ReadonlySet<string> = new Set(['jql']);

/** The value of a JQL clause on an issue-key field: one key, quoted or not, or an `in (…)` list. */
const JQL_KEY_CLAUSE = /\b(?:key|issue|issuekey|parent)\s*(?:!?=|(?:not\s+)?in\b)\s*(\([^)]*\)|"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)/gi;

/** Text-search values (`summary ~ "…"`, `text !~ '…'`): free text, never read as clauses. */
const JQL_TEXT_SEARCH = /!?~\s*(?:"[^"]*"|'[^']*')/g;

function jqlIds(text: string): string[] {
  const ids = new Set<string>();
  for (const clause of text.replace(JQL_TEXT_SEARCH, ' ').matchAll(JQL_KEY_CLAUSE)) {
    for (const id of extractTicketMentions(clause[1], MAX_IDS_PER_CALL)) ids.add(id);
  }
  for (const id of text.match(new RegExp(TICKET_RE.source, TICKET_RE.flags.replace('i', ''))) ?? []) ids.add(id);
  return [...ids].slice(0, MAX_IDS_PER_CALL);
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
  const scan = (text: string, field: string): void => {
    const value = text.slice(0, MAX_VALUE_CHARS);
    const ids = QUERY_FIELDS.has(field) ? jqlIds(value) : extractTicketMentions(value, MAX_IDS_PER_CALL);
    for (const id of ids) found.add(id);
  };
  /** `field` is the key-like field being read, or null outside one. */
  const walk = (value: unknown, depth: number, field: string | null): void => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (field !== null) scan(value, field);
      else {
        const parsed = embeddedJson(value);
        if (parsed !== undefined) walk(parsed, depth + 1, null);
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, field);
      return;
    }
    for (const [key, item] of Object.entries(value)) walk(item, depth + 1, fields.has(key) ? key : null);
  };
  walk(input, 0, null);
  return [...found];
}
