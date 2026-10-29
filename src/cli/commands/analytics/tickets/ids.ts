/**
 * The one rule for what counts as a ticket id in any text this module reads — tool-input key
 * fields, JQL, branch names, prompts.
 *
 * An id is a `TICKET_RE` match whose number does not run on into a letter, or into `.` plus a
 * letter or digit: `lodash-4.17`, `node-20.x`, `ABC-7.1` (a version) and `bug-011CUabc`, `ABC-6x`
 * (a suffix) are not tickets. A full stop ending a sentence is fine: `Fix ABC-22.` and
 * `ABC-22. Next` keep `ABC-22`.
 */

import { TICKET_RE } from '@/agents/core/ticket-parser.js';

const RUNS_ON = /^(?:[A-Za-z]|\.[A-Za-z0-9])/;

/** `TICKET_RE`'s own flags: any case. */
export const ANY_CASE = TICKET_RE.flags;
/** Without the `i` flag: the project key must be upper case. */
export const UPPER_CASE = TICKET_RE.flags.replace('i', '');

/** Distinct standalone ids in `text`, upper-cased, first-seen order, at most `limit`. */
export function standaloneIds(text: string, flags: string, limit: number): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(new RegExp(TICKET_RE.source, flags))) {
    const end = match.index + match[0].length;
    if (RUNS_ON.test(text.slice(end, end + 2))) continue;
    ids.add(match[0].toUpperCase());
    if (ids.size >= limit) break;
  }
  return [...ids];
}
