import type { BaseModelResponse } from "codemie-sdk";
import { CodeMieError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";
import type { ChatTurnInput } from "../services/assistants.js";
import { generatedToText, thoughtsToToolCalls } from "./normalize.js";
import type { HistoryEntry, NormalizedTurn, Scenario, ScenarioResult } from "./types.js";

const MAX_CONCURRENCY = 8;
const DEFAULT_RETRY_DELAY_MS = 2000;

export class TurnTimeoutError extends CodeMieError {
  constructor(timeoutMs: number) {
    super(`Assistant turn timed out after ${timeoutMs} ms`);
    this.name = "TurnTimeoutError";
  }
}

export interface RunnerDeps {
  chat: (input: ChatTurnInput) => Promise<BaseModelResponse>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  timeoutMs: number;
  concurrency: number;
  version?: number;
  retryDelayMs?: number;
}

export interface TurnOutcome {
  turn: NormalizedTurn;
  response: BaseModelResponse;
}

export interface ScenarioRun {
  result: ScenarioResult;
  rawThoughts: unknown[];
}

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

export function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status = typeof record.statusCode === "number" ? record.statusCode : record.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTurn(
  deps: RunnerDeps,
  message: string,
  history: HistoryEntry[],
  opts: RunOptions,
): Promise<TurnOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const input: ChatTurnInput = { message, history, version: opts.version };
  const started = now();

  let response: BaseModelResponse;
  try {
    response = await withTimeout(deps.chat(input), opts.timeoutMs);
  } catch (error) {
    if (!isRetryable(error)) throw error;
    logger.debug("Retrying assistant turn after retryable error", { message: String(error) });
    await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    response = await withTimeout(deps.chat(input), opts.timeoutMs);
  }

  return {
    response,
    turn: {
      user: message,
      assistant: generatedToText(response.generated),
      tool_calls: thoughtsToToolCalls(response.thoughts),
      tokens: typeof response.tokens_used === "number" ? response.tokens_used : null,
      latency_ms: now() - started,
    },
  };
}

export async function runScenario(
  scenario: Scenario,
  deps: RunnerDeps,
  opts: RunOptions,
): Promise<ScenarioRun> {
  const history: HistoryEntry[] = [];
  const turns: NormalizedTurn[] = [];
  const rawThoughts: unknown[] = [];
  const toolErrors: unknown[] = [];
  const result: ScenarioResult = {
    scenario_id: scenario.id,
    status: "ok",
    turns,
    agent_error: null,
    tool_errors: toolErrors,
    raw_thoughts_file: `raw/${scenario.id}.json`,
  };

  for (const message of scenario.turns) {
    try {
      const { turn, response } = await runTurn(deps, message, [...history], opts);
      turns.push(turn);
      rawThoughts.push(response.thoughts ?? []);
      toolErrors.push(...(response.tool_errors ?? []));
      if (response.agent_error) {
        result.status = "error";
        result.agent_error = response.agent_error;
        result.error_message = "Assistant reported an agent error";
        break;
      }
      history.push({ role: "User", message }, { role: "Assistant", message: turn.assistant });
    } catch (error) {
      result.status = "error";
      result.error_message = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  return { result, rawThoughts };
}

export async function runScenarios(
  scenarios: Scenario[],
  deps: RunnerDeps,
  opts: RunOptions,
  onDone?: (run: ScenarioRun) => void,
): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = new Array(scenarios.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < scenarios.length) {
      const index = next++;
      const run = await runScenario(scenarios[index], deps, opts);
      runs[index] = run;
      onDone?.(run);
    }
  };

  const workers = Array.from({ length: Math.min(clampConcurrency(opts.concurrency), scenarios.length) }, worker);
  await Promise.all(workers);
  return runs;
}
