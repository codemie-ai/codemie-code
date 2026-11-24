/**
 * Analytics reduction core (EPMCDME-17748).
 *
 * Daemon-safe leaf module: allowlist-based reduction of analytics records. Anything not on a
 * keep-list is replaced by an unbracketed `REDACTED:<KIND>` placeholder, so a field added in
 * the future is redacted by default.
 */
import { logger } from '@/utils/logger.js';
import { TICKET_RE, extractTicketMentions } from './ticket-parser.js';

export interface KeepList {
  readonly keep: ReadonlySet<string>;
  readonly nested?: Readonly<Record<string, KeepList>>;
}

const FAILED = 'REDACTED:FAILED';
const MAX_BRANCH_TICKETS = 20;

/** `gitBranch` / `error_messages` -> `REDACTED:GIT-BRANCH` / `REDACTED:ERROR-MESSAGES`. */
export const placeholder = (kind: string): string =>
  `REDACTED:${kind
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toUpperCase()}`;

/** Ticket keys found in a branch name (as written, de-duplicated, space-joined) or `REDACTED:BRANCH`. */
export function reduceBranch(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  const accepted = new Set(extractTicketMentions(branch, MAX_BRANCH_TICKETS, { source: 'branch' }));
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of branch.matchAll(new RegExp(TICKET_RE.source, TICKET_RE.flags))) {
    const upper = match[0].toUpperCase();
    if (accepted.has(upper) && !seen.has(upper)) {
      seen.add(upper);
      keys.push(match[0]);
    }
  }
  return keys.length > 0 ? keys.join(' ') : placeholder('branch');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function reduceValue(key: string, value: unknown, keepList: KeepList): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  const nested = keepList.nested?.[key];
  if (nested && isPlainObject(value)) {
    return reduceRecord(value, nested);
  }
  if (keepList.keep.has(key)) {
    return value;
  }
  if (Array.isArray(value)) {
    return [placeholder(key)];
  }
  // strings, objects and any other type carry potential content
  return placeholder(key);
}

/** Reduce one record against its keep-list. Never throws; a failing field becomes `REDACTED:FAILED`. */
export function reduceRecord<T extends Record<string, unknown>>(record: T, keepList: KeepList): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    try {
      out[key] = reduceValue(key, record[key], keepList);
    } catch (err) {
      out[key] = FAILED;
      logger.debug(
        `[analytics-reduction] failed to reduce field "${key}": ${err instanceof Error ? err.name : 'UnknownError'}`
      );
    }
  }
  return out as T;
}
