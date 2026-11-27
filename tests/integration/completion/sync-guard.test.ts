import { describe, it, expect, beforeAll } from 'vitest';
import type { Command, Option } from 'commander';
import { createProgram } from '@/cli/program.js';
import { generate, COMPLETION_SHELLS, type CompletionShell } from '@/cli/completion/index.js';
import { isHiddenCommand, isHiddenOption } from '@/cli/hidden.js';
import { retiredFlags } from '@/utils/tips-validator.js';
import type { DeprecationEntry } from '@/cli/deprecation.js';

/**
 * Sync guard: the generated scripts must offer every visible command/option of the live command tree and nothing
 * hidden. The expectations come from a plain walk written here, NOT from `buildModel`, so a bug in the model cannot
 * make this test agree with itself.
 */

interface WalkNode {
  path: string[];
  visibleCommands: string[];
  visibleOptions: string[];
  hiddenCommands: string[];
  hiddenOptions: string[];
}

function optionNames(opt: Option): string[] {
  return [opt.long, opt.short].filter((n): n is string => typeof n === 'string');
}

/** Plain recursive walk; hidden commands are listed but never descended into. */
function walk(cmd: Command, path: string[] = [], out: WalkNode[] = []): WalkNode[] {
  const node: WalkNode = { path, visibleCommands: [], visibleOptions: [], hiddenCommands: [], hiddenOptions: [] };
  for (const opt of cmd.options) {
    (isHiddenOption(opt) ? node.hiddenOptions : node.visibleOptions).push(...optionNames(opt));
  }
  for (const sub of cmd.commands) {
    if (isHiddenCommand(sub)) node.hiddenCommands.push(sub.name());
    else node.visibleCommands.push(sub.name());
  }
  out.push(node);
  for (const sub of cmd.commands) {
    if (!isHiddenCommand(sub)) walk(sub, [...path, sub.name()], out);
  }
  return out;
}

interface ParsedScript {
  /** node id -> every word (commands and options) offered while the cursor is on that node */
  words: Map<string, Set<string>>;
  /** `${node}:${command}` -> child node id */
  transitions: Map<string, string>;
}

/** bash and zsh: `'N:name') node=M;;` transitions; bash `N) words='..';;`, zsh `N) cmds=(..); opts=(..);;`. */
function parseBashZsh(shell: 'bash' | 'zsh', script: string): ParsedScript {
  const transitions = new Map<string, string>();
  for (const m of script.matchAll(/'(\d+):([^']+)'\) node=(\d+);;/g)) transitions.set(`${m[1]}:${m[2]}`, m[3]);
  const words = new Map<string, Set<string>>();
  if (shell === 'bash') {
    for (const m of script.matchAll(/^\s+(\d+)\) words='([^']*)';;/gm)) {
      words.set(m[1], new Set(m[2].split('\n').filter(Boolean)));
    }
  } else {
    const entryNames = (list: string): string[] =>
      list.length === 0 ? [] : list.replace(/^'|'$/g, '').split("' '").map((e) => e.split(':')[0]);
    for (const m of script.matchAll(/^\s+(\d+)\) cmds=\((.*?)\); opts=\((.*)\);;$/gm)) {
      words.set(m[1], new Set([...entryNames(m[2]), ...entryNames(m[3])]));
    }
  }
  return { words, transitions };
}

/** fish: `case 'N:name'` followed by `set node M`; per-node `complete ... = \'N\'' -a 'name' | -l 'long' | -s 'x'`. */
function parseFish(script: string): ParsedScript {
  const transitions = new Map<string, string>();
  for (const m of script.matchAll(/case '(\d+):([^']+)'\n\s+set node (\d+)/g)) transitions.set(`${m[1]}:${m[2]}`, m[3]);
  const words = new Map<string, Set<string>>();
  const add = (node: string, word: string): void => {
    if (!words.has(node)) words.set(node, new Set());
    words.get(node)?.add(word);
  };
  for (const line of script.split('\n')) {
    const m = /^complete -c \S+ -n 'test \(__\S+_state\) = \\'(\d+)\\''(.*)$/.exec(line);
    if (!m) continue;
    const [, node, rest] = m;
    const a = /-a '([^']+)'/.exec(rest);
    const l = /-l '([^']+)'/.exec(rest);
    const s = /-s '([^']+)'/.exec(rest);
    if (a) add(node, a[1]);
    if (l) add(node, `--${l[1]}`);
    if (s) add(node, `-${s[1]}`);
  }
  return { words, transitions };
}

function parse(shell: CompletionShell, script: string): ParsedScript {
  return shell === 'fish' ? parseFish(script) : parseBashZsh(shell, script);
}

/** Follow visible command names from node 0; undefined when the script has no such transition. */
function resolveNode(parsed: ParsedScript, path: string[]): string | undefined {
  let node = '0';
  for (const name of path) {
    const next = parsed.transitions.get(`${node}:${name}`);
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

describe('completion sync guard', () => {
  let nodes: WalkNode[];
  const scripts = {} as Record<CompletionShell, ParsedScript>;

  beforeAll(() => {
    const root = createProgram();
    nodes = walk(root);
    for (const shell of COMPLETION_SHELLS) scripts[shell] = parse(shell, generate(shell, root));
  });

  it('walks a realistic tree with hidden commands and options', () => {
    expect(nodes.length).toBeGreaterThan(50);
    expect(nodes.some((n) => n.hiddenCommands.length > 0)).toBe(true);
    expect(nodes.some((n) => n.hiddenOptions.length > 0)).toBe(true);
  });

  for (const shell of COMPLETION_SHELLS) {
    describe(shell, () => {
      it('parses the script structure', () => {
        expect(scripts[shell].words.size).toBeGreaterThan(50);
        expect(scripts[shell].transitions.size).toBeGreaterThan(50);
      });

      it('offers every visible command and option at its own path', () => {
        const missing: string[] = [];
        for (const n of nodes) {
          const id = resolveNode(scripts[shell], n.path);
          if (id === undefined) {
            missing.push(`<no node for ${n.path.join(' ')}>`);
            continue;
          }
          const offered = scripts[shell].words.get(id) ?? new Set<string>();
          for (const w of [...n.visibleCommands, ...n.visibleOptions]) {
            if (!offered.has(w)) missing.push(`${n.path.join(' ') || '<root>'}: ${w}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it('never offers a hidden command or option at its own path, and never routes into a hidden command', () => {
        const leaked: string[] = [];
        for (const n of nodes) {
          const id = resolveNode(scripts[shell], n.path);
          if (id === undefined) continue;
          const offered = scripts[shell].words.get(id) ?? new Set<string>();
          // A hidden name is only a leak when no visible entry of the same name is offered here legitimately.
          const visible = new Set([...n.visibleCommands, ...n.visibleOptions]);
          for (const w of [...n.hiddenCommands, ...n.hiddenOptions]) {
            if (offered.has(w) && !visible.has(w)) leaked.push(`${n.path.join(' ') || '<root>'}: ${w}`);
          }
          for (const h of n.hiddenCommands) {
            if (scripts[shell].transitions.has(`${id}:${h}`)) leaked.push(`${n.path.join(' ')}: route into ${h}`);
          }
        }
        expect(leaked).toEqual([]);
      });

      // Positional-options mode (src/cli/program.ts): root options are valid only before the subcommand name, so
      // below the root a node may offer only its own options plus the implicit -h/--help.
      it('offers root options at the root only; other nodes offer only their own options plus -h/--help', () => {
        const rootNode = nodes.find((n) => n.path.length === 0) as WalkNode;
        const rootOnly = rootNode.visibleOptions.filter((o) => o !== '-h' && o !== '--help');
        expect(rootOnly).toEqual(expect.arrayContaining(['--task', '-V', '--version']));
        const rootOffered = scripts[shell].words.get(resolveNode(scripts[shell], []) as string) ?? new Set<string>();
        for (const o of ['--task', '-V', '--version', '-h', '--help']) expect(rootOffered.has(o), `<root>: ${o}`).toBe(true);

        const extra: string[] = [];
        for (const n of nodes) {
          if (n.path.length === 0) continue;
          const id = resolveNode(scripts[shell], n.path);
          if (id === undefined) continue;
          const allowed = new Set([...n.visibleOptions, '-h', '--help']);
          for (const w of scripts[shell].words.get(id) ?? new Set<string>()) {
            if (w.startsWith('-') && !allowed.has(w)) extra.push(`${n.path.join(' ')}: ${w}`);
          }
        }
        expect(extra).toEqual([]);
      });

      it.each([['proxy', 'status'], ['list'], ['doctor']])('does not offer --version, -V or --task at "%s"', (...path) => {
        const id = resolveNode(scripts[shell], path);
        expect(id).toBeDefined();
        const offered = scripts[shell].words.get(id as string) ?? new Set<string>();
        for (const o of ['--version', '-V', '--task']) expect(offered.has(o), o).toBe(false);
      });

      // Position-aware (per-node) rather than a whole-script substring check: `inspect`, `connect-folder` etc.
      // may legitimately appear as other names or inside descriptions elsewhere in the script.
      it.each([
        [['proxy'], 'inspect'],
        [['proxy', 'analytics'], 'connect-folder'],
        [['proxy', 'analytics'], 'disconnect-folder'],
      ])('keeps %j %s out of the script', (parentPath, name) => {
        const parent = nodes.find((n) => n.path.join(' ') === parentPath.join(' '));
        expect(parent?.hiddenCommands).toContain(name);
        const id = resolveNode(scripts[shell], parentPath);
        expect(id).toBeDefined();
        expect(scripts[shell].words.get(id as string)?.has(name)).toBe(false);
        expect(scripts[shell].transitions.has(`${id}:${name}`)).toBe(false);
      });
    });
  }

  it('agrees with tips-validator on which long flags are hidden-only', () => {
    const everyLong = new Set<string>();
    const visibleLong = new Set<string>();
    for (const n of nodes) {
      for (const w of n.hiddenOptions) if (w.startsWith('--')) everyLong.add(w);
      for (const w of n.visibleOptions) if (w.startsWith('--')) visibleLong.add(w);
    }
    // Hidden options below hidden commands are not walked; tips-validator walks them, so only flags this walk saw.
    const entries: DeprecationEntry[] = [...everyLong, ...visibleLong].map((flag) => ({
      kind: 'removed',
      old: `codemie ${flag}`,
      replacement: 'n/a',
    }));
    const expected = [...everyLong].filter((f) => !visibleLong.has(f)).sort();
    const notOffered = retiredFlags(createProgram(), entries);
    // tips-validator also sees flags under hidden commands, but only for entries we supplied, so equality holds.
    expect(notOffered).toEqual(expected);
  });
});
