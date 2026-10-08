import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { AgentAdapterType, type OtlpAdapterDeps } from './types.js';
import { resolveStoryFor } from './story-resolver.js';

export type ForwardDecision<TBlockOutput = Record<string, unknown>> =
  | { decision: 'forward'; payload: Record<string, unknown>[] }
  | { decision: 'block'; reason: string; hookSpecificOutput: TBlockOutput };

export interface OtlpHookContext {
  cwd: string;
  /** Only for prompt-submit style events; enables the marker/mention story tiers. */
  prompt?: string;
}

/** Fields resolved by the base class at hook time, shared by every agent. */
const COMMON_FIELD_KEYS = ['git_branch', 'repo_remote', 'story_id', 'story_source'] as const;

/**
 * Base class for adapters that ingest a coding tool's native hook events into the
 * analytics spool. Owns the fixed flow (parse, allowlist gate, daemon start, evaluate,
 * common-field enrichment, spool forward); subclasses supply the tool-specific parts.
 *
 * Common fields are resolved here, in the short-lived hook process, because the
 * forwarder runs in a long-lived daemon whose environment is frozen at spawn time.
 */
export abstract class OtlpAgentAdapter<TInput = unknown, TBlockOutput = Record<string, unknown>> {
  abstract readonly name: string;
  readonly type = AgentAdapterType.OTLP;

  public async processOtlpEvent(rawHookInput: string, deps: OtlpAdapterDeps): Promise<void> {
    const { ensureOtlpProxy, forwardOtlpEventToSpool } = deps;
    // JSON.parse failures intentionally propagate to the caller.
    const hookInput = this.parseHookInput(rawHookInput);
    if (hookInput === null) {
      logger.debug(`[${this.name}] hook payload has an unknown shape, ignoring`);
      return;
    }

    // INVARIANT - do not weaken. An untracked project must produce NO hooks data
    // in the daemon spool, must not start the daemon, and must not run the SSO
    // check. The daemon has no allowlist of its own. Its completeness gate
    // (`otlp-spool/completeness-gate.ts`) only sends sessions that have hooks
    // data, and skips sessions that only have OTEL data. Forwarding a hook event
    // for an untracked project would make the session sendable and leak its
    // data to the backend.
    if (!(await this.isTracked(hookInput))) {
      logger.debug(`[${this.name}] project not in analytics allowlist, ignoring hook event`);
      return;
    }

    await ensureOtlpProxy(this.name);

    const decision = await this.evaluate(hookInput);
    if (decision.decision === 'block') {
      logger.error(`[${this.name}] Blocking prompt: ${decision.reason}`);
      // Claude Code hook protocol: a blocking decision is returned as JSON on stdout.
      // A new adapter whose tool uses a different block protocol must make this step
      // overridable (e.g. an `emitBlock()` method) instead of reusing it as is.
      console.log(JSON.stringify(decision));
      return;
    }

    const context = this.extractHookContext(hookInput);
    const commonFields = await this.resolveCommonFields(context);
    const agentFields = await this.resolveAgentCommonFields();

    for (const hookEvent of decision.payload) {
      // Intentionally not awaited: forwardOtlpEventToSpool never throws,
      // and awaiting would put daemon latency on the hook path.
      void forwardOtlpEventToSpool({ ...this.mergeCommonFields(hookEvent, commonFields), ...agentFields }, this.name);
    }
  }

  /** Returns null to ignore a payload of an unknown shape. May throw on malformed JSON. */
  protected abstract parseHookInput(raw: string): TInput | null;
  protected abstract extractHookContext(input: TInput): OtlpHookContext;
  /** Allowlist gate; evaluated before the daemon is started. */
  protected abstract isTracked(input: TInput): Promise<boolean>;
  protected abstract evaluate(input: TInput): Promise<ForwardDecision<TBlockOutput>>;
  /** Agent-owned fields (platform, version, entrypoint, ...); override everything else. */
  protected abstract resolveAgentCommonFields(): Promise<Record<string, unknown>>;

  private async resolveCommonFields({ cwd, prompt }: OtlpHookContext): Promise<Record<(typeof COMMON_FIELD_KEYS)[number], string>> {
    const empty = { git_branch: '', repo_remote: '', story_id: '', story_source: '' };
    try {
      const [branch, remote] = cwd
        ? await Promise.all([detectGitBranch(cwd), detectGitRemoteRepo(cwd)])
        : [undefined, undefined];
      const story = await resolveStoryFor({ cwd, branch, prompt });
      return {
        git_branch: branch ?? '',
        repo_remote: remote ?? '',
        story_id: story?.storyId ?? '',
        story_source: story?.storySource ?? '',
      };
    } catch (error) {
      logger.debug(`[${this.name}] common field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  }

  /** A hook event's own non-empty string value wins; otherwise the base value is used. */
  private mergeCommonFields(hookEvent: Record<string, unknown>, commonFields: Record<string, string>): Record<string, unknown> {
    const merged = { ...hookEvent };
    for (const key of COMMON_FIELD_KEYS) {
      const own = hookEvent[key];
      merged[key] = typeof own === 'string' && own.length > 0 ? own : commonFields[key];
    }
    return merged;
  }
}
