import type { ToolCall } from "./types.js";

export const EXCERPT_LIMIT = 500;

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function truncate(value: string, max: number = EXCERPT_LIMIT): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The platform reports its own reasoning step as a "Tool" thought with this name. */
const REASONING_PSEUDO_TOOL = "codemie thoughts";

/**
 * Tool invocations appear in `thoughts` with author_type "Tool" and the tool's display name
 * (e.g. "Get Project Dna" for MCP tool get_project_dna).
 */
export function isToolThought(thought: Record<string, unknown>): boolean {
  if (toText(thought.author_type).toLowerCase() !== "tool") return false;
  return toText(thought.author_name).trim().toLowerCase() !== REASONING_PSEUDO_TOOL;
}

export function thoughtsToToolCalls(thoughts: unknown): ToolCall[] {
  if (!Array.isArray(thoughts)) return [];

  const calls: ToolCall[] = [];
  for (const entry of thoughts) {
    if (!entry || typeof entry !== "object") continue;
    const thought = entry as Record<string, unknown>;
    if (!isToolThought(thought)) continue;
    calls.push({
      name: toText(thought.author_name) || "unknown",
      input: truncate(toText(thought.input_text)),
      output_excerpt: truncate(toText(thought.message)),
      error: thought.error === true,
    });
  }
  return calls;
}

export function generatedToText(generated: unknown): string {
  return toText(generated);
}
