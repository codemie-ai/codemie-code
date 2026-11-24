/**
 * Resolves an absolute, PATH-independent `codemie` command prefix for hooks, so a
 * bare `codemie hook` no longer fails with `command not found` when the hook
 * shell's PATH lacks the codemie bin dir. See EPMCDME-14035.
 */
import { existsSync, realpathSync } from 'fs';
import { basename, dirname, extname, resolve } from 'path';
import { getCommandPath } from './processes.js';

// Shell-special chars that force the command path to be quoted; mirrors BaseAgentAdapter.
const NEEDS_QUOTING = /[ \t,;=()&|<>^%[\]{}]/;

// The bundled agent package (@codemieai/codemie-opencode) registers `codemie` as
// its own bin name, so in dev checkouts node_modules/.bin/codemie symlinks to the
// agent binary, not to this CLI. Hooks pointed at that shim silently run the
// wrong program: `codemie hook` is parsed as a project path, and
// `codemie sound X` prints the agent's CLI help to stdout and exits 1 with empty
// stderr (surfacing in agents as "Failed with non-blocking status code: No
// stderr output").
const SHADOWING_PACKAGE_SEGMENT = '/@codemieai/codemie-opencode/';

// Extensions npm gives a bin entry: the sh shim has none, Windows adds .cmd/.ps1, and the
// script itself is .js.
const BIN_EXTENSION = String.raw`(\.(cmd|ps1|exe|[cm]?js))?`;
const ABSOLUTE_PATH = /^([a-zA-Z]:)?[\\/]/;
const CODEMIE_CLI_NAME = new RegExp(`^codemie${BIN_EXTENSION}$`, 'i');
// This package's other bin entries (package.json `bin`): `codemie-<agent>[-acp]`,
// `codemie-mcp-proxy`, and the scripts behind `codemie-code` and the proxy daemon.
const AGENT_WRAPPER_NAME = new RegExp(`^(codemie-[a-z0-9-]+|agent-executor|proxy-daemon)${BIN_EXTENSION}$`, 'i');
// The subcommands codemie installs as hooks.
const CODEMIE_HOOK_SUBCOMMAND = /^\s+(hook|sound)(\s|$)/;

/**
 * Detect whether a `codemie` command path actually resolves to the bundled agent
 * binary instead of this CLI. Checks both the raw path and its symlink target;
 * never throws (unresolvable paths are treated as not shadowed).
 */
export function isShadowedCodemieShim(commandPath: string): boolean {
  const unquoted = commandPath.replace(/^"|"$/g, '');
  const candidates = [unquoted];
  try {
    candidates.push(realpathSync(unquoted));
  } catch {
    // Unresolvable path — judge by the raw path alone.
  }
  return candidates.some((candidate) =>
    candidate.replace(/\\/g, '/').includes(SHADOWING_PACKAGE_SEGMENT),
  );
}

function fileName(p: string): string {
  return basename(toForwardSlash(p));
}

function isCodemieCliName(p: string): boolean {
  return CODEMIE_CLI_NAME.test(fileName(p));
}

function quoteIfNeeded(p: string): string {
  return NEEDS_QUOTING.test(p) && !p.startsWith('"') ? `"${p}"` : p;
}

function alwaysQuote(p: string): string {
  return p.startsWith('"') ? p : `"${p}"`;
}

// Convert Windows backslashes to forward slashes so the resolved path survives
// bash (Git Bash / WSL) execution without \X sequences being consumed as escapes.
// No-op on paths that already use forward slashes. See EPMCDME-14035.
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

// Prefer the PATH-resolved shim, then the CLI entry next to the running script (argv[1]),
// then bare `codemie`.
// Never throws — it runs in launch-critical hook paths, so errors degrade to the next fallback.
// A PATH shim that resolves to the bundled agent binary (dev checkouts where
// node_modules/.bin precedes the global bin dir) is rejected: hooks would run the
// agent, not this CLI.
export async function resolveCodemieBinary(): Promise<string> {
  return resolveBinary();
}

async function resolveBinary(): Promise<string> {
  try {
    let resolved = await getCommandPath('codemie');
    // npm's extensionless sh shim comes first in `where` output; PowerShell can only run the .cmd.
    if (resolved && process.platform === 'win32' && !extname(resolved) && existsSync(`${resolved}.cmd`)) {
      resolved = `${resolved}.cmd`;
    }
    if (resolved && !isShadowedCodemieShim(resolved)) return quoteIfNeeded(toForwardSlash(resolved));
  } catch {
    // fall through
  }

  const entry = process.argv[1] ? findCliEntry(process.argv[1]) : null;
  return entry ? renderCliEntry(entry) : 'codemie';
}

// argv[1] is the running script. Under `codemie` it is the CLI itself; under an agent
// wrapper (`codemie-claude`, `agent-executor.js`, …) it is not, and a hook pointed at
// it relaunches the agent: Claude's SessionStart hook then starts another Claude,
// forever. For a wrapper, use the CLI entry npm installs beside it, or none.
function findCliEntry(argv1: string): string | null {
  if (isCodemieCliName(argv1)) return argv1;
  const dir = dirname(argv1);
  const siblings = [process.platform === 'win32' ? 'codemie.cmd' : 'codemie', 'codemie.js'];
  return (
    siblings
      .map((name) => resolve(dir, name))
      .find((candidate) => existsSync(candidate) && !isShadowedCodemieShim(candidate)) ?? null
  );
}

// A Windows .js entry is not directly invocable as a hook command — bash needs a
// `node` prefix; both tokens use forward slashes and are quoted to survive spaces
// in paths like "C:/Program Files/...".
function renderCliEntry(entry: string): string {
  if (process.platform === 'win32' && /\.[cm]?js$/i.test(entry)) {
    return `${alwaysQuote(toForwardSlash(process.execPath))} ${alwaysQuote(toForwardSlash(entry))}`;
  }
  return quoteIfNeeded(toForwardSlash(entry));
}

/**
 * The head of a hook command in the shapes resolveBinary emits — `path`, `"path"`, or `"node" "script.js"`, each
 * optionally after `& ` — as its unquoted paths, with the head as written and the rest of the command; null when
 * the command has no head.
 */
export function parseHookCommandHead(command: string): { head: string; paths: string[]; rest: string } | null {
  const match = /^(?:& )?("[^"]*"(?: "[^"]*\.[cm]?js")?|\S+)([\s\S]*)$/.exec(command);
  if (!match) return null;
  const [, head, rest] = match;
  const paths = (head.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  return { head, paths, rest };
}

/** An absolute path to a `codemie` shim, `codemie.cmd` / `.ps1` / `.exe`, or a `codemie.js` script. */
export function isAbsoluteCodemiePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path) && isCodemieCliName(path);
}

/**
 * An absolute path to one of this package's agent wrappers (`codemie-claude`, `codemie-gemini`,
 * `agent-executor.js`, …) in any of the shapes npm installs. Older resolvers baked these into hook
 * commands in place of the CLI. EPMCDME-14035.
 */
export function isAbsoluteAgentWrapperPath(path: string): boolean {
  return ABSOLUTE_PATH.test(path) && AGENT_WRAPPER_NAME.test(fileName(path));
}

// Rewrite a leading `codemie` token to `binary`; other commands pass through.
// Also rewrites absolute paths baked in by older resolvers that point at the
// bundled agent shim, a file that is gone, or an agent wrapper running a codemie
// subcommand, so already-installed hooks get repaired.
// `powershell` adds the call operator `& ` to quoted paths: hooks marked `"shell": "powershell"`
// (see rewriteHooksCommandTree) parse a leading quoted string as a plain string and never run it.
// Parses what resolveBinary emits: `path`, `"path"`, or `"node" "script.js"`.
export function resolveHookCommand(command: string, binary: string, powershell = false): string {
  const render = (c: string): string => (powershell && c.startsWith('"') ? `& ${c}` : c);
  if (command === 'codemie') return render(binary);
  if (command.startsWith('codemie ')) return render(binary) + command.slice('codemie'.length);

  const parsed = parseHookCommandHead(command);
  if (!parsed) return command;
  const { head, paths, rest } = parsed;
  const last = paths[paths.length - 1];
  const isCodemiePath = isAbsoluteCodemiePath(last);
  // A codemie subcommand run through an agent wrapper relaunches the agent (see findCliEntry).
  const runsThroughWrapper = isAbsoluteAgentWrapperPath(last) && CODEMIE_HOOK_SUBCOMMAND.test(rest);
  // Shadowed shim, or a codemie path whose file is gone (e.g. an old npm-prefix install):
  // re-resolve instead of keeping a command that can only fail. EPMCDME-15907.
  const isStale = paths.some(isShadowedCodemieShim) || (isCodemiePath && !paths.every((p) => existsSync(p)));
  if (runsThroughWrapper || isStale) {
    return render(binary) + rest;
  }
  // Same file, but the hook shell changed (Git Bash installed/removed): fix the `& ` prefix.
  return isCodemiePath ? render(head) + rest : command;
}

// Recursively rewrite every string `command` field anywhere in a hooks structure.
// Shape-agnostic (no hardcoded layout). Mutates in place; returns true if anything changed.
// With `powershell`, a hook whose command needs `& ` is pinned to `"shell": "powershell"`, so
// Claude Code no longer picks bash/PowerShell by guessing and the `&` is never seen by bash.
export function rewriteHooksCommandTree(node: unknown, binary: string, powershell = false): boolean {
  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (rewriteHooksCommandTree(item, binary, powershell)) changed = true;
    }
    return changed;
  }

  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'command' && typeof value === 'string') {
        const next = resolveHookCommand(value, binary, powershell);
        if (next !== value) {
          record[key] = next;
          changed = true;
        }
        if (powershell && next.startsWith('& ') && record.shell !== 'powershell') {
          record.shell = 'powershell';
          changed = true;
        }
      } else if (rewriteHooksCommandTree(value, binary, powershell)) {
        changed = true;
      }
    }
    return changed;
  }

  return false;
}
