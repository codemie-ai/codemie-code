/**
 * Opt-in obfuscation of analytics text: the one entry for masking free text before it leaves the CLI.
 *
 * Leaf module (imports only `security.ts`, `long-text-masking.ts` and the dependency-free
 * `ticket-parser.ts`) so the proxy daemon graph stays small. Off mode is the existing secret masking,
 * unchanged. On mode adds typed PII placeholders (`[REDACTED:EMAIL]`, ...) after secret masking.
 *
 * Contract: pure, idempotent, linear-time (every quantifier is bounded or runs over a class that
 * cannot overlap its neighbour), failure closed (an over-cap field or any thrown error yields
 * `OBFUSCATION_FAILURE_PLACEHOLDER`, never the raw text). The backend copies `OBFUSCATION_RULES_VERSION`
 * and the sample fixture, so change the version whenever any rule changes.
 */

import { maskSecretsDeep } from './security.js';
import { maskSecretsInLongText } from './long-text-masking.js';
import { TICKET_REF_RE } from '../agents/core/ticket-parser.js';
import { logger } from './logger.js';

export type ObfuscationMode = 'off' | 'on';

export interface SanitizeOptions {
  /** Longest text, in UTF-16 units, one call scans in `on` mode; a longer field becomes the failure placeholder. */
  maxInput?: number;
}

/** Version of the rule set; stamped on obfuscated events so mixed rule sets can be told apart. */
export const OBFUSCATION_RULES_VERSION = '1';

/** Replaces a field that could not be obfuscated (over the cap, or a rule threw). */
export const OBFUSCATION_FAILURE_PLACEHOLDER = '[REDACTED:FAILED]';

/**
 * Per-call input cap in `on` mode. Measured on a dev machine (Node, darwin arm64), worst case over
 * the adversarial shapes of the timing test plus mixed prose (worst shape: `1-` repeated, the phone
 * rule): 256 KB takes about 150 ms, 1 MB about 640 ms and 5 MB about 3.3 s of synchronous work.
 * 1 MB and 5 MB would stall the proxy daemon's event loop, so the cap is 256 KB. Analytics fields
 * (prompts, tool output) are bounded far below this by the field limits; the cap only catches
 * pathological bodies, which become the failure placeholder.
 */
export const DEFAULT_OBFUSCATION_MAX_INPUT = 256 * 1024;

const PLACEHOLDER_LOOKAHEAD = 24;

function failure(error: unknown): string {
  // Content-free: only the error class name is logged.
  logger.warn(`Analytics obfuscation failed; field replaced by placeholder (${error instanceof Error ? error.name : 'unknown'})`);
  return OBFUSCATION_FAILURE_PLACEHOLDER;
}

// ---------------------------------------------------------------------------------------------
// PII rules
// ---------------------------------------------------------------------------------------------

const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}(?![A-Za-z0-9-])/g;

const IBAN_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;

const CARD_RE = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;

const IPV6_RE = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;

const IPV4_RE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g;

const PHONE_RE = /(?<![\w.+/-])\+?\(?\d[\d ()./-]{6,20}\d(?!\w|[/-]\d)/g;

function ibanValid(candidate: string): boolean {
  const compact = candidate.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = value > 9 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder === 1;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Issuer ranges start with 2-6 (Amex/Visa/Mastercard/Discover/UnionPay/Diners); epoch timestamps and ids start with 1.
  if (!/^[2-6]/.test(digits)) return false;
  return luhnValid(digits);
}

function ipv6Valid(candidate: string): boolean {
  if (!/[0-9A-Fa-f]/.test(candidate)) return false;
  const doubleAt = candidate.indexOf('::');
  if (doubleAt !== candidate.lastIndexOf('::')) return false;
  if (/:::/.test(candidate)) return false;
  const groups = candidate.split(':');
  if (doubleAt < 0) return groups.length === 8 && groups.every(g => g.length >= 1);
  // "::" form: at most 7 explicit groups; the empty strings come from the "::" and the edges.
  const explicit = groups.filter(g => g.length > 0);
  return explicit.length <= 7;
}

function ipv4Valid(candidate: string): boolean {
  return candidate.split('.').every(part => Number(part) <= 255 && (part.length === 1 || part[0] !== '0'));
}

function phoneValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  const international = candidate.startsWith('+');
  if (digits.length < (international ? 8 : 10) || digits.length > 15) return false;
  // Separators other than dots are required; dot-only runs are versions and decimals.
  if (!/[ ()-]/.test(candidate) && !international) return false;
  // ISO and day-first dates.
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(candidate) || /^\d{1,2}[-./]\d{1,2}[-./]\d{4}$/.test(candidate)) return false;
  return true;
}

type Validator = (candidate: string) => boolean;

function replaceValid(text: string, re: RegExp, valid: Validator | undefined, placeholder: string): string {
  return text.replace(re, match => (valid === undefined || valid(match) ? placeholder : match));
}

// ---------------------------------------------------------------------------------------------
// Ticket protection
// ---------------------------------------------------------------------------------------------

/** First private-use character absent from the text; a sentinel pair never collides with real input. */
function pickSentinel(text: string): string | undefined {
  for (let code = 0xe000; code < 0xe010; code++) {
    const ch = String.fromCharCode(code);
    if (!text.includes(ch)) return ch;
  }
  return undefined;
}

function applyPii(text: string): string {
  let out = replaceValid(text, EMAIL_RE, undefined, '[REDACTED:EMAIL]');

  // Protect ticket refs after emails (a key inside an address is part of the address) and before the numeric rules.
  const sentinel = pickSentinel(out);
  const saved: string[] = [];
  if (sentinel !== undefined) {
    const ticketRe = new RegExp(TICKET_REF_RE.source, TICKET_REF_RE.flags);
    out = out.replace(ticketRe, match => {
      saved.push(match);
      return `${sentinel}${saved.length - 1}${sentinel}`;
    });
  }

  out = replaceValid(out, IBAN_RE, ibanValid, '[REDACTED:IBAN]');
  out = replaceValid(out, CARD_RE, cardValid, '[REDACTED:CARD]');
  out = replaceValid(out, IPV6_RE, ipv6Valid, '[REDACTED:IP]');
  out = replaceValid(out, IPV4_RE, ipv4Valid, '[REDACTED:IP]');
  out = replaceValid(out, PHONE_RE, phoneValid, '[REDACTED:PHONE]');

  if (sentinel !== undefined && saved.length > 0) {
    const restoreRe = new RegExp(`${sentinel}(\\d{1,10})${sentinel}`, 'g');
    out = out.replace(restoreRe, (whole, index: string) => saved[Number(index)] ?? whole);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------------------------

/**
 * Mask secrets and, in `on` mode, PII. Off mode equals `maskSecretsInLongText` (today's secret masking).
 * On mode never returns raw text on failure: over the input cap or on a thrown error the field becomes
 * `OBFUSCATION_FAILURE_PLACEHOLDER`.
 */
export function sanitizeText(text: string, mode: ObfuscationMode, opts?: SanitizeOptions): string {
  if (mode === 'off') {
    return maskSecretsInLongText(text);
  }
  try {
    if (typeof text !== 'string') {
      return OBFUSCATION_FAILURE_PLACEHOLDER;
    }
    if (text.length > (opts?.maxInput ?? DEFAULT_OBFUSCATION_MAX_INPUT)) {
      logger.warn('Analytics obfuscation skipped: field over the input cap; replaced by placeholder');
      return OBFUSCATION_FAILURE_PLACEHOLDER;
    }
    return applyPii(maskSecretsInLongText(text));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Walk strings, arrays and objects and `sanitizeText` every string; values under a sensitive key are
 * redacted whole (as `maskSecretsDeep`). The input is never mutated.
 */
export function sanitizeDeep<T>(value: T, mode: ObfuscationMode, opts?: SanitizeOptions): T {
  try {
    return maskSecretsDeep(value, undefined, text => sanitizeText(text, mode, opts)) as T;
  } catch (error) {
    if (mode === 'off') throw error;
    return failure(error) as unknown as T;
  }
}

/**
 * `text.slice(0, limit)`, except that a cut landing inside a `[REDACTED...]` placeholder or inside a
 * ticket reference backs up to just before it, so a truncated field never carries half a placeholder
 * (which a second pass would not recognise) or half a ticket key.
 */
export function trimBeforeOpenPlaceholder(text: string, limit: number): string {
  if (limit >= text.length) return text;
  let cut = Math.max(0, limit);

  const window = text.slice(Math.max(0, cut - 128), cut + 128);
  const offset = Math.max(0, cut - 128);
  const ticketRe = new RegExp(TICKET_REF_RE.source, TICKET_REF_RE.flags);
  for (const match of window.matchAll(ticketRe)) {
    const start = offset + (match.index ?? 0);
    if (start < cut && start + match[0].length > cut) {
      cut = start;
      break;
    }
  }

  const open = text.lastIndexOf('[', cut - 1);
  if (open >= 0 && cut - open <= PLACEHOLDER_LOOKAHEAD && text.startsWith('[REDACTED', open)) {
    const close = text.indexOf(']', open);
    if (close >= cut || close < 0) cut = open;
  }
  return text.slice(0, cut);
}
