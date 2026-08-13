/**
 * CodeMie run ledger — a Pi extension.
 *
 * Pi writes its session transcripts lazily, under names it chooses, and a single
 * run can produce several of them (`/new`, `/fork`, `--session` into another
 * project). A wrapper that tries to work out afterwards which files belong to the
 * run it just launched is guessing: transcripts from a concurrent `pi` in the same
 * directory are indistinguishable by id, mtime or lineage. Guessing wrong does not
 * merely lose metrics — it uploads a stranger's prompts and tool output under this
 * user's session.
 *
 * So we do not guess. This extension runs inside Pi, where the answer is a fact:
 * `ctx.sessionManager.getSessionFile()` is the transcript being written right now.
 * It appends that fact, plus every session transition, to a ledger keyed to the
 * CodeMie session id. `onSessionEnd` reads the ledger instead of scanning a
 * directory.
 *
 * ## Invariants — do not relax any of these without reading the note below
 *
 * Pi turns ANY extension load failure into a `type:"error"` diagnostic and then
 * calls `process.exit(1)` (upstream `main.ts:893-899`) — in every mode. A throw in
 * this file's import or factory therefore kills the user's coding session outright.
 * That is a far worse outcome than collecting no metrics, so:
 *
 *   1. Imports are node builtins only. Nothing from `@earendil-works/*`, not even
 *      `import type` — a zero-import file removes the question entirely.
 *   2. The whole factory body is wrapped in try/catch.
 *   3. Every handler body is separately wrapped — a throw in `session_shutdown`
 *      would truncate the ledger even though Pi catches it (`runner.ts:815-830`).
 *   4. We never subscribe to `tool_call`: a throwing `tool_call` handler *blocks
 *      the tool*, which would change what the user's agent can do.
 *   5. Handlers return `undefined`, never a result object, so the `input` handler
 *      cannot transform or swallow what the user typed.
 *   6. Only parsed *names* are recorded. Prompt and argument text never enters the
 *      ledger.
 *
 * Writes are synchronous (`appendFileSync`) so a hard exit cannot lose the last
 * line, and every write is individually guarded — a read-only disk degrades this
 * to "no metrics", never to a broken session.
 *
 * The ledger path arrives as `CODEMIE_PI_LEDGER` rather than being derived here,
 * so this file holds no assumptions about CodeMie's directory layout. No env var,
 * no ledger, no subscriptions.
 *
 * @see src/agents/plugins/pi/pi.extension.ts — writes this file out and reads it back
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEDGER_VERSION = 1;

/** `/skill:<name>` — Pi's own form, per its interactive skill dispatcher. */
const SKILL_COMMAND = /^\/skill:([A-Za-z0-9][\w.-]*)/;

/** `/<name>` — a prompt template. Anchored and charset-limited so `/usr/local/bin` does not match. */
const PROMPT_COMMAND = /^\/([A-Za-z][\w.-]*)(?:\s|$)/;

/** Call a getter that belongs to Pi, never letting its failure cost us the record. */
function safe(read) {
  try {
    const value = read();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

export default function codemieMetrics(pi) {
  try {
    const ledgerPath = process.env.CODEMIE_PI_LEDGER;
    if (!ledgerPath || process.env.CODEMIE_PI_EXTENSION_DISABLED === '1') {
      return;
    }

    let ledgerDirReady = false;
    const append = (record) => {
      try {
        if (!ledgerDirReady) {
          mkdirSync(dirname(ledgerPath), { recursive: true });
          ledgerDirReady = true;
        }
        appendFileSync(ledgerPath, `${JSON.stringify({ v: LEDGER_VERSION, ts: Date.now(), ...record })}\n`);
      } catch {
        // A ledger we cannot write is a metrics problem, not a session problem.
      }
    };

    /**
     * `getCwd()` is the transcript's own cwd, which is what we want: `--session
     * <path>` runs the whole session under the cwd recorded in that file's header,
     * not the directory the wrapper was launched from.
     */
    const sessionFacts = (ctx) => ({
      file: safe(() => ctx.sessionManager.getSessionFile()),
      piSessionId: safe(() => ctx.sessionManager.getSessionId()),
      cwd: safe(() => ctx.sessionManager.getCwd()),
      mode: safe(() => ctx.mode),
    });

    append({ t: 'boot', pid: process.pid });

    pi.on('session_start', (event, ctx) => {
      try {
        append({
          t: 'session',
          reason: safe(() => event.reason),
          prevFile: safe(() => event.previousSessionFile),
          ...sessionFacts(ctx),
        });
      } catch {
        // never propagate
      }
      return undefined;
    });

    pi.on('session_shutdown', (event, ctx) => {
      try {
        append({
          t: 'shutdown',
          reason: safe(() => event.reason),
          target: safe(() => event.targetSessionFile),
          ...sessionFacts(ctx),
        });
      } catch {
        // never propagate
      }
      return undefined;
    });

    /**
     * Slash commands are the one signal the transcript cannot carry: Pi expands a
     * prompt template into plain user text before persisting it, so `/review` is
     * gone by the time the entry is written. `input` fires with the raw text.
     *
     * Only the command name is recorded — never its arguments.
     */
    pi.on('input', (event) => {
      try {
        const text = safe(() => event.text);
        if (typeof text !== 'string' || text.charCodeAt(0) !== 47 /* '/' */) {
          return undefined;
        }
        const skill = SKILL_COMMAND.exec(text);
        if (skill) {
          append({ t: 'cmd', kind: 'skill', name: skill[1] });
          return undefined;
        }
        const prompt = PROMPT_COMMAND.exec(text);
        if (prompt) {
          append({ t: 'cmd', kind: 'prompt', name: prompt[1] });
        }
      } catch {
        // never propagate
      }
      return undefined;
    });
  } catch {
    // A throw here would make Pi exit(1) and take the user's session with it.
  }
}
