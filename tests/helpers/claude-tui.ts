import type { PtySession } from './pty-session.js';

/**
 * Claude Code's interactive input is ready to accept keystrokes.
 * - Up to 2.1.2xx: the startup box closes with a rounded `╰─` corner.
 * - 2.1.269+: the prompt is a bare `❯` between two horizontal rules. The TUI redraws
 *   with carriage returns only, so after ANSI stripping it reads `────❯ ────`.
 */
const CLAUDE_READY_RE = /╰─|─{3,}\s*❯\s*─{3,}/;

/** Workspace-trust dialog Claude Code shows for directories it has not seen before. */
const TRUST_DIALOG_RE = /trust.*folder|trustthisfolder/i;

/** Last line of the trust dialog — all options have been rendered by then. */
const DIALOG_FOOTER_RE = /Enter\s*to\s*confirm/i;

/** Option line of the dialog once "Yes" is highlighted. */
const YES_SELECTED_RE = /❯\s*(?:\d+\.\s*)?Yes/i;

/**
 * The dialog redraws right after its first frame and resets the highlighted option,
 * so keys sent as soon as the footer appears are lost.
 */
const DIALOG_SETTLE_MS = 1_500;

const KEY_DOWN = '\x1b[B';
const KEY_ENTER = '\r';

/**
 * Wait until an interactive Claude Code session accepts input, accepting the
 * workspace-trust dialog if it appears first.
 *
 * The dialog's option order differs across Claude Code versions (older builds
 * pre-select "Yes, proceed"; 2.1.269+ pre-selects "No, exit" and lists
 * "Yes, I trust this folder" second), so the selected option is inspected
 * rather than assuming a fixed key sequence.
 */
export async function waitForClaudeReady(proc: PtySession, timeoutMs: number): Promise<void> {
  let ready = false;

  void proc
    .waitFor(TRUST_DIALOG_RE, timeoutMs)
    .then(() => proc.waitFor(DIALOG_FOOTER_RE, 10_000))
    .then(() => new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS)))
    .then(async () => {
      if (ready) return;
      const selected = [...proc.lines()].reverse().find((line) => line.startsWith('❯')) ?? '';
      if (!YES_SELECTED_RE.test(selected)) {
        const cursor = proc.lines().length;
        proc.write(KEY_DOWN);
        await proc.waitFor(YES_SELECTED_RE, 5_000, cursor);
      }
      if (!ready) proc.write(KEY_ENTER);
    })
    .catch(() => {
      /* no trust dialog for this workspace */
    });

  await proc.waitFor(CLAUDE_READY_RE, timeoutMs);
  ready = true;
}
