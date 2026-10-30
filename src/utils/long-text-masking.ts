import { applySecretPatterns, MAX_MASK_INPUT_CHARS, REDACTED } from './security.js';

/** Longest text `maskSecretsInLongText` scans; the rest is replaced by a truncation marker. */
const MAX_LONG_MASK_INPUT_CHARS = 8 * 1024 * 1024;

/** Characters compared on each side of a chunk boundary to prove the boundary does not cut a secret. */
const SEAM_CHARS = 8 * 1024;

/** How far back from a chunk's end a boundary is looked for after whitespace, and how many boundaries are tried. */
const SPLIT_SEARCH_CHARS = 4 * 1024;
const MAX_SPLIT_CHECKS = 16;

/** Whitespace boundaries tried are at least this far apart, so a rejected one (inside a multi-line match) is skipped past. */
const SPLIT_STEP_CHARS = 256;

const PEM_BEGIN_AT_START = /^-----BEGIN [A-Z0-9 ]{1,40}-----/;
const PEM_END = /-----END [A-Z0-9 ]{1,40}-----/;

/**
 * A boundary is safe when masking the text around it as one piece gives the same result as masking
 * each side alone, i.e. no secret pattern matches across it. Looks `SEAM_CHARS` to each side, so a
 * multi-line match (a PEM block) longer than that can slip past the check.
 */
function splitKeepsSecretsIntact(text: string, at: number): boolean {
  const left = text.slice(Math.max(0, at - SEAM_CHARS), at);
  const right = text.slice(at, at + SEAM_CHARS);
  return applySecretPatterns(left + right) === applySecretPatterns(left) + applySecretPatterns(right);
}

/** True when the text's last PEM block has a BEGIN line but no END line, so the block runs on into the next chunk. */
function endsInsideOpenPem(text: string): boolean {
  const begin = text.lastIndexOf('-----BEGIN ');
  return begin >= 0 && PEM_BEGIN_AT_START.test(text.slice(begin, begin + 80)) && !PEM_END.test(text.slice(begin));
}

/**
 * A boundary inside an open PEM block is safe by construction: the block is redacted up to the
 * boundary and `maskSecretsInLongText` drops the remainder through its END line. Any other boundary
 * must pass the seam check.
 */
function isSafeSplit(text: string, start: number, at: number): boolean {
  return endsInsideOpenPem(text.slice(start, at)) || splitKeepsSecretsIntact(text, at);
}

/** A safe boundary in `(start, end]`, preferring one right after whitespace; undefined when none is found. */
function findSafeSplit(text: string, start: number, end: number): number | undefined {
  const lowest = Math.max(start, end - SPLIT_SEARCH_CHARS);
  let checks = 0;
  let at = end;
  while (at > lowest && checks < MAX_SPLIT_CHECKS) {
    if (/\s/.test(text.charAt(at - 1))) {
      checks++;
      if (isSafeSplit(text, start, at)) return at;
      at -= SPLIT_STEP_CHARS;
    } else {
      at--;
    }
  }
  for (at = end; at > start && at > end - MAX_SPLIT_CHECKS; at--) {
    if (isSafeSplit(text, start, at)) return at;
  }
  return undefined;
}

/**
 * Like `maskSecretsInText`, but scans the whole text instead of dropping everything past 64 KB:
 * it is cut into 64 KB chunks at boundaries that no secret pattern crosses, and each chunk is
 * masked on its own. Fails closed: when no safe interior boundary exists the remainder is redacted,
 * and text beyond 8 MB is replaced by a truncation marker. The 8 MB cut is placed like any other
 * boundary; when none is safe the last chunk is omitted, so unscanned text is never returned.
 */
export function maskSecretsInLongText(text: string): string {
  if (text.length <= MAX_MASK_INPUT_CHARS) {
    return applySecretPatterns(text);
  }
  const limit = Math.min(text.length, MAX_LONG_MASK_INPUT_CHARS);
  const parts: string[] = [];
  // A PEM block left open at a chunk edge was already redacted to that edge; its remainder is dropped up to the END line.
  let insideOpenPem = false;
  const maskChunk = (chunk: string): string => {
    let body = chunk;
    if (insideOpenPem) {
      const end = PEM_END.exec(body);
      if (!end) return '';
      body = body.slice(end.index + end[0].length);
    }
    insideOpenPem = endsInsideOpenPem(body);
    return applySecretPatterns(body);
  };
  let start = 0;
  while (limit - start > MAX_MASK_INPUT_CHARS) {
    const split = findSafeSplit(text, start, start + MAX_MASK_INPUT_CHARS);
    if (split === undefined) {
      parts.push(REDACTED);
      return parts.join('');
    }
    parts.push(maskChunk(text.slice(start, split)));
    start = split;
  }
  const cut = text.length > limit ? (findSafeSplit(text, start, limit) ?? start) : limit;
  parts.push(maskChunk(text.slice(start, cut)));
  if (text.length > cut) {
    parts.push(`[TRUNCATED: ${text.length - cut} chars omitted]`);
  }
  return parts.join('');
}
