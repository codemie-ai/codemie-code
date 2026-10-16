/**
 * Emits the shell-agnostic core of the completion script: small dispatcher
 * functions that map `"<command> <path>"` keys to candidate lists.
 *
 * The same logical spec is emitted in either POSIX `case` syntax (bash/zsh) or
 * fish `switch` syntax, so the candidate rules live in exactly one place.
 */

import type { CandidateKind, CandidateMap, CompletionNode, RootTree } from './types.js';

export type Dialect = 'posix' | 'fish';

interface CaseEntry {
  key: string;
  value: string;
}

/** Values are embedded in single-quoted shell strings, so keep them strict. */
const SAFE_TOKEN = /^[A-Za-z0-9._:/@+,-]+$/;

function sanitizeTokens(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    for (const token of String(value).split(/\s+/)) {
      if (token && SAFE_TOKEN.test(token) && !seen.has(token)) {
        seen.add(token);
        result.push(token);
      }
    }
  }
  return result;
}

function valuesFor(
  candidate: CandidateKind | undefined,
  choices: string[] | undefined,
  candidates: CandidateMap
): string[] {
  if (choices && choices.length > 0) return sanitizeTokens(choices);
  if (candidate) return sanitizeTokens(candidates[candidate]);
  return [];
}

function optionFlags(node: CompletionNode, onlyValueTaking: boolean): string[] {
  const flags: string[] = [];
  for (const option of node.options) {
    if (onlyValueTaking && !option.takesValue) continue;
    if (option.short) flags.push(option.short);
    if (option.long) flags.push(option.long);
  }
  return flags;
}

function nodeKey(root: RootTree, node: CompletionNode): string {
  return node.path ? `${root.command} ${node.path}` : root.command;
}

function walk(node: CompletionNode, visit: (node: CompletionNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function emitCase(name: string, argExpr: string, entries: CaseEntry[], dialect: Dialect): string {
  const body = entries
    .map((entry) =>
      dialect === 'fish'
        ? `    case '${entry.key}'\n      printf '%s' '${entry.value}'`
        : `  '${entry.key}') printf '%s' '${entry.value}' ;;`
    )
    .join('\n');

  if (dialect === 'fish') {
    return `function ${name}\n  switch ${argExpr}\n${body}\n  end\nend\n`;
  }
  return `${name}() {\n  case ${argExpr} in\n${body}\n  esac\n}\n`;
}

export function emitSpec(
  dialect: Dialect,
  roots: RootTree[],
  candidates: CandidateMap
): string {
  const childrenEntries: CaseEntry[] = [];
  const flagEntries: CaseEntry[] = [];
  const valueFlagEntries: CaseEntry[] = [];
  const argEntries: CaseEntry[] = [];
  const optvalEntries: CaseEntry[] = [];

  for (const root of roots) {
    walk(root.node, (node) => {
      const key = nodeKey(root, node);

      if (node.children.length > 0) {
        const names = node.children.flatMap((child) => [child.name, ...child.aliases]);
        childrenEntries.push({ key, value: sanitizeTokens(names).join(' ') });
      }

      const flags = sanitizeTokens(optionFlags(node, false));
      if (flags.length > 0) flagEntries.push({ key, value: flags.join(' ') });

      const valueFlags = sanitizeTokens(optionFlags(node, true));
      if (valueFlags.length > 0) valueFlagEntries.push({ key, value: valueFlags.join(' ') });

      node.args.forEach((arg, index) => {
        const values = valuesFor(arg.candidate, arg.choices, candidates);
        if (values.length > 0) argEntries.push({ key: `${key}|${index}`, value: values.join(' ') });
      });

      for (const option of node.options) {
        if (!option.long) continue;
        const values = valuesFor(option.candidate, option.choices, candidates);
        if (values.length > 0) {
          optvalEntries.push({ key: `${key}|${option.long}`, value: values.join(' ') });
        }
      }
    });
  }

  const argExpr = dialect === 'fish' ? '"$argv[1]"' : '"$1"';
  const twoArgExpr = dialect === 'fish' ? '"$argv[1]|$argv[2]"' : '"$1|$2"';

  return [
    emitCase('_codemie_children', argExpr, childrenEntries, dialect),
    emitCase('_codemie_flags', argExpr, flagEntries, dialect),
    emitCase('_codemie_valueflags', argExpr, valueFlagEntries, dialect),
    emitCase('_codemie_args', twoArgExpr, argEntries, dialect),
    emitCase('_codemie_optvals', twoArgExpr, optvalEntries, dialect),
  ].join('\n');
}
