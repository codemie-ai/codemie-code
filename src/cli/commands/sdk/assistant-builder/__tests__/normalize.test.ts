import { describe, it, expect } from "vitest";
import { thoughtsToToolCalls, generatedToText, truncate, EXCERPT_LIMIT } from "../normalize.js";

describe("thoughtsToToolCalls", () => {
  it("returns [] for missing or non-array thoughts", () => {
    expect(thoughtsToToolCalls(undefined)).toEqual([]);
    expect(thoughtsToToolCalls(null)).toEqual([]);
    expect(thoughtsToToolCalls({ author_type: "Tool" })).toEqual([]);
  });

  it("keeps tool thoughts and skips agent thoughts and junk entries", () => {
    const calls = thoughtsToToolCalls([
      { id: "1", author_type: "Agent", author_name: "Planner", message: "thinking" },
      { id: "2", author_type: "Tool", author_name: "create_issue", input_text: '{"summary":"x"}', message: "ABC-1 created" },
      null,
      "garbage",
      { id: "3", author_type: "tool", author_name: "search_issues", message: "none", error: true },
      { id: "4", author_type: "Tool", author_name: "Codemie Thoughts", message: "reasoning" },
    ]);
    expect(calls).toEqual([
      { name: "create_issue", input: '{"summary":"x"}', output_excerpt: "ABC-1 created", error: false },
      { name: "search_issues", input: "", output_excerpt: "none", error: true },
    ]);
  });

  it("stringifies non-string fields and truncates long output", () => {
    const [call] = thoughtsToToolCalls([
      { author_type: "Tool", author_name: "big", input_text: { q: 1 }, message: "x".repeat(EXCERPT_LIMIT + 50) },
    ]);
    expect(call.input).toBe('{"q":1}');
    expect(call.output_excerpt).toHaveLength(EXCERPT_LIMIT + 1);
    expect(call.output_excerpt.endsWith("…")).toBe(true);
  });

  it("names a tool thought without author_name 'unknown'", () => {
    expect(thoughtsToToolCalls([{ author_type: "Tool" }])[0].name).toBe("unknown");
  });
});

describe("generatedToText", () => {
  it("passes strings through", () => {
    expect(generatedToText("hello")).toBe("hello");
  });
  it("serializes objects", () => {
    expect(generatedToText({ answer: 42 })).toBe('{"answer":42}');
  });
  it("maps null/undefined to empty string", () => {
    expect(generatedToText(undefined)).toBe("");
    expect(generatedToText(null)).toBe("");
  });
});

describe("truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });
});
