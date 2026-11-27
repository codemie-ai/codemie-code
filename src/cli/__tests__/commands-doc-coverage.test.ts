import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHiddenCommand } from '../hidden.js';

/**
 * Drift check between docs/COMMANDS.md and the command registry (`createProgram()`).
 *
 * A parser turns the doc into headings; three rules compare them with the registry:
 *   1. forward: every visible top-level command has a non-empty section,
 *   2. reverse: every heading that maps to a command names a registered one,
 *   3. index:   every visible command has a line in the first fenced block under "Core Commands".
 *
 * Only headings count. A command named in body text documents nothing.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Docs checked by the rules. One entry today; a later split of COMMANDS.md adds entries, not parser changes. */
const DOC_PATHS: string[] = [join(ROOT, 'docs', 'COMMANDS.md')];

/**
 * Legacy headings (written before the ``### `codemie <name>` `` form) mapped to their command. Renaming them would
 * break README and doc anchors, so the test knows them instead. New sections use the backtick form and never join
 * this table. Retire it when the legacy headings are renamed with explicit anchors kept for the old links.
 */
const LEGACY_ALIASES: Record<string, string> = {
  'Codebase Memory Commands': 'codebase',
  'Documentation & Knowledge Tools': 'docs',
  'Proxy Commands': 'proxy',
  'OpenCode Metrics Commands': 'opencode-metrics',
  'Workflow Commands': 'workflow',
  'Plugin Commands': 'plugin',
  'MCP Command': 'mcp',
  'MCP Proxy Command': 'mcp-proxy',
  'Analytics Commands': 'analytics',
  'Log Management Commands': 'log',
  'Profile Management Commands': 'profile',
};

interface DocHeading {
  level: number;
  heading: string;
  /** Words after `codemie` for the backtick form, `[alias target]` for a legacy heading, else `[]`. */
  commandPath: string[];
  body: string;
}

/** Same fence rule as src/utils/tips-validator.ts: a line opening or closing a ``` or ~~~ block toggles it. */
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{2,4})\s+(.+?)\s*$/;
const COMMAND_HEADING = /^`codemie\s+([^`]+)`/;

function headingCommandPath(heading: string): string[] {
  const m = COMMAND_HEADING.exec(heading);
  if (m) return m[1].trim().split(/\s+/);
  const alias = Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, heading) ? LEGACY_ALIASES[heading] : undefined;
  return alias ? [alias] : [];
}

function parseHeadings(markdown: string): DocHeading[] {
  const headings: DocHeading[] = [];
  let fenced = false;
  let current: { level: number; heading: string; lines: string[] } | undefined;

  const close = (): void => {
    if (!current) return;
    headings.push({
      level: current.level,
      heading: current.heading,
      commandPath: headingCommandPath(current.heading),
      body: current.lines.join('\n'),
    });
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      current?.lines.push(line);
      continue;
    }
    const m = fenced ? null : HEADING.exec(line);
    if (m) {
      close();
      current = { level: m[1].length, heading: m[2], lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return headings;
}

/** Command names from the first fenced block that follows the `## Core Commands` heading. */
function parseCoreIndex(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Core Commands\s*$/.test(l));
  if (start === -1) return [];
  const names: string[] = [];
  let inBlock = false;
  for (const line of lines.slice(start + 1)) {
    if (FENCE.test(line)) {
      if (inBlock) break;
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const m = /^codemie\s+(\S+)/.exec(line);
    if (m && !m[1].startsWith('-')) names.push(m[1]);
  }
  return names;
}

function readDoc(path: string): string {
  return readFileSync(path, 'utf8');
}

async function registry(): Promise<{ all: string[]; visible: string[] }> {
  const { createProgram } = await import('../program.js');
  const commands = createProgram().commands;
  return {
    all: commands.map((c) => c.name()),
    visible: commands.filter((c) => !isHiddenCommand(c)).map((c) => c.name()),
  };
}

describe('COMMANDS.md covers the command registry', () => {
  it('every visible command has a section', async () => {
    const { visible } = await registry();
    const problems: string[] = [];
    for (const path of DOC_PATHS) {
      const headings = parseHeadings(readDoc(path));
      for (const name of visible) {
        const sections = headings.filter((h) => h.commandPath[0] === name);
        if (!sections.some((h) => h.body.split('\n').some((l) => l.trim() !== ''))) {
          problems.push(`COMMANDS.md has no non-empty section for "codemie ${name}"; add a ### \`codemie ${name}\` section`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every mapped heading names a registered command', async () => {
    const { all } = await registry();
    const registered = new Set(all);
    const problems: string[] = [];
    for (const path of DOC_PATHS) {
      for (const h of parseHeadings(readDoc(path))) {
        const name = h.commandPath[0];
        if (name !== undefined && !registered.has(name)) {
          problems.push(`Heading "${h.heading}" documents "codemie ${name}", which is not a registered command; remove or fix the section`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every legacy alias heading still exists', () => {
    const problems: string[] = [];
    for (const path of DOC_PATHS) {
      const texts = new Set(parseHeadings(readDoc(path)).map((h) => h.heading));
      for (const [alias, command] of Object.entries(LEGACY_ALIASES)) {
        if (!texts.has(alias)) {
          problems.push(`Legacy heading "${alias}" (codemie ${command}) is missing from COMMANDS.md; restore it or update LEGACY_ALIASES`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every visible command is in the Core Commands index', async () => {
    const { visible } = await registry();
    const problems: string[] = [];
    for (const path of DOC_PATHS) {
      const indexed = new Set(parseCoreIndex(readDoc(path)));
      for (const name of visible) {
        if (!indexed.has(name)) {
          problems.push(`"codemie ${name}" is missing from the Core Commands index in COMMANDS.md; add a line to Core Commands`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('COMMANDS.md parser', () => {
  it('does not treat a # comment inside a fenced block as a heading', () => {
    const md = ['### `codemie a`', 'text', '```bash', '# just a comment', 'codemie a', '```'].join('\n');
    const headings = parseHeadings(md);
    expect(headings.map((h) => h.heading)).toEqual(['`codemie a`']);
    expect(headings[0].body).toContain('# just a comment');
  });

  it('maps no heading for a command named only in body text', () => {
    const md = ['## Hooks', 'Run codemie hook --agent x to forward events.', 'See `codemie sound` too.'].join('\n');
    expect(parseHeadings(md).filter((h) => h.commandPath.length > 0)).toEqual([]);
  });

  it('parses CRLF input the same as LF input', () => {
    const lf = ['## MCP Command', 'body', '### `codemie hook`', '', 'text'].join('\n');
    expect(parseHeadings(lf.replace(/\n/g, '\r\n'))).toEqual(parseHeadings(lf));
  });

  it('maps a nested setup heading to setup and a legacy heading to its command', () => {
    const md = ['#### `codemie setup assistants`', 'x', '## MCP Command', 'y'].join('\n');
    expect(parseHeadings(md).map((h) => h.commandPath)).toEqual([['setup', 'assistants'], ['mcp']]);
  });

  it('reads the first fenced block under Core Commands and ignores option lines', () => {
    const md = ['## Core Commands', '', '```bash', 'codemie --help  # x', 'codemie setup  # y', 'codemie hook  # z', '```', '```', 'codemie late', '```'].join('\r\n');
    expect(parseCoreIndex(md)).toEqual(['setup', 'hook']);
  });
});
