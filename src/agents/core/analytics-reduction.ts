/**
 * Analytics reduction core (EPMCDME-17748).
 *
 * Daemon-safe leaf module: allowlist-based reduction of analytics records. Anything not on a
 * keep-list is replaced by an unbracketed `REDACTED:<KIND>` placeholder, so a field added in
 * the future is redacted by default.
 */
import { logger } from '@/utils/logger.js';
import { TICKET_RE, extractTicketMentions, findMrRefs, findTicketRefs } from './ticket-parser.js';
import { autoPromptMarker, resolveCommandFields } from './prompt-grammar.js';

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

/** Generic long-lived branch names: they identify no client or project, so they are sent as they are. */
export const SHARED_BRANCH_NAMES: ReadonlySet<string> = new Set([
  'main', 'master', 'develop', 'dev', 'qa', 'test', 'testing', 'perf', 'stage', 'staging', 'prod'
]);

/**
 * A shared branch name exactly (case-insensitive, no prefix like `feature/`), else the ticket keys found in the
 * branch name (as written, de-duplicated, space-joined), else `REDACTED:BRANCH`.
 */
function reduceBranchUnsafe(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  if (SHARED_BRANCH_NAMES.has(branch.trim().toLowerCase())) {
    return branch;
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

/** Longest reduced prompt, in characters. */
const MAX_REDUCED_PROMPT = 200;

export interface ReducePromptOptions {
  /** Command name (no slash) the adapter already derived; when omitted it is parsed from the prompt. */
  commandName?: string;
  /** Auto-prompt marker the adapter already derived; when omitted it is detected in the prompt. */
  autoMarker?: string;
}

/**
 * The only parts of a raw prompt analytics keeps: the auto marker alone, or the command name plus
 * the ticket and MR refs found in the whole prompt, or the refs alone, or `REDACTED:PROMPT`.
 * Runs on the raw text so a ref past any later length cut survives; output is at most 200 characters.
 */
function reducePromptUnsafe(raw: string, opts: ReducePromptOptions = {}): string {
  const marker = opts.autoMarker || autoPromptMarker(raw);
  if (marker) {
    return marker.slice(0, MAX_REDUCED_PROMPT);
  }
  // `commandName: ''` means the adapter looked and found no command: do not re-derive one from the first word
  // (a path such as `/tmp is full` is not a command). Only an absent value parses the text itself.
  const command = opts.commandName !== undefined ? opts.commandName : resolveCommandFields(raw).command_name;
  const parts: string[] = command ? [`/${command}`] : [];
  const seen = new Set<string>();
  for (const ref of [...findTicketRefs(raw), ...findMrRefs(raw)]) {
    const key = ref.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      parts.push(ref);
    }
  }
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const next = length + (kept.length > 0 ? 1 : 0) + part.length;
    if (next > MAX_REDUCED_PROMPT) {
      break;
    }
    kept.push(part);
    length = next;
  }
  if (kept.length === 0 && parts.length > 0) {
    return parts[0].slice(0, MAX_REDUCED_PROMPT);
  }
  return kept.length > 0 ? kept.join(' ') : placeholder('prompt');
}

/** Ticket keys found in a branch name, or `REDACTED:BRANCH`. Never throws: a failure becomes `REDACTED:FAILED`. */
export function reduceBranch(branch: string | undefined): string | undefined {
  try {
    return reduceBranchUnsafe(branch);
  } catch (err) {
    logger.debug(`[analytics-reduction] failed to reduce branch: ${err instanceof Error ? err.name : 'UnknownError'}`);
    return FAILED;
  }
}

/** Reduced prompt text. Never throws: a failure becomes `REDACTED:FAILED`. */
export function reducePrompt(raw: string, opts: ReducePromptOptions = {}): string {
  try {
    return reducePromptUnsafe(raw, opts);
  } catch (err) {
    logger.debug(`[analytics-reduction] failed to reduce prompt: ${err instanceof Error ? err.name : 'UnknownError'}`);
    return FAILED;
  }
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
    return reduceKept(key, value);
  }
  if (Array.isArray(value)) {
    return [placeholder(key)];
  }
  // strings, objects and any other type carry potential content
  return placeholder(key);
}

/** Single-token identifier (tool, model, id): the only free-form string allowed inside a kept container. */
const NESTED_IDENTIFIER_RE = /^[A-Za-z0-9_.:@/+-]{1,128}$/;

/**
 * A kept key keeps its string verbatim. A container (array/object) under a kept key keeps scalars and
 * identifier-like strings only; any other nested string is replaced, so free text cannot ride along.
 */
function reduceKept(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    return value;
  }
  return reduceNested(key, value);
}

function reduceNested(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return NESTED_IDENTIFIER_RE.test(value) ? value : placeholder(key);
  }
  if (Array.isArray(value)) {
    return value.map((item) => reduceNested(key, item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const entryKey of Object.keys(value)) {
      out[entryKey] = reduceNested(entryKey, value[entryKey]);
    }
    return out;
  }
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
