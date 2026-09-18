/**
 * Resolves an absolute, PATH-independent `codemie` command prefix for hooks, so a
 * bare `codemie hook` no longer fails with `command not found` when the hook
 * shell's PATH lacks the codemie bin dir. See EPMCDME-14035.
 */
import { realpathSync } from 'fs';
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

// Prefer the PATH-resolved shim, then the running entry (argv[1]), then bare `codemie`.
// Never throws — it runs in launch-critical hook paths, so errors degrade to the next fallback.
// A PATH shim that resolves to the bundled agent binary (dev checkouts where
// node_modules/.bin precedes the global bin dir) is rejected: hooks would run the
// agent, not this CLI.
export async function resolveCodemieBinary(): Promise<string> {
  try {
    const resolved = await getCommandPath('codemie');
    if (resolved && !isShadowedCodemieShim(resolved)) return quoteIfNeeded(toForwardSlash(resolved));
  } catch {
    // fall through
  }

  const argv1 = process.argv[1];
  if (argv1) {
    // A Windows .js argv[1] is not directly invocable as a hook command — bash
    // needs a `node` prefix; both tokens use forward slashes and are quoted to
    // survive spaces in paths like "C:/Program Files/...".
    if (process.platform === 'win32' && /\.[cm]?js$/i.test(argv1)) {
      return `${alwaysQuote(toForwardSlash(process.execPath))} ${alwaysQuote(toForwardSlash(argv1))}`;
    }
    return quoteIfNeeded(toForwardSlash(argv1));
  }

  return 'codemie';
}

// Rewrite a leading `codemie` token to `binary`; other commands pass through.
// Also rewrites absolute paths baked in by older resolvers that point at the
// bundled agent shim, so already-installed hooks get repaired on rewrite.
export function resolveHookCommand(command: string, binary: string): string {
  if (command === 'codemie') return binary;
  if (command.startsWith('codemie ')) return binary + command.slice('codemie'.length);

  const firstTokenEnd = command.startsWith('"')
    ? command.indexOf('"', 1) + 1
    : command.indexOf(' ');
  if (firstTokenEnd > 0) {
    const firstToken = command.slice(0, firstTokenEnd);
    if (isShadowedCodemieShim(firstToken)) {
      return binary + command.slice(firstTokenEnd);
    }
  }
  return command;
}

// Recursively rewrite every string `command` field anywhere in a hooks structure.
// Shape-agnostic (no hardcoded layout). Mutates in place; returns true if anything changed.
export function rewriteHooksCommandTree(node: unknown, binary: string): boolean {
  if (Array.isArray(node)) {
    let changed = false;
    for (const item of node) {
      if (rewriteHooksCommandTree(item, binary)) changed = true;
    }
    return changed;
  }

  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'command' && typeof value === 'string') {
        const next = resolveHookCommand(value, binary);
        if (next !== value) {
          record[key] = next;
          changed = true;
        }
      } else if (rewriteHooksCommandTree(value, binary)) {
        changed = true;
      }
    }
    return changed;
  }

  return false;
}
