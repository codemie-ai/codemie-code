import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace, mergeVerdicts, checkKey, type IterationData } from "../report/workspace.js";
import { classifyIteration, scoreRounds, bestVersion } from "../report/compare.js";
import type { CheckVerdict, ScenarioFile } from "../types.js";

function scenarios(c2Text = "creates issue"): ScenarioFile {
  return {
    scenarios: [
      { id: "s1", title: "t", turns: ["a"], checks: [{ id: "c1", text: "asks" }, { id: "c2", text: c2Text }] },
    ],
  };
}

function v(scenario: string, check: string, verdict: CheckVerdict["verdict"]): CheckVerdict {
  return { scenario_id: scenario, check_id: check, verdict, reason: verdict };
}

function iteration(version: number, verdicts: CheckVerdict[] | null, file = scenarios()): IterationData {
  return {
    version,
    dir: `/w/iterations/v${version}`,
    scenarios: file,
    results: new Map(),
    verdicts: verdicts ? new Map(verdicts.map((x) => [checkKey(x.scenario_id, x.check_id), x])) : null,
    observations: [],
    change: null,
    confirm: null,
  };
}

describe("mergeVerdicts", () => {
  it("keeps graded blocked/error verdicts over deterministic ones", () => {
    const merged = mergeVerdicts([v("s1", "c2", "fail")], [v("s1", "c2", "blocked")]);
    expect(merged.get("s1/c2")?.verdict).toBe("blocked");
  });

  it("lets deterministic verdicts override graded ones", () => {
    const merged = mergeVerdicts([v("s1", "c2", "fail")], [v("s1", "c2", "pass"), v("s1", "c1", "pass")]);
    expect(merged.get("s1/c2")?.verdict).toBe("fail");
    expect(merged.get("s1/c1")?.verdict).toBe("pass");
  });
});

describe("classifyIteration", () => {
  it("marks everything new without a previous round", () => {
    const out = classifyIteration(iteration(1, [v("s1", "c1", "pass"), v("s1", "c2", "fail")]));
    expect(out.map((c) => c.status)).toEqual(["new", "new"]);
  });

  it("detects fixed, regressed, still passing, still failing", () => {
    const prev = iteration(1, [v("s1", "c1", "pass"), v("s1", "c2", "fail")]);
    expect(classifyIteration(iteration(2, [v("s1", "c1", "fail"), v("s1", "c2", "pass")]), prev).map((c) => c.status))
      .toEqual(["regressed", "fixed"]);
    expect(classifyIteration(iteration(2, [v("s1", "c1", "pass"), v("s1", "c2", "error")]), prev).map((c) => c.status))
      .toEqual(["still_passing", "still_failing"]);
  });

  it("reports expectation_changed when check text differs", () => {
    const prev = iteration(1, [v("s1", "c1", "pass"), v("s1", "c2", "fail")]);
    const cur = iteration(2, [v("s1", "c1", "pass"), v("s1", "c2", "pass")], scenarios("creates a bug issue"));
    expect(classifyIteration(cur, prev)[1].status).toBe("expectation_changed");
  });

  it("reports not_graded when grading is missing", () => {
    expect(classifyIteration(iteration(2, null)).map((c) => c.status)).toEqual(["not_graded", "not_graded"]);
  });
});

describe("scoreRounds / bestVersion", () => {
  it("scores rounds and picks the best graded version", () => {
    const rounds = scoreRounds([
      iteration(1, [v("s1", "c1", "pass"), v("s1", "c2", "fail")]),
      iteration(2, [v("s1", "c1", "pass"), v("s1", "c2", "pass")]),
      iteration(3, [v("s1", "c1", "fail"), v("s1", "c2", "pass")]),
      iteration(4, null),
    ]);
    expect(rounds.map((r) => [r.version, r.passed, r.graded])).toEqual([[1, 1, true], [2, 2, true], [3, 1, true], [4, 0, false]]);
    expect(rounds[2].regressed).toEqual(["s1/c1"]);
    expect(bestVersion(rounds)).toBe(2);
  });

  it("returns null when nothing is graded", () => {
    expect(bestVersion(scoreRounds([iteration(1, null)]))).toBeNull();
  });
});

describe("loadWorkspace", () => {
  it("reads iterations in numeric order and tolerates missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-"));
    for (const n of [10, 2]) {
      const dir = join(root, "iterations", `v${n}`);
      await mkdir(join(dir, "results"), { recursive: true });
      await writeFile(join(dir, "scenarios.json"), JSON.stringify(scenarios()));
      await writeFile(join(dir, "checks.json"), JSON.stringify({ checks: [] }));
    }
    await writeFile(
      join(root, "iterations", "v2", "grading.json"),
      JSON.stringify({ checks: [v("s1", "c1", "pass")], observations: ["ok"] }),
    );
    const its = await loadWorkspace(root);
    expect(its.map((i) => i.version)).toEqual([2, 10]);
    expect(its[0].verdicts?.get("s1/c1")?.verdict).toBe("pass");
    expect(its[0].observations).toEqual(["ok"]);
    expect(its[1].verdicts).toBeNull();
  });

  it("downgrades a pass that failed on the confirmation run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-"));
    const dir = join(root, "iterations", "v1");
    await mkdir(join(dir, "confirm"), { recursive: true });
    await writeFile(join(dir, "scenarios.json"), JSON.stringify(scenarios()));
    await writeFile(join(dir, "grading.json"), JSON.stringify({ checks: [v("s1", "c1", "pass"), v("s1", "c2", "pass")], observations: [] }));
    await writeFile(
      join(dir, "confirm", "grading.json"),
      JSON.stringify({ checks: [v("s1", "c1", "pass"), { ...v("s1", "c2", "fail"), reason: "skipped the tool" }], observations: [] }),
    );
    const [it1] = await loadWorkspace(root);
    expect(it1.verdicts?.get("s1/c1")?.verdict).toBe("pass");
    expect(it1.verdicts?.get("s1/c2")).toMatchObject({ verdict: "fail", reason: "failed on confirmation run: skipped the tool" });
    expect(it1.confirm?.get("s1/c2")?.verdict).toBe("fail");
  });

  it("throws a ConfigurationError for a folder with no iterations", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-"));
    await expect(loadWorkspace(root)).rejects.toThrow(/No iterations found/);
  });
});
