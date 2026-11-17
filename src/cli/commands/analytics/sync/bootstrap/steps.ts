/**
 * Shared sequence metadata for `codemie analytics sync bootstrap`'s guided wizard
 * (spec.md "Guided mode"): the 8 step titles, in order, and the "Step N of 8 · <title>"
 * heading each step prints exactly once — even when the step itself retries an invalid
 * answer.
 *
 * `./guided.ts` owns the actual step logic (steps 1-4 from plan task 7, steps 5-8 from
 * plan task 8); both halves number themselves off this one list, ported from the
 * standalone collector's `src/wizard.js` (`STEPS`, `heading`).
 */

/** The step titles, in order; `stepHeading`'s index is 0-based into this list. */
export const STEPS = [
  'Teams channel',
  'SharePoint folder',
  'Time zone',
  'Import the flow',
  'Trigger URL',
  'External sessions',
  'Lookback',
  'Developers'
] as const;

/**
 * `"Step N of 8 · <title>"` for the step at `index` (0-based: 0 is "Teams channel").
 *
 * Callers print this once per step, from the main sequence, before that step's own
 * ask/retry loop starts — never from inside the loop, so a rejected or invalid answer
 * does not reprint it.
 */
export function stepHeading(index: number): string {
  return `Step ${index + 1} of ${STEPS.length} · ${STEPS[index]}`;
}
