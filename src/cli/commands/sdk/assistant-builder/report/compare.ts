import type { Verdict } from "../types.js";
import { checkKey, type IterationData } from "./workspace.js";

export type CheckStatus =
  | "fixed"
  | "regressed"
  | "still_failing"
  | "still_passing"
  | "new"
  | "expectation_changed"
  | "not_graded";

export interface ClassifiedCheck {
  scenario_id: string;
  check_id: string;
  text: string;
  status: CheckStatus;
  verdict: Verdict | null;
  reason: string;
}

export interface RoundScore {
  version: number;
  passed: number;
  total: number;
  graded: boolean;
  fixed: string[];
  regressed: string[];
}

function checkTexts(iteration: IterationData): Map<string, string> {
  const texts = new Map<string, string>();
  for (const scenario of iteration.scenarios?.scenarios ?? []) {
    for (const check of scenario.checks) texts.set(checkKey(scenario.id, check.id), check.text);
  }
  return texts;
}

export function classifyIteration(current: IterationData, previous?: IterationData): ClassifiedCheck[] {
  const prevTexts = previous ? checkTexts(previous) : new Map<string, string>();
  const out: ClassifiedCheck[] = [];

  for (const [key, text] of checkTexts(current)) {
    const [scenarioId, checkId] = key.split("/");
    const verdict = current.verdicts?.get(key) ?? null;
    const base = { scenario_id: scenarioId, check_id: checkId, text, verdict: verdict?.verdict ?? null, reason: verdict?.reason ?? "" };

    if (!verdict) {
      out.push({ ...base, status: "not_graded" });
      continue;
    }
    const prevText = prevTexts.get(key);
    if (!previous || prevText === undefined) {
      out.push({ ...base, status: "new" });
      continue;
    }
    if (prevText !== text) {
      out.push({ ...base, status: "expectation_changed" });
      continue;
    }
    const prevPassed = previous.verdicts?.get(key)?.verdict === "pass";
    const nowPassed = verdict.verdict === "pass";
    const status: CheckStatus = nowPassed
      ? prevPassed ? "still_passing" : "fixed"
      : prevPassed ? "regressed" : "still_failing";
    out.push({ ...base, status });
  }
  return out;
}

export function scoreRounds(iterations: IterationData[]): RoundScore[] {
  return iterations.map((iteration, index) => {
    const classified = classifyIteration(iteration, index > 0 ? iterations[index - 1] : undefined);
    const keyOf = (c: ClassifiedCheck): string => checkKey(c.scenario_id, c.check_id);
    return {
      version: iteration.version,
      passed: classified.filter((c) => c.verdict === "pass").length,
      total: classified.length,
      graded: iteration.verdicts !== null,
      fixed: classified.filter((c) => c.status === "fixed").map(keyOf),
      regressed: classified.filter((c) => c.status === "regressed").map(keyOf),
    };
  });
}

export function bestVersion(rounds: RoundScore[]): number | null {
  const graded = rounds.filter((r) => r.graded);
  if (graded.length === 0) return null;
  const best = graded.reduce((a, b) => {
    if (b.passed !== a.passed) return b.passed > a.passed ? b : a;
    if (b.regressed.length !== a.regressed.length) return b.regressed.length < a.regressed.length ? b : a;
    return b.version > a.version ? b : a;
  });
  return best.version;
}
