import stripAnsi from 'strip-ansi';

/**
 * Remove everything that could drive the terminal from a value the user does not necessarily
 * control (a profile, a Claude settings file of the repository in the current directory).
 *
 * ASCII allowlist: accept only printable ASCII (0x20–0x7E) after stripping ANSI
 * sequences. This blocks C0/C1 bytes, Bidi override chars, soft hyphen,
 * zero-width chars, combining marks, and every other non-ASCII Unicode vector.
 *
 * DCS pre-strip: strip-ansi only removes the 2-byte introducer (\x1bP etc.),
 * leaving the payload as plain ASCII. Strip the full sequence — from introducer
 * to BEL/ST/C1-ST terminator — before handing off to strip-ansi. If no terminator
 * is found, consume to end-of-string (greedy fallback) to prevent partial leakage.
 */
export function stripTerminalControls(s: string): string {
  // ESC-form: P=DCS X=SOS ^=PM _=APC; C1-form: \x90 \x98 \x9d(OSC) \x9e \x9f
  const noStringCmds = s.replace(/(?:\x1b[PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, ''); // eslint-disable-line no-control-regex
  return stripAnsi(noStringCmds).replace(/[^\x20-\x7e]/gu, '');
}

/**
 * Sanitize a config-sourced value (URL, model ID) before rendering it to the terminal.
 *
 * `stripTerminalControls`, plus a URL userinfo guard: https://user@evil.com routes to evil.com;
 * the @ is valid ASCII so the allowlist cannot catch it — URL parsing is required.
 */
export function safeTerminalValue(s: string): string {
  const stripped = stripTerminalControls(s);
  try {
    const url = new URL(stripped);
    if (url.username || url.password || url.search || url.hash) {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return `[credentials removed] ${url.toString()}`;
    }
  } catch {
    // Not a parseable URL — return stripped string as-is
  }
  return stripped;
}
