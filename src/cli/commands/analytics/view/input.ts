/**
 * What `codemie analytics view` reads: an export file and the filter flags. Every problem is a
 * {@link ViewInputError} whose message is one line a user can act on.
 */

import { readFileSync } from 'node:fs';
import { CodeMieError } from '@/utils/errors.js';
import { parseFilterDate } from '@/utils/date-filter.js';
import { parseDuration } from '../date-args.js';
import type { ReportPayload, ReportSessionRecord } from '../report/types.js';
import type { ViewFilter } from './types.js';

export class ViewInputError extends CodeMieError {
  constructor(message: string) {
    super(message);
    this.name = 'ViewInputError';
  }
}

function isExport(data: unknown): data is ReportPayload {
  if (typeof data !== 'object' || data === null) return false;
  const { meta, sessions } = data as { meta?: unknown; sessions?: unknown };
  return (
    typeof meta === 'object' && meta !== null &&
    Array.isArray(sessions) &&
    sessions.every((s) => typeof s === 'object' && s !== null && typeof (s as { sessionId?: unknown }).sessionId === 'string')
  );
}

/**
 * Reads a `codemie analytics --export json` file (or several merged into one). When two rows
 * share a `sessionId`, the later one wins: it is the newer capture of that session.
 */
export function readExportFile(path: string): ReportPayload {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ViewInputError(`Cannot read ${path}: ${code === 'ENOENT' ? 'file not found' : (error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ViewInputError(`${path} is not an analytics export: it is not JSON`);
  }
  if (!isExport(data)) {
    throw new ViewInputError(`${path} is not an analytics export: expected the {meta, sessions} of codemie analytics --export json`);
  }
  const bySessionId = new Map<string, ReportSessionRecord>();
  for (const session of data.sessions) {
    bySessionId.set(session.sessionId, session);
  }
  return { meta: data.meta, sessions: [...bySessionId.values()] };
}

/**
 * `YYYY-MM-DD` keeps the CLI's UTC-day meaning (`to` is the day's last ms); a timestamp with a
 * time (`2026-11-19T00:00:00+02:00`) is used exactly.
 */
export function parseViewDate(value: string, edge: 'from' | 'to'): number {
  const date = parseFilterDate(value, edge);
  if (!date) {
    throw new ViewInputError(`Invalid --${edge} date "${value}" — use YYYY-MM-DD (a UTC day) or an ISO timestamp`);
  }
  return date.getTime();
}

export interface ViewFilterOptions {
  from?: string;
  to?: string;
  last?: string;
  agent?: string;
  project?: string;
  branch?: string;
}

/** The filter flags as a {@link ViewFilter}. `--last` wins over `--from`/`--to`, as in `codemie analytics`. */
export function viewFilterFrom(options: ViewFilterOptions, now: number): ViewFilter {
  const filter: ViewFilter = {};
  if (options.from) filter.from = parseViewDate(options.from, 'from');
  if (options.to) filter.to = parseViewDate(options.to, 'to');
  if (options.last) {
    const duration = parseDuration(options.last);
    if (!duration) {
      throw new ViewInputError(`Invalid --last duration "${options.last}" — use a number and a unit, e.g. 7d, 24h, 30m`);
    }
    filter.from = now - duration;
    filter.to = now;
  }
  if (options.agent) filter.agent = options.agent;
  if (options.project) filter.project = options.project;
  if (options.branch) filter.branch = options.branch;
  return filter;
}
