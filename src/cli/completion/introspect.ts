/**
 * Commander command-tree introspection for shell completions.
 *
 * Walks a `Command` tree into a plain, serialisable {@link CompletionNode}
 * shape. Candidate rules (which argument/option gets which value set) are
 * applied here, keyed by the command path relative to the root.
 */

import type { Argument, Command, Option } from 'commander';
import type {
  CandidateKind,
  CompletionArgument,
  CompletionNode,
  CompletionOption,
} from './types.js';

/** Options whose value is a named candidate set, keyed by long flag. */
const OPTION_CANDIDATES: Record<string, CandidateKind> = {
  '--profile': 'profiles',
  '--provider': 'providers',
  '--target': 'targets',
  '--format': 'formats',
  '--report-format': 'report-formats',
  '--export': 'report-formats',
  '--preset': 'presets',
  '--bmad-channel': 'bmad-channels',
  '--reasoning-effort': 'reasoning-efforts',
  '--shell': 'shells',
};

/**
 * Paths (relative to the root) where `--agent` means the setup *target* agents
 * (claude/codex/gemini) rather than the CodeMie agent names.
 */
const AGENT_TARGET_PATHS = new Set([
  'assistants setup',
  'skills setup',
  'setup assistants',
  'setup skills',
]);

/** Literal `--scope` values, which differ per command group. */
const SCOPE_CHOICES: Record<string, string[]> = {
  'mcp add': ['project', 'user'],
  'mcp remove': ['project', 'user'],
  'assistants setup': ['global', 'local'],
  'skills setup': ['global', 'local'],
  'setup assistants': ['global', 'local'],
  'setup skills': ['global', 'local'],
};

/** Positional argument candidates, keyed by path then argument index. */
const ARG_CANDIDATES: Record<string, Record<number, CandidateKind>> = {
  install: { 0: 'install-names' },
  uninstall: { 0: 'uninstall-names' },
  update: { 0: 'agents' },
  'docs install': { 0: 'docs-tools' },
  'docs uninstall': { 0: 'docs-tools' },
  'docs init': { 0: 'docs-tools' },
  'workflow install': { 0: 'workflows' },
  'workflow uninstall': { 0: 'workflows' },
  completion: { 0: 'shells' },
  init: { 0: 'init-names' },
  'profile switch': { 0: 'profiles' },
  'profile delete': { 0: 'profiles' },
  'profile rename': { 0: 'profiles' },
  'plugin uninstall': { 0: 'plugins' },
  'plugin enable': { 0: 'plugins' },
  'plugin disable': { 0: 'plugins' },
};

/**
 * Fallback positional candidates, keyed by argument name, used only when the
 * path has no explicit {@link ARG_CANDIDATES} rule. Commander strips brackets
 * and the variadic marker, so `[profile]` yields the name `profile`. Kept to
 * unambiguous names only, since the same name can mean different things across
 * commands (e.g. `name`).
 */
const ARG_NAME_CANDIDATES: Record<string, CandidateKind> = {
  profile: 'profiles',
};

function joinPath(parent: string, name: string): string {
  return parent ? `${parent} ${name}` : name;
}

function optionCandidate(long: string | undefined, path: string): CandidateKind | undefined {
  if (!long) return undefined;
  if (long === '--agent') {
    return AGENT_TARGET_PATHS.has(path) ? 'targets' : 'agents';
  }
  return OPTION_CANDIDATES[long];
}

function toOption(option: Option, path: string): CompletionOption {
  // `Option` internals vary across Commander minors; read defensively.
  const raw = option as unknown as {
    short?: string;
    long?: string;
    negate?: boolean;
    required?: boolean;
    optional?: boolean;
    argChoices?: string[];
  };

  const long = raw.long;
  let choices = raw.argChoices;
  if (long === '--scope' && !choices) {
    choices = SCOPE_CHOICES[path];
  }

  return {
    short: raw.short,
    long,
    negate: raw.negate === true,
    takesValue: raw.required === true || raw.optional === true,
    choices,
    candidate: optionCandidate(long, path),
  };
}

function argumentName(argument: Argument): string {
  const raw = argument as unknown as { name?: string | (() => string) };
  if (typeof raw.name === 'function') return raw.name();
  return typeof raw.name === 'string' ? raw.name : '';
}

function toArgument(argument: Argument, path: string, index: number): CompletionArgument {
  const raw = argument as unknown as {
    required?: boolean;
    variadic?: boolean;
    argChoices?: string[];
  };

  const name = argumentName(argument);

  return {
    name,
    required: raw.required === true,
    variadic: raw.variadic === true,
    choices: raw.argChoices,
    candidate: ARG_CANDIDATES[path]?.[index] ?? ARG_NAME_CANDIDATES[name],
  };
}

function registeredArguments(command: Command): Argument[] {
  const raw = command as unknown as {
    registeredArguments?: Argument[];
    _args?: Argument[];
  };
  return raw.registeredArguments ?? raw._args ?? [];
}

function collectOptions(command: Command, path: string): CompletionOption[] {
  const options = command.options.map((option) => toOption(option, path));
  const seen = new Set(options.map((option) => option.long).filter(Boolean));

  // Commander adds the help option lazily (during parse/help), so a subcommand
  // we introspect before it parses will not list it yet. Inject it explicitly.
  if (!seen.has('--help')) {
    options.push({ short: '-h', long: '--help', negate: false, takesValue: false });
  }

  return options;
}

function collectArguments(command: Command, path: string): CompletionArgument[] {
  return registeredArguments(command).map((argument, index) => toArgument(argument, path, index));
}

function build(command: Command, path: string): CompletionNode {
  const children = command.commands.map((child) =>
    build(child, joinPath(path, child.name()))
  );

  return {
    name: command.name(),
    aliases: typeof command.aliases === 'function' ? command.aliases() : [],
    path,
    description: command.description(),
    options: collectOptions(command, path),
    args: collectArguments(command, path),
    children,
  };
}

/**
 * Introspect a root command. The returned node's `path` is the empty string.
 */
export function introspectTree(command: Command): CompletionNode {
  return build(command, '');
}
