export type WorkflowInput =
  | string
  | Record<string, unknown>
  | unknown[]
  | number
  | boolean;

function isWorkflowInput(value: unknown): value is WorkflowInput {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'object' && value !== null)
  );
}

export function parseWorkflowInput(rawInput?: string): WorkflowInput | undefined {
  if (rawInput === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(rawInput);
    return isWorkflowInput(parsed) ? parsed : rawInput;
  } catch {
    return rawInput;
  }
}
