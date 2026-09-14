/**
 * Resolves an absolute, PATH-independent `codemie` command prefix for hooks, so a
 * bare `codemie hook` no longer fails with `command not found` when the hook
 * shell's PATH lacks the codemie bin dir. See EPMCDME-14035.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCommandPath } from './processes.js';
import { getDirname } from './paths.js';

// Shell-special chars that force the command path to be quoted; mirrors BaseAgentAdapter.
const NEEDS_QUOTING = /[ \t,;=()&|<>^%[\]{}]/;

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
export async function resolveCodemieBinary(): Promise<string> {
  try {
    const resolved = await getCommandPath('codemie');
    if (resolved) return quoteIfNeeded(toForwardSlash(resolved));
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

// Resolve `bin/codemie.js` relative to this module's own package root (this
// file compiles to `dist/utils/hook-command.js`, so the root is two levels
// up) instead of via PATH or argv[1]. `bin/codemie.js` imports from `../dist/*`
// relative to itself, so a hook command built from this path always tracks
// this exact package install's own `dist/` output - including a dev checkout
// linked via `npm link`, where `npm run build` alone is then enough to update
// what the hook runs, with no re-link step. Returns null when the layout
// doesn't hold (e.g. bundled/relocated builds without a sibling `bin/`), so
// callers can fall back to `resolveCodemieBinary()`.
export function resolveCodemieBinaryFromPackage(): string | null {
  try {
    const packageRoot = join(getDirname(import.meta.url), '..', '..');
    const binPath = join(packageRoot, 'bin', 'codemie.js');
    if (!existsSync(binPath)) return null;
    return `${alwaysQuote(toForwardSlash(process.execPath))} ${alwaysQuote(toForwardSlash(binPath))}`;
  } catch {
    return null;
  }
}

// Rewrite a leading `codemie` token to `binary`; other commands pass through.
export function resolveHookCommand(command: string, binary: string): string {
  if (command === 'codemie') return binary;
  if (command.startsWith('codemie ')) return binary + command.slice('codemie'.length);
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
