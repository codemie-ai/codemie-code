/**
 * Sanitizers for optional wrapper-known metric values.
 *
 * Strict goals:
 * - strip user:pass credentials from URLs
 * - normalize the user's home directory to `~/...`
 * - strip control characters
 * - cap string length and list size
 *
 * Non-goals:
 * - classifying source as GitHub/GitLab/internal/public
 * - resolving aliases or catalog metadata
 */

import os from 'node:os';

const MAX_SOURCE_LENGTH = 256;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function sanitizeSource(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let cleaned = stripCredentials(trimmed);
  cleaned = normalizeHome(cleaned);
  cleaned = stripControlChars(cleaned);
  cleaned = capLength(cleaned, MAX_SOURCE_LENGTH);

  return cleaned.length > 0 ? cleaned : undefined;
}

export function capList(values: readonly string[] | undefined, max: number = MAX_LIST_ITEMS): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const cleaned = values
    .map((value) => stripControlChars(value).trim())
    .filter((value) => value.length > 0)
    .map((value) => capLength(value, MAX_LIST_ITEM_LENGTH));

  if (cleaned.length === 0) {
    return undefined;
  }

  return cleaned.slice(0, max);
}

function stripCredentials(value: string): string {
  // Match scheme://user:pass@host or scheme://user@host and remove the user info
  return value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+@)/, '$1');
}

function normalizeHome(value: string): string {
  const home = os.homedir();
  if (!home) {
    return value;
  }
  if (value === home) {
    return '~';
  }
  if (value.startsWith(`${home}/`) || value.startsWith(`${home}\\`)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

function capLength(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
