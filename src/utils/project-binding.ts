/**
 * Project binding: how the CodeMie project of a session was decided (EPMCDME-15411).
 *
 * Dependency-free on purpose: the standalone Claude statusline and hook paths may
 * import it without pulling in ConfigLoader.
 *
 * - `own`            global profile stores its own project
 * - `none`           global profile is kept off CodeMie (`codeMieProject: null`)
 * - `unowned`        project-carrying global profile with no project of its own;
 *                    the session falls back to the shared (last setup) project
 * - `local`          repo-local profile; identity comes from the repository scope
 * - `not-applicable` provider without a CodeMie project (litellm, bedrock, ollama)
 */
export type ProjectBindingState = 'own' | 'none' | 'unowned' | 'local' | 'not-applicable';

/** Output-only env var the launcher exports next to CODEMIE_PROFILE_NAME. Never an input to config loading. */
export const PROJECT_BINDING_ENV = 'CODEMIE_PROJECT_BINDING';

const STATES: readonly ProjectBindingState[] = ['own', 'none', 'unowned', 'local', 'not-applicable'];

/** Parse a binding value; unknown or missing values yield `undefined`. */
export function parseProjectBinding(value: unknown): ProjectBindingState | undefined {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value)
    ? (value as ProjectBindingState)
    : undefined;
}

/** Strip control characters (incl. ANSI escapes' ESC) from text shown in a terminal. */
export function sanitizeDisplayText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/**
 * Whether a binding shows a Project line at all. Providers without a CodeMie
 * project show none (AC7).
 */
export function showsProjectLine(state: ProjectBindingState | undefined): state is Exclude<ProjectBindingState, 'not-applicable'> {
  return state !== undefined && state !== 'not-applicable';
}

/**
 * Human-readable project text for banner, `codemie profile` and warnings.
 * Returns `undefined` when no Project line is shown.
 */
export function describeProjectBinding(
  state: ProjectBindingState | undefined,
  project: string | undefined
): string | undefined {
  if (!showsProjectLine(state)) return undefined;
  const name = project ? sanitizeDisplayText(project) : '';
  switch (state) {
    case 'none':
      return 'off CodeMie';
    case 'unowned':
      return name ? `${name} (shared fallback)` : 'none (no project selected)';
    case 'own':
    case 'local':
      return name || 'none';
  }
}

/** Short label of the state, used by `--show-sources` style output. */
export function bindingLabel(state: ProjectBindingState): string {
  switch (state) {
    case 'own':
      return 'own';
    case 'none':
      return 'off CodeMie';
    case 'unowned':
      return 'shared fallback';
    case 'local':
      return 'repository';
    case 'not-applicable':
      return 'not applicable';
  }
}
