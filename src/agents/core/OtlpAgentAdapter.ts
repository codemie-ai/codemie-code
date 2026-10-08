import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { ConfigLoader } from '@/utils/config.js';
import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import { AgentAdapterType, type OtlpAdapterDeps } from './types.js';
import { resolveStoryFor } from './story-resolver.js';
import { resolveHookCredentials } from './hook-credentials.js';
import { resolveEmailFromCredentials, resolveIdentity } from './identity-resolver.js';

export type ForwardDecision<TBlockOutput = Record<string, unknown>> =
  | { decision: 'forward'; payload: Record<string, unknown>[] }
  | { decision: 'block'; reason: string; hookSpecificOutput: TBlockOutput };

export interface OtlpHookContext {
  cwd: string;
  /** Only for prompt-submit style events; enables the marker/mention story tiers. */
  prompt?: string;
}

/** Git and story fields, resolved from the hook's cwd and prompt. */
interface RepoFields {
  git_branch: string;
  repo_remote: string;
  story_id: string;
  story_source: string;
}

/** Identity, project and version fields, resolved from the hook's cwd and the stored SSO credentials. */
interface IdentityFields {
  user_email: string;
  developer_name: string;
  identity_source: string;
  codemie_project_name: string;
  codemie_cli_version: string;
}

/** Agent-independent fields resolved by the base class at hook time. */
type CommonFields = RepoFields & IdentityFields;

/** Common fields an event may bring itself: its own non-empty value wins. All others are stamped. */
const OVERRIDABLE_FIELD_KEYS = ['git_branch', 'repo_remote', 'story_id', 'story_source'] as const;

/** Everything resolved once per hook invocation and shared by every event of that invocation. */
interface InvocationContext {
  cwd: string;
  /** Captured once, so the fallback timestamp is the same for every event and every retry. */
  hookTime: Date;
  commonFields: CommonFields;
  agentFields: Record<string, unknown>;
}

const SCHEMA_VERSION = 2;
const MAX_PROMPT_CHARS = 200;
const MAX_TOOL_FIELD_CHARS = 300;

/**
 * Base class for adapters that ingest a coding tool's native hook events into the
 * analytics spool. Owns the fixed flow (parse, allowlist gate, daemon start, evaluate,
 * enrichment, spool forward); subclasses supply the tool-specific parts.
 *
 * The complete event is built here, in the short-lived hook process, because
 * the forwarder runs in a long-lived daemon whose environment (cwd, profile, credentials,
 * CLI version) is frozen at spawn time. The forwarder only transports it.
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
    const [commonFields, agentFields] = await Promise.all([
      this.resolveCommonFields(context),
      this.resolveAgentFields(),
    ]);
    const invocation: InvocationContext = { cwd: context.cwd, hookTime: new Date(), commonFields, agentFields };

    // Sequential, so a hook event stays ahead of its derived events in the spool.
    // forwardOtlpEventToSpool never throws and aborts after 1s.
    for (const hookEvent of decision.payload) {
      await forwardOtlpEventToSpool(this.buildEvent(hookEvent, invocation), this.name);
    }
  }

  /** Returns null to ignore a payload of an unknown shape. May throw on malformed JSON. */
  protected abstract parseHookInput(raw: string): TInput | null;
  protected abstract extractHookContext(input: TInput): OtlpHookContext;
  /** Allowlist gate; evaluated before the daemon is started. */
  protected abstract isTracked(input: TInput): Promise<boolean>;
  protected abstract evaluate(input: TInput): Promise<ForwardDecision<TBlockOutput>>;
  /** Agent-owned fields (platform, version, entrypoint, ...); override everything else. */
  protected abstract resolveAgentFields(): Promise<Record<string, unknown>>;
  /** `type` of a native event that does not carry an explicit one. */
  protected abstract resolveEventType(event: Record<string, unknown>): string;

  /**
   * Assembles the final event. `raw` mirrors the full enriched event, so the top
   * level and `raw` carry the same fields.
   */
  private buildEvent(hookEvent: Record<string, unknown>, ctx: InvocationContext): Record<string, unknown> {
    const limited = this.limitPayload(hookEvent);
    const explicitType = hookEvent['type'];

    const event: Record<string, unknown> = {
      ...this.mergeCommonFields(limited, ctx.commonFields),
      ...ctx.agentFields,
      type: typeof explicitType === 'string' && explicitType.length > 0 ? explicitType : this.resolveEventType(hookEvent),
      session_id: String(hookEvent['session_id'] ?? ''),
      timestamp: this.resolveEventTimestamp(hookEvent['timestamp'], ctx.hookTime),
      cwd: ctx.cwd,
      prompt_body: this.boundedText(hookEvent['prompt'], MAX_PROMPT_CHARS),
      schema_version: SCHEMA_VERSION,
      event_id: randomUUID(),
    };
    return { ...event, raw: { ...event } };
  }

  /** Truncates the free-text fields; a nested `raw` is dropped so it cannot bypass the limits. */
  private limitPayload(hookEvent: Record<string, unknown>): Record<string, unknown> {
    const limited: Record<string, unknown> = { ...hookEvent };
    if (Object.prototype.hasOwnProperty.call(hookEvent, 'prompt')) {
      limited['prompt'] = this.boundedText(hookEvent['prompt'], MAX_PROMPT_CHARS);
    }
    for (const field of ['tool_input', 'tool_response', 'error']) {
      if (Object.prototype.hasOwnProperty.call(hookEvent, field)) {
        limited[field] = this.boundedText(hookEvent[field], MAX_TOOL_FIELD_CHARS);
      }
    }
    delete limited['raw'];
    return limited;
  }

  private boundedText(value: unknown, maxChars: number): string {
    if (value === undefined || value === null) {
      return '';
    }
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value);
      }
    }
    return text.slice(0, maxChars);
  }

  /**
   * The event's own timestamp (e.g. the transcript line time on `agent.usage.request`) wins
   * over hook time. Falls back when the event has none or an unparseable one.
   */
  private resolveEventTimestamp(eventTimestamp: unknown, hookTime: Date): string {
    if (typeof eventTimestamp === 'string' && eventTimestamp.length > 0) {
      const parsed = new Date(eventTimestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return hookTime.toISOString();
  }

  /**
   * Identity, project and CLI version for the hook's cwd. Credentials are the SSO ones the
   * daemon will use (see `resolveHookCredentials`); without them identity falls through to
   * the git, codemie_cli and os tiers. A failed lookup yields empty fields, never a dropped event.
   */
  private async resolveIdentityFields(cwd: string): Promise<IdentityFields> {
    const empty: IdentityFields = {
      user_email: '',
      developer_name: '',
      identity_source: '',
      codemie_project_name: '',
      codemie_cli_version: '',
    };
    try {
      const credentials = await resolveHookCredentials();
      const [identity, projectName, version] = await Promise.all([
        resolveIdentity(credentials, cwd),
        this.resolveProjectName(cwd),
        getCurrentCliVersion(),
      ]);
      return {
        user_email: resolveEmailFromCredentials(credentials),
        developer_name: identity.developerName,
        identity_source: identity.identitySource,
        codemie_project_name: projectName,
        codemie_cli_version: version ?? '',
      };
    } catch (error) {
      logger.debug(`[${this.name}] identity field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  }

  private async resolveProjectName(cwd: string): Promise<string> {
    try {
      const profileName = await ConfigLoader.getActiveProfileName(cwd);
      const config = await ConfigLoader.load(cwd, profileName ? { name: profileName } : undefined);
      return config.codeMieProject ?? '';
    } catch {
      return '';
    }
  }

  private async resolveCommonFields(context: OtlpHookContext): Promise<CommonFields> {
    const [repoFields, identityFields] = await Promise.all([
      this.resolveRepoFields(context),
      this.resolveIdentityFields(context.cwd),
    ]);
    return { ...repoFields, ...identityFields };
  }

  private async resolveRepoFields({ cwd, prompt }: OtlpHookContext): Promise<RepoFields> {
    const empty: RepoFields = { git_branch: '', repo_remote: '', story_id: '', story_source: '' };
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
      logger.debug(`[${this.name}] repo field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  }

  /** Stamps the common fields; for the overridable ones a hook event's own non-empty string value wins. */
  private mergeCommonFields(hookEvent: Record<string, unknown>, commonFields: CommonFields): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...hookEvent, ...commonFields };
    for (const key of OVERRIDABLE_FIELD_KEYS) {
      const own = hookEvent[key];
      if (typeof own === 'string' && own.length > 0) {
        merged[key] = own;
      }
    }
    return merged;
  }
}
