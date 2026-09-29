import { bestVersion, classifyIteration, scoreRounds, type ClassifiedCheck, type RoundScore } from "./compare.js";
import { checkKey, type IterationData } from "./workspace.js";

export interface VerdictCounts {
  pass: number;
  fail: number;
  error: number;
  blocked: number;
  not_graded: number;
}

export interface ReportSummary {
  latest_version: number;
  best_version: number | null;
  rounds: RoundScore[];
  latest: {
    passed: number;
    total: number;
    fixed: string[];
    regressed: string[];
    still_failing: string[];
    not_graded: number;
    counts: VerdictCounts;
  };
  confirmation: { passed: number; total: number } | null;
  observations: string[];
}

export function buildReportSummary(iterations: IterationData[]): ReportSummary {
  const rounds = scoreRounds(iterations);
  const latest = iterations[iterations.length - 1];
  const previous = iterations.length > 1 ? iterations[iterations.length - 2] : undefined;
  const classified = classifyIteration(latest, previous);
  const keys = (filter: (c: ClassifiedCheck) => boolean): string[] =>
    classified.filter(filter).map((c) => checkKey(c.scenario_id, c.check_id));

  const confirmVerdicts = latest.confirm ? [...latest.confirm.values()] : null;

  return {
    latest_version: latest.version,
    best_version: bestVersion(rounds),
    rounds,
    latest: {
      passed: classified.filter((c) => c.verdict === "pass").length,
      total: classified.length,
      fixed: keys((c) => c.status === "fixed"),
      regressed: keys((c) => c.status === "regressed"),
      still_failing: keys((c) => c.verdict !== null && c.verdict !== "pass" && c.status !== "regressed"),
      not_graded: classified.filter((c) => c.status === "not_graded").length,
      counts: {
        pass: classified.filter((c) => c.verdict === "pass").length,
        fail: classified.filter((c) => c.verdict === "fail").length,
        error: classified.filter((c) => c.verdict === "error").length,
        blocked: classified.filter((c) => c.verdict === "blocked").length,
        not_graded: classified.filter((c) => c.verdict === null).length,
      },
    },
    confirmation: confirmVerdicts
      ? { passed: confirmVerdicts.filter((v) => v.verdict === "pass").length, total: confirmVerdicts.length }
      : null,
    observations: latest.observations,
  };
}

export function formatTerminalSummary(summary: ReportSummary, failures: ClassifiedCheck[]): string {
  const lines: string[] = [];
  lines.push(`Rounds: ${summary.rounds.map((r) => `v${r.version} ${r.graded ? `${r.passed}/${r.total}` : "not graded"}`).join(" → ")}`);
  lines.push(`Latest v${summary.latest_version}: ${summary.latest.passed}/${summary.latest.total} checks pass` +
    (summary.best_version !== null ? ` · best v${summary.best_version}` : ""));
  if (summary.confirmation) {
    lines.push(`Confirmation run: ${summary.confirmation.passed}/${summary.confirmation.total}`);
  }
  if (summary.latest.fixed.length) lines.push(`Fixed: ${summary.latest.fixed.join(", ")}`);
  if (summary.latest.regressed.length) lines.push(`Regressed: ${summary.latest.regressed.join(", ")}`);
  if (summary.latest.still_failing.length) lines.push(`Still failing: ${summary.latest.still_failing.join(", ")}`);
  if (summary.latest.not_graded) lines.push(`Not graded: ${summary.latest.not_graded}`);
  for (const failure of failures.slice(0, 3)) {
    lines.push(`  ✗ ${failure.scenario_id}/${failure.check_id} — ${failure.text}: ${failure.reason}`);
  }
  return lines.join("\n");
}
