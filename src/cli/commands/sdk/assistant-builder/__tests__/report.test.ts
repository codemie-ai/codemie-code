import { describe, it, expect } from "vitest";
import { buildReportSummary, formatTerminalSummary } from "../report/summary.js";
import { escapeHtml, renderHtmlReport } from "../report/html.js";
import { checkKey, type IterationData } from "../report/workspace.js";
import type { CheckVerdict, ScenarioResult } from "../types.js";

function it2(version: number, verdicts: CheckVerdict[] | null, answer = "ok"): IterationData {
  const result: ScenarioResult = {
    scenario_id: "s1",
    status: "ok",
    turns: [{ user: "hi", assistant: answer, tool_calls: [{ name: "create_issue", input: "", output_excerpt: "", error: false }], tokens: 3, latency_ms: 9 }],
    agent_error: null,
    tool_errors: [],
    raw_thoughts_file: "raw/s1.json",
  };
  return {
    version,
    dir: `/w/v${version}`,
    scenarios: { scenarios: [{ id: "s1", title: "Scenario one", turns: ["hi"], checks: [{ id: "c1", text: "asks" }, { id: "c2", text: "files" }] }] },
    results: new Map([["s1", result]]),
    verdicts: verdicts ? new Map(verdicts.map((x) => [checkKey(x.scenario_id, x.check_id), x])) : null,
    observations: ["too verbose"],
    change: version > 1 ? "Tightened tone" : null,
    confirm: null,
  };
}

const pass = (c: string): CheckVerdict => ({ scenario_id: "s1", check_id: c, verdict: "pass", reason: "fine" });
const fail = (c: string): CheckVerdict => ({ scenario_id: "s1", check_id: c, verdict: "fail", reason: "missed it" });

describe("buildReportSummary", () => {
  it("summarizes latest round against previous and picks best", () => {
    const s = buildReportSummary([it2(1, [pass("c1"), fail("c2")]), it2(2, [fail("c1"), pass("c2")])]);
    expect(s.latest_version).toBe(2);
    expect(s.latest).toMatchObject({ passed: 1, total: 2, fixed: ["s1/c2"], regressed: ["s1/c1"], still_failing: [] });
    expect(s.best_version).toBe(1);
  });

  it("counts verdict types for the latest round", () => {
    const blocked: CheckVerdict = { scenario_id: "s1", check_id: "c2", verdict: "blocked", reason: "no integration" };
    const s = buildReportSummary([it2(1, [pass("c1"), blocked])]);
    expect(s.latest.counts).toEqual({ pass: 1, fail: 0, error: 0, blocked: 1, not_graded: 0 });
  });

  it("handles a single ungraded iteration", () => {
    const s = buildReportSummary([it2(1, null)]);
    expect(s.best_version).toBeNull();
    expect(s.latest.not_graded).toBe(2);
  });
});

describe("formatTerminalSummary", () => {
  it("lists regressions before other failures", () => {
    const iterations = [it2(1, [pass("c1"), fail("c2")]), it2(2, [fail("c1"), fail("c2")])];
    const text = formatTerminalSummary(buildReportSummary(iterations), []);
    expect(text).toContain("v2");
    expect(text.indexOf("Regressed")).toBeLessThan(text.indexOf("Still failing"));
  });
});

describe("html report", () => {
  it("never puts an unknown verdict into markup", () => {
    const evil = { scenario_id: "s1", check_id: "c1", verdict: 'pass"><img src=x onerror=alert(1)>', reason: "r" } as unknown as CheckVerdict;
    const iterations = [it2(1, [evil, pass("c2")])];
    const html = renderHtmlReport({ assistantName: "A", summary: buildReportSummary(iterations), iterations });
    expect(html).not.toContain("<img src=x");
  });

  it("escapes assistant output", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    const iterations = [it2(1, [pass("c1"), pass("c2")], "<script>alert(1)</script>")];
    const html = renderHtmlReport({ assistantName: "Bug <Bot>", summary: buildReportSummary(iterations), iterations });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Bug &lt;Bot&gt;");
    expect(html).toContain("create_issue");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });
});
