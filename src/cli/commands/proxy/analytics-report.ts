import chalk from 'chalk';

/** One row of a report: a message, optional list items under it and an optional hint. */
export interface ReportRow {
  message: string;
  /** Listed one per line, indented under the message. */
  items?: string[];
  /** Printed on its own line under the row, e.g. the command the user can run. */
  hint?: string;
}

/** Row indent of a named section; rows without a heading start at the left edge. */
const SECTION_INDENT = 2;

/**
 * White rows with no icons (a row's message may carry its own colored text), each at `indent` spaces.
 * Items sit 2 spaces further in, under their row, and the hint 4 spaces further in, under its items.
 */
export function formatReportRows(rows: ReportRow[], indent = 0): string[] {
  const pad = (extra: number): string => ' '.repeat(indent + extra);
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(chalk.white(`${pad(0)}${row.message}`));
    for (const item of row.items ?? []) {
      lines.push(chalk.white(`${pad(2)}${item}`));
    }
    if (row.hint) {
      lines.push(chalk.white(`${pad(4)}${row.hint}`));
    }
  }
  return lines;
}

/**
 * A named section of `proxy analytics status`: the heading in bold, then its rows indented by 2 spaces;
 * the footer follows after an empty line, dimmed.
 */
export function formatReportSection(name: string, rows: ReportRow[], footer?: string): string[] {
  const lines = [chalk.bold(`${name}:`), ...formatReportRows(rows, SECTION_INDENT)];
  if (footer) {
    lines.push('', chalk.dim(`${' '.repeat(SECTION_INDENT)}${footer}`));
  }
  return lines;
}
