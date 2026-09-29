export type CheckKind = "tool_called" | "tool_not_called";

export interface ScenarioCheck {
  id: string;
  text: string;
  kind?: CheckKind;
  tool?: string;
}

export interface Scenario {
  id: string;
  title: string;
  turns: string[];
  checks: ScenarioCheck[];
  added_in?: number;
  origin?: string;
  source_conversation?: string;
}

export interface ScenarioFile {
  scenarios: Scenario[];
}

export interface HistoryEntry {
  role: "User" | "Assistant";
  message: string;
}

export interface ToolCall {
  name: string;
  input: string;
  output_excerpt: string;
  error: boolean;
}

export interface NormalizedTurn {
  user: string;
  assistant: string;
  tool_calls: ToolCall[];
  tokens: number | null;
  latency_ms: number;
}

export type ScenarioStatus = "ok" | "error";

export interface ScenarioResult {
  scenario_id: string;
  status: ScenarioStatus;
  turns: NormalizedTurn[];
  agent_error: unknown;
  tool_errors: unknown[];
  error_message?: string;
  raw_thoughts_file: string;
}

export type Verdict = "pass" | "fail" | "error" | "blocked";

export interface CheckVerdict {
  scenario_id: string;
  check_id: string;
  verdict: Verdict;
  reason: string;
}

export interface ChecksFile {
  checks: CheckVerdict[];
}

export interface GradingFile {
  checks: CheckVerdict[];
  observations: string[];
}

export interface RunSummary {
  assistant_id: string;
  version: number | null;
  started_at: string;
  finished_at: string;
  total: number;
  ok: number;
  errors: number;
}
