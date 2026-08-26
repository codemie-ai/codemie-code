/**
 * Resolves an absolute, PATH-independent `codemie` command prefix for hooks, so a
 * bare `codemie hook` no longer fails with `command not found` when the hook
 * shell's PATH lacks the codemie bin dir. See EPMCDME-14035.
 */
import { getCommandPath } from './processes.js';

// Shell-special chars that force the command path to be quoted; mirrors BaseAgentAdapter.
const NEEDS_QUOTING = /[ \t,;=()&|<>^%[\]{}]/;

function quoteIfNeeded(p: string): string {
  return NEEDS_QUOTING.test(p) && !p.startsWith('"') ? `"${p}"` : p;
}

function alwaysQuote(p: string): string {
  return p.startsWith('"') ? p : `"${p}"`;
}

// Prefer the PATH-resolved shim, then the running entry (argv[1]), then bare `codemie`.
// Never throws — it runs in launch-critical hook paths, so errors degrade to the next fallback.
export async function resolveCodemieBinary(): Promise<string> {
  try {
    const resolved = await getCommandPath('codemie');
    if (resolved) return quoteIfNeeded(resolved);
  } catch {
    // fall through
  }

  const argv1 = process.argv[1];
  if (argv1) {
    // A Windows .js argv[1] is not directly invocable as a hook command — cmd.exe
    // needs a `node` prefix; both tokens are quoted to survive spaces.
    if (process.platform === 'win32' && /\.[cm]?js$/i.test(argv1)) {
      return `${alwaysQuote(process.execPath)} ${alwaysQuote(argv1)}`;
    }
    return quoteIfNeeded(argv1);
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
