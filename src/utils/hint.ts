/** Inputs of a one-line fix hint: why, and either one command or a prose action. */
export interface HintAdvice {
  /** Why the user is seeing this, as a clause. */
  reason: string;
  /** A single runnable command that fixes it; wins over `action`. */
  command?: string;
  /** Prose guidance when no single command fixes it. */
  action?: string;
}

/** The one hint format of the CLI: `<reason> — run: <command>` or `<reason> — <action>`. */
export function renderHint(advice: HintAdvice): string {
  if (advice.command) return `${advice.reason} — run: ${advice.command}`;
  if (advice.action) return `${advice.reason} — ${advice.action}`;
  return advice.reason;
}
