import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "@/utils/errors.js";
import type { CheckVerdict, ChecksFile, GradingFile, ScenarioFile, ScenarioResult } from "../types.js";

export interface IterationData {
  version: number;
  dir: string;
  scenarios: ScenarioFile | null;
  results: Map<string, ScenarioResult>;
  verdicts: Map<string, CheckVerdict> | null;
  observations: string[];
  change: string | null;
  confirm: Map<string, CheckVerdict> | null;
}

export function checkKey(scenarioId: string, checkId: string): string {
  return `${scenarioId}/${checkId}`;
}

/**
 * Deterministic tool checks win over the grader, except where the grader marked a check
 * blocked or error — a missing integration or a failed run is not a prompt failure.
 */
export function mergeVerdicts(deterministic: CheckVerdict[], graded: CheckVerdict[]): Map<string, CheckVerdict> {
  const merged = new Map<string, CheckVerdict>();
  for (const verdict of graded) merged.set(checkKey(verdict.scenario_id, verdict.check_id), verdict);
  for (const verdict of deterministic) {
    const key = checkKey(verdict.scenario_id, verdict.check_id);
    const gradedVerdict = merged.get(key)?.verdict;
    if (gradedVerdict === "blocked" || gradedVerdict === "error") continue;
    merged.set(key, verdict);
  }
  return merged;
}

/** A check only counts as passing when it also passed on the all-pass confirmation run. */
function applyConfirmation(verdicts: Map<string, CheckVerdict>, confirm: Map<string, CheckVerdict>): void {
  for (const [key, confirmed] of confirm) {
    const original = verdicts.get(key);
    if (original?.verdict === "pass" && confirmed.verdict !== "pass") {
      verdicts.set(key, { ...confirmed, reason: `failed on confirmation run: ${confirmed.reason}` });
    }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function loadVerdicts(dir: string): Promise<{ verdicts: Map<string, CheckVerdict> | null; observations: string[] }> {
  const grading = await readJson<GradingFile>(join(dir, "grading.json"));
  if (!grading) return { verdicts: null, observations: [] };
  const checks = await readJson<ChecksFile>(join(dir, "checks.json"));
  return {
    verdicts: mergeVerdicts(checks?.checks ?? [], grading.checks ?? []),
    observations: grading.observations ?? [],
  };
}

async function loadResults(dir: string): Promise<Map<string, ScenarioResult>> {
  const results = new Map<string, ScenarioResult>();
  let files: string[] = [];
  try {
    files = await readdir(join(dir, "results"));
  } catch {
    return results;
  }
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const result = await readJson<ScenarioResult>(join(dir, "results", file));
    if (result) results.set(result.scenario_id, result);
  }
  return results;
}

export async function loadWorkspace(dir: string): Promise<IterationData[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(join(dir, "iterations"));
  } catch {
    entries = [];
  }
  const versions = entries
    .map((name) => /^v(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  if (versions.length === 0) {
    throw new ConfigurationError(`No iterations found under ${join(dir, "iterations")}`);
  }

  const iterations: IterationData[] = [];
  for (const version of versions) {
    const iterDir = join(dir, "iterations", `v${version}`);
    const { verdicts, observations } = await loadVerdicts(iterDir);
    const confirm = await loadVerdicts(join(iterDir, "confirm"));
    if (verdicts && confirm.verdicts) {
      applyConfirmation(verdicts, confirm.verdicts);
    }
    iterations.push({
      version,
      dir: iterDir,
      scenarios: await readJson<ScenarioFile>(join(iterDir, "scenarios.json")),
      results: await loadResults(iterDir),
      verdicts,
      observations,
      change: await readText(join(iterDir, "change.md")),
      confirm: confirm.verdicts,
    });
  }
  return iterations;
}
