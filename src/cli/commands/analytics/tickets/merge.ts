/**
 * Turns per-session evidence into the report's `tickets` field. Pure.
 *
 * Tool-call ids are the ground truth: an agent passed that key to the issue tracker. Branch names
 * and prompts are free text, where a ticket-shaped string is often something else — a library
 * version in a branch (`react-17`, `modal-19`), a model or encoding in a prompt (`GPT-4`, `UTF-8`).
 * So a branch or prompt id is kept only when its project key (`CAKE` in `CAKE-807`) also appears
 * in a tool-call id somewhere in the same report. Report-wide rather than per session: a session
 * often works on its ticket's branch without calling the tracker itself. Tool evidence counts for
 * this even when the `tool` source is not requested — it is just not emitted then.
 *
 * Prompts are also matched case-sensitively (an upper-case project key is required).
 */

import { TICKET_RE } from '@/agents/core/ticket-parser.js';
import type { SessionTicket } from '../report/types.js';

export type TicketSource = 'tool' | 'branch' | 'prompt';

/** What the collector gathered for one session; text never leaves this module. */
export interface SessionEvidence {
  /** Ticket id -> number of matching tool calls. */
  tool: Map<string, number>;
  /** Distinct branch names the session touched. */
  branches: Set<string>;
  /** Distinct user prompt texts. */
  prompts: Set<string>;
}

/** Upper bound per session, matching ticket-parser's `MAX_TICKET_MENTIONS`. */
export const MAX_TICKETS_PER_SESSION = 20;

/** Ids per branch name or prompt; generous, the per-session cap is the real bound. */
const MAX_IDS_PER_TEXT = 20;

/** Ticket ids in natural order, so `BIG-2` sorts before `BIG-10`. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Ids in free text whose number does not run on into a `.` or a letter: `lodash-4.17`, `node-20.x`,
 * `ABC-7.1` (a version) and `bug-011CUabc`, `ABC-6x` (a suffix) are not tickets.
 */
function standaloneIds(text: string, flags: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(new RegExp(TICKET_RE.source, flags))) {
    if (/[.A-Za-z]/.test(text[match.index + match[0].length] ?? '')) continue;
    ids.add(match[0].toUpperCase());
    if (ids.size >= MAX_IDS_PER_TEXT) break;
  }
  return [...ids];
}

/** Prompt ids: case-sensitive (the project key must be upper case), standalone like branch ids. */
function promptTicketIds(text: string): string[] {
  return standaloneIds(text, TICKET_RE.flags.replace('i', ''));
}

/** Branches bots create for dependency bumps: `dependabot/npm_and_yarn/lodash-4.17.21`, `renovate/node-20.x`. */
const BOT_BRANCH = /^(dependabot|renovate)\//i;

/**
 * Branch ids: matched case-insensitively (branches are usually lower case), except on bot
 * dependency branches, and never when the number runs on into a `.` or a letter — a version
 * (`lodash-4.17`, `node-20.x`) or a generated suffix (`claude/fix-login-bug-011CUabc`,
 * `hotfix/abc-12x`). A real id in a branch ends at `-`, `_`, `/` or the end of the name.
 */
function branchTicketIds(branch: string): string[] {
  return BOT_BRANCH.test(branch) ? [] : standaloneIds(branch, TICKET_RE.flags);
}

function prefixOf(id: string): string {
  return id.slice(0, id.lastIndexOf('-'));
}

/** id -> number of texts (branches or prompts) that mention it. */
function countByText(texts: Iterable<string>, idsOf: (text: string) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const id of idsOf(text)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function total(ticket: SessionTicket): number {
  return (ticket.sources.tool ?? 0) + (ticket.sources.branch ?? 0) + (ticket.sources.prompt ?? 0);
}

/** Per-session tickets, plus the sessions whose list was cut at {@link MAX_TICKETS_PER_SESSION}. */
export interface TicketReport {
  tickets: Map<string, SessionTicket[]>;
  truncated: Set<string>;
}

export function buildSessionTickets(
  evidence: ReadonlyMap<string, SessionEvidence>,
  sources: ReadonlySet<TicketSource>
): Map<string, SessionTicket[]> {
  return buildTicketReport(evidence, sources).tickets;
}

export function buildTicketReport(
  evidence: ReadonlyMap<string, SessionEvidence>,
  sources: ReadonlySet<TicketSource>
): TicketReport {
  const perSession = new Map<string, { tool: Map<string, number>; branch: Map<string, number>; prompt: Map<string, number> }>();
  /** Project keys seen in tool-call ids anywhere in the report. */
  const confirmedKeys = new Set<string>();

  for (const [sessionId, e] of evidence) {
    const tool = e.tool;
    const branch = countByText(e.branches, branchTicketIds);
    for (const id of tool.keys()) confirmedKeys.add(prefixOf(id));
    const empty = new Map<string, number>();
    perSession.set(sessionId, {
      tool: sources.has('tool') ? tool : empty,
      branch: sources.has('branch') ? branch : empty,
      prompt: sources.has('prompt') ? countByText(e.prompts, promptTicketIds) : empty,
    });
  }

  const result = new Map<string, SessionTicket[]>();
  const truncated = new Set<string>();
  for (const [sessionId, { tool, branch, prompt }] of perSession) {
    const byId = new Map<string, SessionTicket>();
    const add = (source: TicketSource, counts: Map<string, number>): void => {
      for (const [id, count] of counts) {
        const ticket = byId.get(id) ?? { id, sources: {} };
        ticket.sources[source] = count;
        byId.set(id, ticket);
      }
    };
    const confirmed = (counts: Map<string, number>): Map<string, number> =>
      new Map([...counts].filter(([id]) => confirmedKeys.has(prefixOf(id))));
    add('tool', tool);
    add('branch', confirmed(branch));
    add('prompt', confirmed(prompt));
    if (byId.size === 0) continue;

    // Keep the most-evidenced ids when over the cap, then order by id for stable output.
    const tickets = [...byId.values()]
      .sort((a, b) => total(b) - total(a) || compareIds(a.id, b.id))
      .slice(0, MAX_TICKETS_PER_SESSION)
      .sort((a, b) => compareIds(a.id, b.id));
    result.set(sessionId, tickets);
    if (byId.size > MAX_TICKETS_PER_SESSION) truncated.add(sessionId);
  }
  return { tickets: result, truncated };
}
