export type ForwardDecision =
  | { decision: 'forward'; payload: Record<string, unknown>[] }
  | { decision: 'block'; reason: string, hookSpecificOutput: Record<string, string | boolean> };
