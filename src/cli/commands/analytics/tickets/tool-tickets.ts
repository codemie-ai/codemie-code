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

/** Input fields that carry an issue key rather than free text, by exact name. */
export const TICKET_KEY_FIELDS: ReadonlySet<string> = new Set(['key', 'parent', 'jql', 'inwardIssue', 'outwardIssue']);

/**
 * Key fields by naming convention, so MCP servers with different spellings are covered without a
 * list per server: `issueIdOrKey`, `issueKey`, `issueKeys` (jira_add_issues_to_sprint), `epicKey` /
 * `parentKey` (jira_create_issue), `issue_key`, `issue_keys`, `epic_key`, `inward_issue_key`,
 * `issue_ids_or_keys`. `projectKey` is not one: a project key carries no issue number.
 */
const TICKET_KEY_FIELD_PATTERN = /^(issue|epic|parent|inward|outward)\w*keys?$/i;

/** Whether a tool-input field carries issue keys. */
export function isTicketKeyField(name: string): boolean {
  return TICKET_KEY_FIELDS.has(name) || TICKET_KEY_FIELD_PATTERN.test(name);
}

/** Longest field value scanned, so a pasted log inside a JQL string cannot stall the report. */
const MAX_VALUE_CHARS = 64 * 1024;

/** Ids taken from one tool call (all fields together), before the per-session cap is applied. */
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

/** A quoted JQL string, honouring backslash escapes (`"say \\"hi\\""`, `'it\\'s'`). */
const JQL_STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;

/** The value of a JQL clause on an issue-key field: one key, quoted or not, or an `in (…)` list. */
const JQL_KEY_FIELD_NAMES = String.raw`\b(?:key|id|issue|issuekey|parent|parentEpic)\b|"epic link"|'epic link'`;
const JQL_KEY_CLAUSE = new RegExp(String.raw`(?:${JQL_KEY_FIELD_NAMES})\s*(?:!?=|(?:not\s+)?in\b)\s*(\([^)]*\)|${JQL_STRING}|[A-Za-z0-9_-]+)`, 'gi');

/** Text-search values (`summary ~ "…"`, `text !~ '…'`, unquoted `summary ~ UTF-8`): free text, never read. */
const JQL_TEXT_SEARCH = new RegExp(String.raw`!?~\s*(?:${JQL_STRING}|[^\s()]+)`, 'g');

/** Arguments of JQL functions that take issue keys (`issue in linkedIssues(abc-7)`); any case, like Jira. */
const JQL_ISSUE_FUNCTION = /\b(?:linkedIssues|parentEpic|childIssuesOf|portfolioChildIssuesOf|issuesWithRemoteLinksByGlobalId|epicsOf)\s*\(([^)]*)\)/gi;

/**
 * A JQL condition on any field: `field operator value`. Used to drop the conditions on fields that
 * do not hold issue keys (`fixVersion = "APP-2"`, `labels in (gpt-4)`, `sprint = OPS-3`) before the
 * last, case-sensitive pass, which would otherwise read their values as ids.
 */
const JQL_CONDITION = new RegExp(
  String.raw`(?:\b[A-Za-z_][\w.]*|"[^"]+")\s*(?:!?=|!?~|>=|<=|>|<|(?:not\s+)?in\b|is(?:\s+not)?\b|was(?:\s+not)?(?:\s+in)?\b|changed\b)\s*(?:\([^)]*\)|${JQL_STRING}|[^\s()]+)`,
  'gi'
);
/** Conditions on fields holding issue keys: `key` and its alias `id`, `issue`, `parent`, `"Epic Link"`. */
const JQL_KEY_FIELD = /^(?:(?:key|id|issue|issuekey|parent|parentEpic)|"epic link"|'epic link')\s/i;

function jqlIds(text: string): string[] {
  const ids = new Set<string>();
  // Every pass reads the query with its text-search values removed: words searched for
  // (`summary ~ "UTF-8 crash"`) are free text, whichever case they are in.
  const query = text.replace(JQL_TEXT_SEARCH, ' ');
  for (const pattern of [JQL_KEY_CLAUSE, JQL_ISSUE_FUNCTION]) {
    for (const clause of query.matchAll(pattern)) {
      for (const id of extractTicketMentions(clause[1], MAX_IDS_PER_CALL)) ids.add(id);
    }
  }
  // Last, upper-case ids anywhere else in the query — but not in conditions on other fields.
  const rest = query.replace(JQL_CONDITION, (condition) => (JQL_KEY_FIELD.test(`${condition} `) ? condition : ' '));
  for (const id of rest.match(new RegExp(TICKET_RE.source, TICKET_RE.flags.replace('i', ''))) ?? []) ids.add(id);
  return [...ids].slice(0, MAX_IDS_PER_CALL);
}

/**
 * Fields whose string value may be JSON-encoded structure (`additional_fields: '{"parent":"X-1"}'`
 * on jira_create_issue). Only these are decoded: JSON pasted into free text — an API response in a
 * `comment` or `description` — is still free text and is never read.
 */
const STRUCTURAL_JSON_FIELD = /^(?:additional_?fields|fields|update)$/i;

/** A string holding a JSON object or array, parsed; else undefined. */
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
 * encoded in a structural field (`additional_fields`, `fields`, `update`) is walked too. Every
 * other string — free text, including JSON pasted into it — is ignored.
 */
export function ticketsFromToolInput(input: unknown, isKeyField: (name: string) => boolean = isTicketKeyField): string[] {
  const found = new Set<string>();
  const scan = (text: string, field: string): void => {
    const value = text.slice(0, MAX_VALUE_CHARS);
    const ids = QUERY_FIELDS.has(field) ? jqlIds(value) : extractTicketMentions(value, MAX_IDS_PER_CALL);
    for (const id of ids) found.add(id);
  };
  /** `field` is the name of the field holding `value` (null at the top level). */
  const walk = (value: unknown, depth: number, field: string | null): void => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (field !== null && isKeyField(field)) scan(value, field);
      else if (field !== null && STRUCTURAL_JSON_FIELD.test(field)) {
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
    for (const [key, item] of Object.entries(value)) walk(item, depth + 1, key);
  };
  walk(input, 0, null);
  return [...found].slice(0, MAX_IDS_PER_CALL);
}
