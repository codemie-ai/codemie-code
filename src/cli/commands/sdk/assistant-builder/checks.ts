import type { CheckVerdict, Scenario, ScenarioResult } from "./types.js";

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

export function evaluateDeterministicChecks(
  scenarios: Scenario[],
  results: ScenarioResult[],
): CheckVerdict[] {
  const resultsById = new Map(results.map((r) => [r.scenario_id, r]));
  const verdicts: CheckVerdict[] = [];

  for (const scenario of scenarios) {
    for (const check of scenario.checks) {
      if (!check.kind || !check.tool) continue;
      const base = { scenario_id: scenario.id, check_id: check.id };
      const result = resultsById.get(scenario.id);

      if (!result || result.status === "error") {
        verdicts.push({ ...base, verdict: "error", reason: result?.error_message ?? "scenario did not run" });
        continue;
      }

      const needle = normalizeToolName(check.tool);
      const hit = result.turns
        .flatMap((turn) => turn.tool_calls)
        .find((call) => normalizeToolName(call.name).includes(needle));
      const called = hit !== undefined;
      const passed = check.kind === "tool_called" ? called : !called;

      verdicts.push({
        ...base,
        verdict: passed ? "pass" : "fail",
        reason: hit ? `called ${hit.name}` : `no tool matching "${check.tool}" was called`,
      });
    }
  }

  return verdicts;
}
