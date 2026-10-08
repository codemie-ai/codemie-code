import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunOutput, buildRunSummary } from "../output.js";
import type { ScenarioRun } from "../runner.js";

const run: ScenarioRun = {
  result: {
    scenario_id: "s1",
    status: "ok",
    turns: [{ user: "a", assistant: "b", tool_calls: [], tokens: 5, latency_ms: 10 }],
    agent_error: null,
    tool_errors: [],
    raw_thoughts_file: "raw/s1.json",
  },
  rawThoughts: [[{ author_type: "Agent" }]],
};

describe("writeRunOutput", () => {
  it("writes results, raw thoughts, scenario snapshot, checks and run summary", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "run-")), "v3");
    const scenarioFile = { scenarios: [{ id: "s1", title: "t", turns: ["a"], checks: [{ id: "c1", text: "x" }] }] };
    const summary = buildRunSummary("id-1", 3, new Date(0), new Date(1000), [run]);
    await writeRunOutput(out, {
      scenarioFile,
      runs: [run],
      checks: [{ scenario_id: "s1", check_id: "c1", verdict: "pass", reason: "r" }],
      summary,
    });

    expect((await readdir(join(out, "results")))).toEqual(["s1.json"]);
    expect(JSON.parse(await readFile(join(out, "results", "s1.json"), "utf-8")).turns[0].assistant).toBe("b");
    expect(JSON.parse(await readFile(join(out, "raw", "s1.json"), "utf-8"))).toEqual(run.rawThoughts);
    expect(JSON.parse(await readFile(join(out, "scenarios.json"), "utf-8"))).toEqual(scenarioFile);
    expect(JSON.parse(await readFile(join(out, "checks.json"), "utf-8")).checks).toHaveLength(1);
    expect(JSON.parse(await readFile(join(out, "run.json"), "utf-8"))).toMatchObject({
      assistant_id: "id-1", version: 3, total: 1, ok: 1, errors: 0,
    });
  });
});
