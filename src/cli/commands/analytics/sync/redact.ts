/**
 * Secret redaction helpers for `codemie analytics sync`.
 *
 * Webhook URLs carry a signed query parameter (`sig=`) that must never reach
 * logs, error messages, or console output. These helpers strip that value
 * out of arbitrary text and build safe error messages from unknown errors,
 * including chained `cause` errors.
 */

const MAX_CAUSE_DEPTH = 10;

/**
 * Replace every `sig=<value>` query value in any URL found in `text` with
 * `sig=REDACTED`. Other query parameters are left untouched.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\bsig=[^&\s"'<>)]+/g, 'sig=REDACTED');
}

/**
 * Build a human-readable message from an unknown thrown value, walking the
 * `cause` chain (when present) and joining each message. Non-Error values
 * are stringified. The result is redacted before being returned.
 */
export function errorMessage(err: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();

  let current: unknown = err;
  let depth = 0;

  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      current = undefined;
    }

    depth += 1;
  }

  const joined = messages.length > 0 ? messages.join(': ') : String(err);
  return redactSecrets(joined);
}
