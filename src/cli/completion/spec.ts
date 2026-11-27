/** Shell-native lookup functions shared by the completion emitters. */
import type { CandidateKind, CandidateMap, CompletionNode, RootTree } from './types.js';

export type Dialect = 'posix' | 'fish';

interface CaseEntry {
  key: string;
  values: string[];
}

const dynamicKinds = new Set<CandidateKind>(['profiles', 'plugins']);

/** Values are data, never shell syntax or a whitespace-delimited word list. */
function validValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0 &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && !(code >= 127 && code <= 159);
    })))];
}

function quote(value: string, dialect: Dialect): string {
  return dialect === 'fish'
    ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function emitCase(name: string, argExpr: string, entries: CaseEntry[], dialect: Dialect): string {
  const body = entries.map(({ key, values }) => {
    const args = values.map((value) => quote(value, dialect)).join(' ');
    return dialect === 'fish'
      ? `    case ${quote(key, dialect)}\n      printf '%s\\n' ${args}`
      : `  ${quote(key, dialect)}) printf '%s\\n' ${args} ;;`;
  }).join('\n');
  return dialect === 'fish'
    ? `function ${name}\n  switch ${argExpr}\n${body}\n  end\nend\n`
    : `${name}() {\n  case ${argExpr} in\n${body}\n  esac\n}\n`;
}

export function emitSpec(
  dialect: Dialect, roots: RootTree[], candidates: CandidateMap, namespace = '_codemie'
): string {
  const children: CaseEntry[] = [];
  const childNames: CaseEntry[] = [];
  const flags: CaseEntry[] = [];
  const valueFlags: CaseEntry[] = [];
  const optionalFlags: CaseEntry[] = [];
  const variadicFlags: CaseEntry[] = [];
  const args: CaseEntry[] = [];
  const argDynamic: CaseEntry[] = [];
  const optvals: CaseEntry[] = [];
  const optDynamic: CaseEntry[] = [];

  function addValues(
    key: string, kind: CandidateKind | undefined, choices: string[] | undefined,
    staticEntries: CaseEntry[], dynamicEntries: CaseEntry[]
  ): void {
    if (choices && choices.length > 0) {
      const values = validValues(choices);
      if (values.length) staticEntries.push({ key, values });
    } else if (kind && dynamicKinds.has(kind)) {
      dynamicEntries.push({ key, values: [kind] });
    } else if (kind) {
      const values = validValues(candidates[kind] ?? []);
      if (values.length) staticEntries.push({ key, values });
    }
  }

  function walk(root: RootTree, node: CompletionNode, inherited: CompletionNode['options']): void {
    const key = node.path ? `${root.command} ${node.path}` : root.command;
    const names = validValues(node.children.flatMap((child) => [child.name, ...child.aliases]));
    if (names.length) children.push({ key, values: names });
    for (const child of node.children) {
      for (const name of validValues([child.name, ...child.aliases])) {
        childNames.push({ key: `${key}|${name}`, values: [child.name] });
      }
    }
    // The closest command wins when it redefines an inherited flag.
    const options = [...node.options, ...inherited];
    const seen = new Set<string>();
    const allFlags: string[] = [];
    const consuming: string[] = [];
    const optional: string[] = [];
    const variadic: string[] = [];
    for (const option of options) {
      for (const flag of [option.short, option.long]) {
        if (!flag || seen.has(flag)) continue;
        seen.add(flag);
        allFlags.push(flag);
        if (option.takesValue) {
          consuming.push(flag);
          if (option.optionalValue) optional.push(flag);
          if (option.variadic) variadic.push(flag);
          addValues(`${key}|${flag}`, option.candidate, option.choices, optvals, optDynamic);
        }
      }
    }
    if (allFlags.length) flags.push({ key, values: allFlags });
    if (consuming.length) valueFlags.push({ key, values: consuming });
    if (optional.length) optionalFlags.push({ key, values: optional });
    if (variadic.length) variadicFlags.push({ key, values: variadic });
    node.args.forEach((arg, index) => {
      addValues(`${key}|${index}`, arg.candidate, arg.choices, args, argDynamic);
    });
    for (const child of node.children) walk(root, child, options);
  }
  for (const root of roots) walk(root, root.node, []);

  const one = dialect === 'fish' ? '"$argv[1]"' : '"$1"';
  const two = dialect === 'fish' ? '"$argv[1]|$argv[2]"' : '"$1|$2"';
  return [
    emitCase(`${namespace}_children`, one, children, dialect),
    emitCase(`${namespace}_child`, two, childNames, dialect),
    emitCase(`${namespace}_flags`, one, flags, dialect),
    emitCase(`${namespace}_valueflags`, one, valueFlags, dialect),
    emitCase(`${namespace}_optionalflags`, one, optionalFlags, dialect),
    emitCase(`${namespace}_variadicflags`, one, variadicFlags, dialect),
    emitCase(`${namespace}_args`, two, args, dialect),
    emitCase(`${namespace}_arg_dynamic`, two, argDynamic, dialect),
    emitCase(`${namespace}_optvals`, two, optvals, dialect),
    emitCase(`${namespace}_opt_dynamic`, two, optDynamic, dialect),
  ].join('\n');
}

/** Give each autoload file its own functions, even after another launcher loads. */
export function rootNamespace(command: string): string {
  return [...command].map((character) => character.codePointAt(0)!.toString(16)).join('_');
}
