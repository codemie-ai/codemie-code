/**
 * Shared guard for CodeMie API list responses.
 *
 * A stale SSO session can get silently redirected server-side to the Keycloak
 * login page instead of erroring — the SDK client then hands back the page's
 * HTML as the "response" rather than throwing. Without a shape check, callers
 * crash on `response.<field>` reads with a cryptic "Cannot read properties of
 * undefined" instead of telling the user to re-authenticate.
 */

import { ConfigurationError } from '@/utils/errors.js';

function looksLikeStaleSessionRedirect(response: unknown): boolean {
  return typeof response === 'string' && /keycloak|<!doctype html|<html/i.test(response);
}

/**
 * Asserts an API list response matches the expected shape, narrowing `response`
 * to `T` on success. Throws a `ConfigurationError` pointing at
 * `codemie profile login` on a stale-session redirect, or a generic
 * "unexpected response" error otherwise.
 *
 * @param isValidShape - type guard for the expected response shape
 * @param context - human-readable description of what was being fetched, e.g. "project assistants"
 */
export function assertApiListResponse<T>(
  response: unknown,
  isValidShape: (response: unknown) => response is T,
  context: string
): asserts response is T {
  if (isValidShape(response)) {
    return;
  }

  throw new ConfigurationError(
    looksLikeStaleSessionRedirect(response)
      ? 'Your CodeMie session has expired. Run `codemie profile login` to re-authenticate, then try again.'
      : `Unexpected response fetching ${context} — the CodeMie API did not return the expected data. Run \`codemie profile login\` to refresh your session and try again.`
  );
}
