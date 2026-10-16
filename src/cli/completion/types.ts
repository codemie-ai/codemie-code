/**
 * Shared types for shell-completion generation.
 *
 * The completion script is produced from a snapshot of the live Commander
 * command tree taken when the user runs `codemie completion <shell>`.
 */

export type Shell = 'bash' | 'zsh' | 'fish';

export const SUPPORTED_SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish'];

/**
 * Named, runtime-resolved candidate sets. A rule either points at one of these
 * (resolved from the live registries) or carries explicit literal `choices`
 * (e.g. Commander's `.choices(...)`).
 */
export type CandidateKind =
  | 'agents'
  | 'install-names'
  | 'uninstall-names'
  | 'providers'
  | 'profiles'
  | 'workflows'
  | 'docs-tools'
  | 'frameworks'
  | 'init-names'
  | 'targets'
  | 'formats'
  | 'report-formats'
  | 'presets'
  | 'bmad-channels'
  | 'reasoning-efforts'
  | 'shells'
  | 'plugins';

export interface CompletionArgument {
  /** Positional argument name, e.g. `name` for `<name>`. */
  name: string;
  required: boolean;
  variadic: boolean;
  /** Explicit literal candidates (Commander `.choices(...)`). */
  choices?: string[];
  /** Named candidate set resolved from the registries. */
  candidate?: CandidateKind;
}

export interface CompletionOption {
  short?: string;
  long?: string;
  negate: boolean;
  /** Whether the option consumes a value (`<x>` or `[x]`). */
  takesValue: boolean;
  choices?: string[];
  candidate?: CandidateKind;
}

export interface CompletionNode {
  /** Command name without arguments, e.g. `install`. */
  name: string;
  aliases: string[];
  /** Space-joined path from the command root; empty string for the root. */
  path: string;
  description?: string;
  options: CompletionOption[];
  args: CompletionArgument[];
  children: CompletionNode[];
}

/** A root command and its introspected tree. */
export interface RootTree {
  /** Invoked command, e.g. `codemie` or `codemie-claude`. */
  command: string;
  node: CompletionNode;
}

/** Candidate values, keyed by kind, resolved once at generation time. */
export type CandidateMap = Record<CandidateKind, string[]>;

export function isShell(value: string): value is Shell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}
