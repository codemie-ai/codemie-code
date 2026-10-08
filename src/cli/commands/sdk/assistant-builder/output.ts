import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioRun } from "./runner.js";
import type { CheckVerdict, RunSummary, ScenarioFile } from "./types.js";

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function buildRunSummary(
  assistantId: string,
  version: number | null,
  startedAt: Date,
  finishedAt: Date,
  runs: ScenarioRun[],
): RunSummary {
  const errors = runs.filter((r) => r.result.status === "error").length;
  return {
    assistant_id: assistantId,
    version,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    total: runs.length,
    ok: runs.length - errors,
    errors,
  };
}

export async function writeRunOutput(
  outDir: string,
  input: { scenarioFile: ScenarioFile; runs: ScenarioRun[]; checks: CheckVerdict[]; summary: RunSummary },
): Promise<void> {
  await mkdir(join(outDir, "results"), { recursive: true });
  await mkdir(join(outDir, "raw"), { recursive: true });

  for (const run of input.runs) {
    await writeJson(join(outDir, "results", `${run.result.scenario_id}.json`), run.result);
    await writeJson(join(outDir, "raw", `${run.result.scenario_id}.json`), run.rawThoughts);
  }
  await writeJson(join(outDir, "scenarios.json"), input.scenarioFile);
  await writeJson(join(outDir, "checks.json"), { checks: input.checks });
  await writeJson(join(outDir, "run.json"), input.summary);
}
