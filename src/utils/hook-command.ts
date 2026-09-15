/**
 * Resolves an absolute, PATH-independent `codemie` command prefix for hooks, so a
 * bare `codemie hook` no longer fails with `command not found` when the hook
 * shell's PATH lacks the codemie bin dir. See EPMCDME-14035.
 */
import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { getCommandPath } from './processes.js';

const CODEMIE_PACKAGE_NAME = '@codemieai/code';

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

// True when binPath resolves into an installed npm package other than @codemieai/code.
// Any dependency declaring `bin: { codemie }` (e.g. @codemieai/codemie-opencode <= 0.0.47)
// is linked into node_modules/.bin and wins `which codemie` inside npm scripts; writing
// that into hooks runs the wrong program. Paths outside node_modules (npm link, standalone
// installs, Windows shims) and unreadable paths are trusted as before.
function isForeignPackageBinary(binPath: string): boolean {
  try {
    let current = dirname(realpathSync(binPath));
    if (!current.split(/[\\/]/).includes('node_modules')) return false;

    while (true) {
      const manifestPath = join(current, 'package.json');
      if (existsSync(manifestPath)) {
        const { name } = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string };
        // Nameless manifests (e.g. {"type":"module"} markers) don't own the binary; keep walking.
        if (name) return name !== CODEMIE_PACKAGE_NAME;
      }
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

// Prefer the PATH-resolved shim (unless another package owns it), then the running entry
// (argv[1]), then bare `codemie`.
// Never throws — it runs in launch-critical hook paths, so errors degrade to the next fallback.
export async function resolveCodemieBinary(): Promise<string> {
  try {
    const resolved = await getCommandPath('codemie');
    if (resolved && !isForeignPackageBinary(resolved)) return quoteIfNeeded(toForwardSlash(resolved));
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
