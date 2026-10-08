import { describe, it, expect } from "vitest";
import { evaluateDeterministicChecks, normalizeToolName } from "../checks.js";
import type { Scenario, ScenarioResult } from "../types.js";

const scenario: Scenario = {
  id: "s1",
  title: "t",
  turns: ["a", "b"],
  checks: [
    { id: "c1", text: "asks a question" },
    { id: "c2", text: "creates issue", kind: "tool_called", tool: "Create_Issue" },
    { id: "c3", text: "does not delete", kind: "tool_not_called", tool: "delete" },
  ],
};

function result(toolNames: string[], status: "ok" | "error" = "ok"): ScenarioResult {
  return {
    scenario_id: "s1",
    status,
    turns: [
      { user: "a", assistant: "?", tool_calls: [], tokens: null, latency_ms: 1 },
      {
        user: "b",
        assistant: "done",
        tool_calls: toolNames.map((name) => ({ name, input: "", output_excerpt: "", error: false })),
        tokens: null,
        latency_ms: 1,
      },
    ],
    agent_error: null,
    tool_errors: [],
    error_message: status === "error" ? "timed out" : undefined,
    raw_thoughts_file: "raw/s1.json",
  };
}

describe("evaluateDeterministicChecks", () => {
  it("skips plain-language checks", () => {
    const ids = evaluateDeterministicChecks([scenario], [result([])]).map((v) => v.check_id);
    expect(ids).toEqual(["c2", "c3"]);
  });

  it("matches tool names case-insensitively by substring across all turns", () => {
    const [c2, c3] = evaluateDeterministicChecks([scenario], [result(["jira_create_issue"])]);
    expect(c2).toMatchObject({ verdict: "pass", reason: "called jira_create_issue" });
    expect(c3.verdict).toBe("pass");
  });

  it("matches MCP snake_case names against platform display names", () => {
    const s: Scenario = { ...scenario, checks: [{ id: "c9", text: "checks dna", kind: "tool_called", tool: "get_project_dna" }] };
    expect(evaluateDeterministicChecks([s], [result(["Get Project Dna"])])[0].verdict).toBe("pass");
    expect(normalizeToolName("  Get__Project-Dna ")).toBe("get project dna");
  });

  it("fails tool_not_called when the tool was called", () => {
    const [, c3] = evaluateDeterministicChecks([scenario], [result(["delete_issue"])]);
    expect(c3).toMatchObject({ verdict: "fail", reason: "called delete_issue" });
  });

  it("fails tool_called when nothing matched", () => {
    const [c2] = evaluateDeterministicChecks([scenario], [result([])]);
    expect(c2).toMatchObject({ verdict: "fail", reason: 'no tool matching "Create_Issue" was called' });
  });

  it("marks checks error when the scenario errored or is missing", () => {
    expect(evaluateDeterministicChecks([scenario], [result([], "error")])[0]).toMatchObject({ verdict: "error", reason: "timed out" });
    expect(evaluateDeterministicChecks([scenario], [])[0]).toMatchObject({ verdict: "error", reason: "scenario did not run" });
  });
});
