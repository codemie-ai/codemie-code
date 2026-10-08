import { describe, it, expect, vi } from "vitest";
import { ApiError } from "codemie-sdk";
import {
  runScenario,
  runScenarios,
  runTurn,
  clampConcurrency,
  isRetryable,
  type RunnerDeps,
  type RunOptions,
} from "../runner.js";
import type { Scenario } from "../types.js";

const opts: RunOptions = { timeoutMs: 50, concurrency: 3, retryDelayMs: 0 };
const noSleep = (): Promise<void> => Promise.resolve();

function scenario(id: string, turns: string[]): Scenario {
  return { id, title: id, turns, checks: [{ id: "c1", text: "x" }] };
}

describe("runScenario", () => {
  it("replays turns and builds history from real answers", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ generated: "Which project?", thoughts: [], tokens_used: 10 })
      .mockResolvedValueOnce({
        generated: "Created ABC-1",
        thoughts: [{ author_type: "Tool", author_name: "create_issue", message: "ok" }],
        tokens_used: 20,
      });
    const run = await runScenario(scenario("s1", ["File a bug", "ABC"]), { chat, sleep: noSleep }, opts);

    expect(chat.mock.calls[1][0].history).toEqual([
      { role: "User", message: "File a bug" },
      { role: "Assistant", message: "Which project?" },
    ]);
    expect(run.result.status).toBe("ok");
    expect(run.result.turns.map((t) => t.assistant)).toEqual(["Which project?", "Created ABC-1"]);
    expect(run.result.turns[1].tool_calls[0].name).toBe("create_issue");
    expect(run.result.raw_thoughts_file).toBe("raw/s1.json");
    expect(run.rawThoughts).toHaveLength(2);
  });

  it("marks the scenario error when the platform reports agent_error, keeping the turn", async () => {
    const chat = vi.fn().mockResolvedValue({ generated: "", agent_error: { message: "boom" } });
    const run = await runScenario(scenario("s1", ["hi", "again"]), { chat, sleep: noSleep }, opts);
    expect(run.result.status).toBe("error");
    expect(run.result.turns).toHaveLength(1);
    expect(run.result.agent_error).toEqual({ message: "boom" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("times out a hung turn and records an error", async () => {
    const chat = vi.fn(() => new Promise<never>(() => undefined));
    const run = await runScenario(scenario("s1", ["hi"]), { chat, sleep: noSleep }, opts);
    expect(run.result.status).toBe("error");
    expect(run.result.error_message).toMatch(/timed out after 50 ms/);
  });
});

describe("runTurn retry", () => {
  it("retries once on 5xx", async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("server", 502))
      .mockResolvedValueOnce({ generated: "ok" });
    const outcome = await runTurn({ chat, sleep: noSleep }, "hi", [], opts);
    expect(outcome.turn.assistant).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx other than 429", async () => {
    const chat = vi.fn().mockRejectedValue(new ApiError("bad", 400));
    await expect(runTurn({ chat, sleep: noSleep }, "hi", [], opts)).rejects.toThrow("bad");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("classifies retryable errors", () => {
    expect(isRetryable(new ApiError("x", 429))).toBe(true);
    expect(isRetryable(new ApiError("x", 500))).toBe(true);
    expect(isRetryable(new ApiError("x", 404))).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});

describe("runScenarios", () => {
  it("keeps input order, isolates failures, and respects concurrency", async () => {
    let active = 0;
    let peak = 0;
    const deps: RunnerDeps = {
      sleep: noSleep,
      chat: async ({ message }) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (message === "fail") throw new ApiError("bad request", 400);
        return { generated: `echo ${message}` };
      },
    };
    const list = ["a", "fail", "c", "d", "e"].map((m, i) => scenario(`s${i}`, [m]));
    const done: string[] = [];
    const runs = await runScenarios(list, deps, { ...opts, concurrency: 2 }, (r) => done.push(r.result.scenario_id));

    expect(runs.map((r) => r.result.scenario_id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(runs[1].result.status).toBe("error");
    expect(runs.filter((r) => r.result.status === "ok")).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(done).toHaveLength(5);
  });

  it("clamps concurrency to 1..8", () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(20)).toBe(8);
    expect(clampConcurrency(3)).toBe(3);
  });
});
