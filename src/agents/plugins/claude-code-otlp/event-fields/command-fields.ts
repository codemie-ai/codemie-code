/** Opt-in for `UserPromptSubmit`: the slash command the prompt starts with. */
export interface CommandFields {
  /** Command name without the leading slash, '' when the prompt is not a slash command. */
  command_name: string;
}

const COMMAND_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Parses the leading slash command of a prompt (`/simplify foo` -> `simplify`,
 * `/sdlc-factory:sdlc-standard x` -> `sdlc-factory:sdlc-standard`). Syntactic heuristic only:
 * it does not check that the command exists, and arguments are never reported. A pasted path
 * (`/Users/foo`), a URL or a bare `/` yield ''. Claude Code delivers the raw typed text to
 * `UserPromptSubmit`; built-in commands such as `/model` never reach it. The authoritative
 * event for skill-backed commands stays `agent.skill.dispatch`.
 */
export function resolveCommandFields(prompt: string): CommandFields {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) {
    return { command_name: '' };
  }
  const token = trimmed.slice(1).split(/\s/, 1)[0] ?? '';
  return { command_name: COMMAND_TOKEN_RE.test(token) ? token : '' };
}
