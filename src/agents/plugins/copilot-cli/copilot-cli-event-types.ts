/**
 * Shapes for GitHub Copilot CLI local session state.
 *
 * Two sources per session directory (`~/.copilot/session-state/<uuid>/`):
 * - `workspace.yaml` — manifest; present in every session directory
 * - `events.jsonl`   — transcript; present only from the schema-bearing CLI versions
 *
 * The `events.jsonl` schema is undocumented by GitHub. Every field is therefore optional
 * and every consumer must degrade rather than throw.
 */

/** Parsed `~/.copilot/session-state/<uuid>/workspace.yaml`. */
export interface CopilotWorkspaceManifest {
  id: string;
  cwd?: string;
  gitRoot?: string;
  repository?: string;
  hostType?: string;
  branch?: string;
  name?: string;
  /** Epoch ms. */
  createdAt?: number;
  /** Epoch ms. */
  updatedAt?: number;
}

/** Raw `workspace.yaml` key shape, before camelCase normalization. */
export interface RawWorkspaceYaml {
  id?: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  host_type?: string;
  branch?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

/** One line of `events.jsonl`. */
export interface CopilotEvent {
  type?: string;
  data?: unknown;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
}

/**
 * Per-model usage buckets exactly as Copilot writes them.
 *
 * These follow the OpenAI convention: `inputTokens` is INCLUSIVE of `cacheReadTokens`,
 * and `reasoningTokens` is a subset of `outputTokens`. Copilot applies that convention to
 * every provider it proxies, including Anthropic models. Conversion into the repository's
 * Anthropic-convention `TokenUsage` happens in exactly one place — `readCopilotCli` in
 * `src/cli/commands/analytics/cost/usage-readers.ts`.
 */
export interface CopilotUsageBuckets {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** `data` of a `session.shutdown` event — the authoritative per-model usage rollup. */
export interface CopilotShutdownData {
  shutdownType?: string;
  /** GitHub's actual billing unit; does not track token volume. */
  totalPremiumRequests?: number;
  totalApiDurationMs?: number;
  codeChanges?: {
    linesAdded?: number;
    linesRemoved?: number;
    filesModified?: string[];
  };
  modelMetrics?: Record<
    string,
    {
      requests?: { count?: number; cost?: number };
      usage?: CopilotUsageBuckets;
    }
  >;
}

/** `data` of a `session.start` event. */
export interface CopilotSessionStartData {
  sessionId?: string;
  copilotVersion?: string;
  producer?: string;
  startTime?: string;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
    headCommit?: string;
    repository?: string;
    hostType?: string;
  };
}

/** `data` of an `assistant.message` event — the per-turn fallback token source. */
export interface CopilotAssistantMessageData {
  messageId?: string;
  model?: string;
  turnId?: string;
  /** Present per turn; sums exactly to the shutdown rollup's `outputTokens`. */
  outputTokens?: number;
  requestId?: string;
  toolRequests?: Array<{ toolCallId?: string; name?: string; arguments?: unknown }>;
}

/** `data` of a `tool.execution_complete` event. */
export interface CopilotToolCompleteData {
  toolCallId?: string;
  name?: string;
  status?: string;
  error?: unknown;
  arguments?: { path?: string };
}

/** `data` of a `skill.invoked` event — feeds the report's session-source classification. */
export interface CopilotSkillInvokedData {
  skill?: string;
  name?: string;
}
