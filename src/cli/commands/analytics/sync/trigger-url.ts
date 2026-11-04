/**
 * The trigger-URL rule (spec.md "Trigger-URL rule"): one validator for a Power Automate
 * flow trigger URL, shared by `codemie analytics sync bootstrap`'s guided step 5, its
 * `--webhook` non-interactive mode and saved-webhook reuse.
 */

import { SyncConfigError } from '@/utils/errors.js';

import { assertPrintableValue } from './install-command.js';
import { redactSecrets } from './redact.js';

/** Which rule a raw (un-parsed) trigger URL fails, checked in this priority order: a line
 * break first (the most common paste artifact), then other whitespace, then an ASCII
 * control character or DEL, then any non-ASCII character (U+0080 and up — this also covers
 * typographic quotes a paste may have substituted for `"`). `null` when `input` has none of
 * these. Checked against the raw pasted input, before `new URL` can normalise any of it
 * away. */
type RawTriggerUrlIssue = 'line-break' | 'whitespace' | 'control' | 'non-ascii';

function findRawTriggerUrlIssue(input: string): RawTriggerUrlIssue | null {
  for (const char of input) {
    if (char === '\n' || char === '\r') {
      return 'line-break';
    }
    if (/\s/.test(char)) {
      return 'whitespace';
    }
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return 'control';
    }
    if (code >= 0x80) {
      return 'non-ascii';
    }
  }
  return null;
}

/** `'option'`-mode reason, one per {@link RawTriggerUrlIssue}: always names `--webhook`. */
const RAW_TRIGGER_URL_OPTION_REASON: Record<RawTriggerUrlIssue, string> = {
  'line-break': '--webhook must not contain a line break',
  whitespace: '--webhook must not contain whitespace',
  control: '--webhook must not contain a control character',
  'non-ascii': '--webhook contains a non-ASCII character such as a typographic quote (“ ” ‘ ’)'
};

/** `'guided'`-mode reason, one per {@link RawTriggerUrlIssue}: never names a flag or echoes
 * the URL. Combined with {@link TRIGGER_URL_COPY_HINT} by {@link guidedTriggerUrlMessage}. */
const RAW_TRIGGER_URL_GUIDED_REASON: Record<RawTriggerUrlIssue, string> = {
  'line-break': 'That trigger URL has a line break in it.',
  whitespace: 'That trigger URL has whitespace in it.',
  control: 'That trigger URL has a control character in it.',
  'non-ascii':
    'That trigger URL contains a non-ASCII character such as a typographic quote (“ ” ‘ ’).'
};

/** What a bootstrap lead is told to do in guided mode, for every check in
 * {@link validateTriggerUrl} — combined with a cause-specific reason by
 * {@link guidedTriggerUrlMessage}. It never echoes the pasted URL or names a flag. */
const TRIGGER_URL_COPY_HINT =
  'Copy the full HTTP POST URL shown on the flow\'s "When a Teams webhook request is received" trigger, and paste the whole thing.';

/** Combines a cause-specific `reason` sentence with {@link TRIGGER_URL_COPY_HINT}. */
function guidedTriggerUrlMessage(reason: string): string {
  return `${reason} ${TRIGGER_URL_COPY_HINT}`;
}

/**
 * Validates and normalises a Power Automate flow trigger URL: the bootstrap wizard's step 5,
 * `--webhook` in non-interactive mode, and saved-webhook reuse all call this on the same
 * rule (spec.md "Trigger-URL rule").
 *
 * Checks, in order:
 * 1. `input` as given must contain no whitespace, line break, control character or
 *    non-ASCII character.
 * 2. `input` must parse with `new URL`.
 * 3. The parsed URL must use `https:` and carry a `sig` query parameter.
 * 4. The normalised `href` must pass {@link assertPrintableValue}.
 *
 * Returns the normalised `href` (`new URL(input).href`) — the value that is saved and
 * printed. In `'option'` mode every error names `--webhook`, and the reason is specific to
 * the check that failed (e.g. a line break vs. a non-ASCII/typographic-quote character). In
 * `'guided'` mode no error echoes the URL or names a flag; every error states that same
 * specific reason and says to copy the full trigger URL again.
 */
export function validateTriggerUrl(input: string, mode: 'option' | 'guided'): string {
  const fail = (optionMessage: string, guidedReason: string): never => {
    throw new SyncConfigError(mode === 'guided' ? guidedTriggerUrlMessage(guidedReason) : optionMessage);
  };

  const rawIssue = findRawTriggerUrlIssue(input);
  if (rawIssue !== null) {
    fail(
      `${RAW_TRIGGER_URL_OPTION_REASON[rawIssue]}: ${redactSecrets(input)}`,
      RAW_TRIGGER_URL_GUIDED_REASON[rawIssue]
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new SyncConfigError(
      mode === 'guided'
        ? guidedTriggerUrlMessage('That is not a valid URL.')
        : `Invalid --webhook URL: ${redactSecrets(input)}`
    );
  }

  if (parsed.protocol !== 'https:') {
    fail(`--webhook must use https: ${redactSecrets(parsed.href)}`, 'That trigger URL must start with https://.');
  }

  if (parsed.searchParams.get('sig') === null || parsed.searchParams.get('sig') === '') {
    fail(
      `--webhook has no "sig" parameter: ${redactSecrets(parsed.href)}`,
      'That trigger URL is missing its signature parameter.'
    );
  }

  const href = parsed.href;

  try {
    assertPrintableValue('--webhook', href);
  } catch (err) {
    if (mode === 'guided') {
      throw new SyncConfigError(
        guidedTriggerUrlMessage('That trigger URL has a character in it that is not safe to reuse in a command.')
      );
    }
    throw err;
  }

  return href;
}
