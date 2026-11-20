/**
 * Staleness validator for CLI examples (tips) and docs.
 *
 * Validates `codemie ...` example strings against the live command tree and
 * the deprecation registry, scans docs for deprecated forms, and checks that
 * marked deprecation tables stay in sync with the registry.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { listDeprecations } from '../cli/deprecation.js';
import type { DeprecationEntry } from '../cli/deprecation.js';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface Finding {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const TABLE_START = '<!-- deprecation-table:start -->';
const TABLE_END = '<!-- deprecation-table:end -->';

function tokenize(example: string): string[] {
  const tokens: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  for (const m of example.matchAll(re)) tokens.push(m[0]);
  return tokens;
}

function isPlaceholder(token: string): boolean {
  return token.startsWith('<') || token.startsWith('[');
}

function knownFlags(cmd: Command, isRoot: boolean): Set<string> {
  const flags = new Set<string>(['--help', '-h']);
  if (isRoot) {
    flags.add('--version');
    flags.add('-V');
  }
  for (const opt of cmd.options) {
    if (opt.long) flags.add(opt.long);
    if (opt.short) flags.add(opt.short);
  }
  return flags;
}

function findSub(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find(c => c.name() === name || c.aliases().includes(name));
}

/** True when `tokens` (after `codemie`) start with the tokens of `old` (after `codemie`). */
function matchesOld(tokens: string[], old: string, bareOnly = false): boolean {
  const oldTokens = tokenize(old);
  if (oldTokens[0] !== 'codemie') return false;
  const rest = oldTokens.slice(1);
  return rest.length > 0 && rest.every((t, i) => tokens[i] === t) && (!bareOnly || isBareAt(tokens, rest.length - 1));
}

/** True when the flag at `index` has no value after it (end of line or another flag). */
function isBareAt(tokens: string[], index: number): boolean {
  const next = tokens[index + 1];
  return next === undefined || next.startsWith('-');
}

function deprecatedMatch(tokens: string[], entries: readonly DeprecationEntry[]): DeprecationEntry | undefined {
  return entries.find(e => matchesOld(tokens, e.old, e.bareOnly) || matchesOldAnywhere(tokens, e.old, e.bareOnly));
}

/** Old form whose flag appears later in the line, e.g. `proxy status --json --deep`. */
function matchesOldAnywhere(tokens: string[], old: string, bareOnly = false): boolean {
  const rest = tokenize(old).slice(1);
  if (rest.length === 0) return false;
  const last = rest[rest.length - 1];
  if (!last.startsWith('-')) return false;
  const prefix = rest.slice(0, -1);
  if (!prefix.every((t, i) => tokens[i] === t)) return false;
  const at = tokens.indexOf(last, prefix.length);
  return at !== -1 && (!bareOnly || isBareAt(tokens, at));
}

export function validateCommandExample(
  program: Command,
  example: string,
  entries: readonly DeprecationEntry[] = listDeprecations()
): ValidationResult {
  const all = tokenize(example);
  const idx = all.indexOf('codemie');
  if (idx === -1) return { ok: true };
  const tokens = all.slice(idx + 1);

  const old = deprecatedMatch(tokens, entries);
  if (old) return { ok: false, reason: `uses deprecated form '${old.old}' — use ${old.replacement}` };

  const chain: Command[] = [program];
  let current = program;
  let positional = false;
  let prevWasFlag = false;
  for (const token of tokens) {
    if (token.startsWith('-')) {
      const flag = token.split('=')[0];
      if (!chain.some((c, i) => knownFlags(c, i === 0).has(flag))) {
        return { ok: false, reason: `unknown option '${flag}' for 'codemie ${chain.slice(1).map(c => c.name()).join(' ')}'`.replace(" ''", "'") };
      }
      prevWasFlag = true;
      continue;
    }
    if (!positional && !prevWasFlag && !isPlaceholder(token)) {
      const sub = findSub(current, token);
      if (sub) {
        current = sub;
        chain.push(sub);
        continue;
      }
      if (current.commands.length > 0 && current.registeredArguments.length === 0) {
        const path = chain.map(c => c.name()).join(' ');
        return { ok: false, reason: `unknown subcommand '${token}' for '${path}'` };
      }
    }
    positional = positional || !prevWasFlag;
    prevWasFlag = false;
  }
  return { ok: true };
}

function isBlockedByTable(lines: string[]): boolean[] {
  const skip: boolean[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.includes(TABLE_START)) inside = true;
    skip.push(inside);
    if (line.includes(TABLE_END)) inside = false;
  }
  return skip;
}

/** Command lines inside code spans and fenced blocks. */
function commandLines(lines: string[], skip: boolean[]): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fenced = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (skip[i]) return;
    const candidates = fenced
      ? [raw]
      : [...raw.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    for (const c of candidates) {
      if (/\bcodemie\b/.test(c)) out.push({ line: i + 1, text: c.trim() });
    }
  });
  return out;
}

function oldFormIn(text: string, entries: readonly DeprecationEntry[]): DeprecationEntry | undefined {
  const all = tokenize(text);
  const idx = all.indexOf('codemie');
  if (idx === -1) return undefined;
  return deprecatedMatch(all.slice(idx + 1), entries);
}

/** Scan raw text (docs content or root help) for registered old forms. */
export function scanText(
  label: string,
  content: string,
  entries: readonly DeprecationEntry[] = listDeprecations()
): Finding[] {
  const lines = content.split('\n');
  const skip = isBlockedByTable(lines);
  const findings: Finding[] = [];
  const isDoc = /\.mdx?$/.test(label);
  const found = isDoc
    ? commandLines(lines, skip)
    : lines.flatMap((text, i) => (skip[i] || !/\bcodemie\b/.test(text) ? [] : [{ line: i + 1, text: text.trim() }]));
  for (const { line, text } of found) {
    const entry = oldFormIn(text, entries);
    if (entry) {
      findings.push({ file: label, line, text, reason: `teaches deprecated form '${entry.old}' — use ${entry.replacement}` });
    }
  }
  return findings;
}

export function scanDocs(paths: string[], entries: readonly DeprecationEntry[] = listDeprecations()): Finding[] {
  const findings: Finding[] = [];
  for (const file of paths) {
    if (!existsSync(file)) continue;
    findings.push(...scanText(file, readFileSync(file, 'utf-8'), entries));
  }
  return findings;
}

/** Every long flag a visible (not hidden) option of any command in the tree offers. */
function offeredFlags(cmd: Command, out = new Set<string>()): Set<string> {
  for (const opt of cmd.options) {
    if (opt.long && !(opt as unknown as { hidden?: boolean }).hidden) out.add(opt.long);
  }
  for (const sub of cmd.commands) offeredFlags(sub, out);
  return out;
}

/**
 * The flags of deprecated or removed forms that no command offers any more (e.g. `--claude-code-otlp`): such a flag
 * names nothing current, so docs must not mention it outside a marked deprecation table. A flag still offered by
 * another command (`--force` of `codemie setup`) is left to the command-line scan.
 */
export function retiredFlags(
  program: Command,
  entries: readonly DeprecationEntry[] = listDeprecations(),
  /** Flags offered outside the `codemie` tree, e.g. by the agent wrappers (`codemie-claude --silent`). */
  alsoOffered: readonly string[] = []
): string[] {
  const offered = offeredFlags(program, new Set(alsoOffered));
  const flags = new Set<string>();
  for (const entry of entries) {
    for (const token of tokenize(entry.old)) {
      if (token.startsWith('--') && !offered.has(token)) flags.add(token);
    }
  }
  return [...flags].sort();
}

/**
 * Lines naming a retired flag as a flag (`--claude-code-otlp`, not the adapter id `claude-code-otlp`), anywhere in the
 * file — prose, code spans and fences — outside marked deprecation tables.
 */
export function scanRetiredFlags(paths: string[], flags: readonly string[]): Finding[] {
  if (flags.length === 0) return [];
  const escaped = flags.map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\w-])(${escaped.join('|')})(?![\\w-])`);
  const findings: Finding[] = [];
  for (const file of paths) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    const skip = isBlockedByTable(lines);
    lines.forEach((text, i) => {
      if (skip[i]) return;
      const match = pattern.exec(text);
      if (match) {
        findings.push({ file, line: i + 1, text: text.trim(), reason: `names the retired flag ${match[1]}; name its replacement` });
      }
    });
  }
  return findings;
}

function stripCode(cell: string): string {
  return cell.trim().replace(/^`+|`+$/g, '').trim();
}

export function checkDeprecationTables(
  paths: string[],
  entries: readonly DeprecationEntry[] = listDeprecations()
): Finding[] {
  const findings: Finding[] = [];
  const rows = new Map<string, { file: string; line: number }>();
  let anyBlock = false;
  for (const file of paths) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    let inside = false;
    lines.forEach((text, i) => {
      if (text.includes(TABLE_START)) { inside = true; anyBlock = true; return; }
      if (text.includes(TABLE_END)) { inside = false; return; }
      if (!inside || !text.trim().startsWith('|')) return;
      const cells = text.trim().replace(/^\||\|$/g, '').split('|').map(stripCode);
      const first = cells[0] ?? '';
      if (!first.startsWith('codemie')) return; // header and separator rows
      rows.set(first, { file, line: i + 1 });
    });
  }
  if (!anyBlock && entries.length === 0) return findings;
  const known = new Set(entries.map(e => e.old));
  for (const [old, where] of rows) {
    if (!known.has(old)) {
      findings.push({ ...where, text: old, reason: 'table row has no matching deprecation registry entry' });
    }
  }
  for (const entry of entries) {
    if (!rows.has(entry.old)) {
      findings.push({ file: paths.join(', '), line: 0, text: entry.old, reason: 'registry entry has no row in a marked deprecation table' });
    }
  }
  return findings;
}
