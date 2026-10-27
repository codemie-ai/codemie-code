/**
 * Turns per-session evidence into the report's `tickets` field. Pure.
 *
 * Prompt ids are the noisy source: `TICKET_RE` is case-insensitive, so free text matches
 * `gpt-4`, `utf-8`, `node-18`. Two rules keep them honest instead of a denylist:
 *  - prompts are matched case-sensitively (an upper-case project prefix is required);
 *  - a prompt id is kept only if its project prefix also appears in a tool or branch id
 *    somewhere in the same report ("corroboration").
 */

import { TICKET_RE, extractTicketMentions } from '@/agents/core/ticket-parser.js';
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

/** Prompt ids: the shared pattern without its `i` flag, so the project prefix must be upper case. */
function promptTicketIds(text: string): string[] {
  const matches = text.match(new RegExp(TICKET_RE.source, TICKET_RE.flags.replace('i', ''))) ?? [];
  return [...new Set(matches)].slice(0, MAX_IDS_PER_TEXT);
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

export function buildSessionTickets(
  evidence: ReadonlyMap<string, SessionEvidence>,
  sources: ReadonlySet<TicketSource>
): Map<string, SessionTicket[]> {
  const perSession = new Map<string, { tool: Map<string, number>; branch: Map<string, number>; prompt: Map<string, number> }>();
  const corroborated = new Set<string>();

  for (const [sessionId, e] of evidence) {
    const tool = sources.has('tool') ? e.tool : new Map<string, number>();
    const branch = sources.has('branch') ? countByText(e.branches, (b) => extractTicketMentions(b, MAX_IDS_PER_TEXT)) : new Map<string, number>();
    const prompt = sources.has('prompt') ? countByText(e.prompts, promptTicketIds) : new Map<string, number>();
    for (const id of [...tool.keys(), ...branch.keys()]) corroborated.add(prefixOf(id));
    perSession.set(sessionId, { tool, branch, prompt });
  }

  const result = new Map<string, SessionTicket[]>();
  for (const [sessionId, { tool, branch, prompt }] of perSession) {
    const byId = new Map<string, SessionTicket>();
    const add = (source: TicketSource, counts: Map<string, number>): void => {
      for (const [id, count] of counts) {
        const ticket = byId.get(id) ?? { id, sources: {} };
        ticket.sources[source] = count;
        byId.set(id, ticket);
      }
    };
    add('tool', tool);
    add('branch', branch);
    add('prompt', new Map([...prompt].filter(([id]) => corroborated.has(prefixOf(id)))));
    if (byId.size === 0) continue;

    // Keep the most-evidenced ids when over the cap, then order by id for stable output.
    const tickets = [...byId.values()]
      .sort((a, b) => total(b) - total(a) || a.id.localeCompare(b.id))
      .slice(0, MAX_TICKETS_PER_SESSION)
      .sort((a, b) => a.id.localeCompare(b.id));
    result.set(sessionId, tickets);
  }
  return result;
}
