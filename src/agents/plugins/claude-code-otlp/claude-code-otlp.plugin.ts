
import { basename } from 'node:path';
import type {
  ConfigChangeHookInput,
  HookInput,
  PostCompactHookInput,
  PostModelSwitchHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  UserPromptExpansionHookInput,
  UserPromptSubmitHookInput,
  UserPromptSubmitHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { type AuthGateResult, ensureCodeMieSsoAuthOrWait } from '@/providers/plugins/sso/sso.auth-gate.js';
import { describeLogin, SSO_LOGIN_WAIT_MS } from '@/providers/plugins/sso/sso.detached-login.js';
import { resolveHookAuthProfile } from '@/agents/core/hook-auth-profile.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { parsePromptFields } from '@/agents/core/ticket-parser.js';
import { stripPastedContentTags } from '@/agents/core/pasted-content.js';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { resolveEnvFields } from '@/agents/core/event-fields/env-fields.js';
import { resolveIdentityCandidateFields, resolveProjectAtCwd } from '@/agents/core/event-fields/identity-fields.js';
import {
  resolveGitCommitFields,
  resolveGitHeadFields,
  type GitCommitSummary,
} from '@/agents/core/event-fields/repo-fields.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { type ClaudeForwardDecision, isClaudeCodeHookInput } from './claude-code-otlp.types.js';
import { buildClaudeEventId } from './claude-code-otlp.event-id.js';
import { readPromptHookTimeoutSeconds } from './claude-code-otlp.allowlist.js';
import { evaluateClaudeAnalyticsGate } from './claude-code-otlp.gate.js';
import { readClaudeAnalyticsPreferences } from './claude-code-otlp.preferences.js';
import { stopNoticeText } from './claude-code-otlp.notice.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { hasRecordForSession, readRecord, recordKey, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import { isStopped, takeNotice, writeStop, type StopReason } from '@/agents/core/evidence/stop-marker.js';
import { scopeViolation } from '@/agents/core/evidence/session-scope.js';
import { hasPendingOwnerSession } from '@/agents/core/evidence/owner-pending.js';
import type { OtlpAdapterDeps } from '@/agents/core/types.js';
import {
  buildSessionEnvEvent,
  openMainTranscriptPass,
  openPostCompactPass,
  openSessionEnvCheckPass,
  isSessionReopenedIdle,
  markReopenedActive,
  openSessionStartPass,
  openSubagentPass,
  openSessionEndPass,
  type SessionEnvCheckInput,
  type SubagentFile,
} from './transcript/orchestrator.js';
import { readForkedSkillMarker, readSubagentMeta, resolveSubagentSkill, subagentFilePath } from './transcript/subagent-usage.js';
import { ProviderRegistry } from '@/providers/index.js';
import type { EvidenceInputs } from '@/agents/core/evidence/stamp.js';
import {
  fundingRoute,
  localProxyCandidate,
  oauthAccountPays,
  routedViaCodemie,
  type RoutingInput,
} from '@/agents/core/evidence/routing.js';
import { loadHookConfig } from '@/agents/core/event-fields/identity-fields.js';
import { readClaudeOrganization } from './event-fields/claude-org.js';
import { readClaudeSettingsEnv } from './event-fields/claude-settings-env.js';
import { resolveLocalProxy } from './event-fields/local-proxy.js';
import { resolveClientVersion } from './client-version-cache.js';
import { resolveCommandFields } from './event-fields/command-fields.js';
import { resolveSessionEnvFields } from './event-fields/session-env-fields.js';
import { resolveSubagentStopFields } from './event-fields/subagent-fields.js';
import {
  resolveForkAgentFields,
  resolveToolContextFields,
  resolveToolDiffFields,
  withoutSensitiveFileContent,
} from './event-fields/tool-fields.js';

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: 'agent.session.start',
  Stop: 'agent.session.stop',
  StopFailure: 'agent.turn.error',
  SessionEnd: 'agent.session.end',
  UserPromptSubmit: 'agent.prompt.submit',
  UserPromptExpansion: 'agent.skill.dispatch',
  PreToolUse: 'agent.tool.start',
  PostToolUse: 'agent.tool.end',
  PostToolUseFailure: 'agent.tool.error',
  SubagentStart: 'agent.subagent.start',
  SubagentStop: 'agent.subagent.stop',
  PreCompact: 'agent.session.compact',
  Notification: 'agent.notification',
};

/** Hook fields never forwarded: unbounded, and unused by analytics. */
const ALWAYS_DROPPED_FIELDS: readonly string[] = [
  'last_assistant_message',
  'session_crons',
  'background_tasks',
  'custom_instructions',
];

/** Timeout the connector wrote for every hook before UserPromptSubmit got its own. */
const LEGACY_HOOK_TIMEOUT_SECONDS = 30;
const HOOK_TIMEOUT_HEADROOM_MS = 15_000;

export class ClaudeCodeOtlpPlugin extends OtlpAgentAdapter<HookInput, UserPromptSubmitHookSpecificOutput> {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;
  protected override readonly configuredProjectWins = true;
  protected async extractHookContext(hookInput: HookInput): Promise<OtlpHookContext> {
    const [settings, hookConfig] = await Promise.all([
      readClaudeSettingsEnv(hookInput.cwd),
      loadHookConfig(hookInput.cwd),
    ]);
    const config = hookConfig?.config;
    const authType = config?.provider ? ProviderRegistry.getProvider(config.provider)?.authType : undefined;
    const codemieProvider = authType !== 'none' && (authType === 'sso' || config?.authMethod === 'jwt');
    const routingInput: RoutingInput = {
      env: process.env,
      settingsEnv: settings.env,
      settingsUnknown: !settings.complete,
      codemieProvider,
      profileBaseUrl: config?.baseUrl,
      profileName: config?.name,
    };
    // Native launch on a loopback endpoint: the live proxy daemon is the only thing that can prove it routed.
    if (localProxyCandidate(routingInput)) {
      routingInput.localProxy = await resolveLocalProxy();
      const daemonProfile = routingInput.localProxy?.profile;
      if (routingInput.localProxy && daemonProfile !== routingInput.profileName) {
        logger.debug(`[${this.name}] local proxy daemon serves another profile; routing stays unproven`);
      }
    }
    const routing = routedViaCodemie(routingInput);
    const prefs = await readClaudeAnalyticsPreferences();
    const evidenceInputs: EvidenceInputs = {
      // The saved OAuth login names the payer only when the session really authenticates with it.
      organization: oauthAccountPays({ ...routingInput, apiKeyHelper: settings.apiKeyHelper }) ? await readClaudeOrganization() : undefined,
      routing,
      funding_route: fundingRoute({ ...routingInput, apiKeyHelper: settings.apiKeyHelper }, routing),
      collection_generation: prefs.kind === 'ok' ? prefs.value.collectionGeneration : 0,
    };
    return {
      cwd: hookInput.cwd,
      prompt: hookInput.hook_event_name === 'UserPromptSubmit' ? hookInput.prompt : undefined,
      sessionId: hookInput.session_id,
      evidenceInputs,
    };
  }

  protected parseHookInput(raw: string): HookInput | null {
    const parsed: unknown = JSON.parse(raw);
    return isClaudeCodeHookInput(parsed) ? parsed : null;
  }

  protected async isTracked(hookInput: HookInput): Promise<boolean> {
    const decision = await evaluateClaudeAnalyticsGate(hookInput.cwd);
    logger.debug(`[${this.name}] analytics gate decision`, ...sanitizeLogArgs({ reason: decision.reason }));
    return decision.tracked;
  }

  /** The one-shot user notice of this hook, printed once at the end (or merged into a block answer). */
  private pendingNotice?: string;

  public override async processOtlpEvent(rawHookInput: string, deps: OtlpAdapterDeps): Promise<void> {
    try {
      await super.processOtlpEvent(rawHookInput, deps);
    } finally {
      // The hook always returns normally; the notice is a systemMessage (user-visible, not model context).
      if (this.pendingNotice) {
        console.log(JSON.stringify({ systemMessage: this.pendingNotice }));
        this.pendingNotice = undefined;
      }
    }
  }

  protected override emitBlock(decision: Parameters<OtlpAgentAdapter<HookInput, UserPromptSubmitHookSpecificOutput>['emitBlock']>[0]): void {
    if (!this.pendingNotice) return super.emitBlock(decision);
    console.log(JSON.stringify({ ...decision, systemMessage: this.pendingNotice }));
    this.pendingNotice = undefined;
  }

  /** Surfaces a pending notice (written by this hook or by the daemon) at most once, with a logger fallback. */
  private async queueNotice(key: string): Promise<void> {
    const reason = await takeNotice(key);
    if (!reason) return;
    this.pendingNotice = stopNoticeText(reason);
    logger.warn(`[${this.name}] ${this.pendingNotice}`);
  }

  private async stopSession(key: string, reason: StopReason, sessionId: string): Promise<'stop'> {
    try {
      await writeStop(key, reason, sessionId);
      await this.queueNotice(key);
    } catch (err) {
      // Marker write failure: nothing is spooled for this hook.
      logger.debug(`[${this.name}] stop marker not written: ${err instanceof Error ? err.name : 'error'}`);
    }
    return 'stop';
  }

  /**
   * After the global gates: a stopped session spools nothing; a non-startup hook with no record is a session of
   * unknown scope; a recorded new-contract session must still be in the same collection generation, project and
   * (when consented) connected folder. Anything unreadable fails closed. Never throws.
   */
  protected override async transitionGate(hookInput: HookInput): Promise<'continue' | 'stop'> {
    try {
      const id = await currentEvidenceIdentity();
      const sessionId = hookInput.session_id;
      if (!id) {
        // No owner to key a record by. Only a fresh session, one already held for its owner, or one with a record may go on
        // (held for replay, which re-checks it); an unknown mid-session scope never gets a record made from an outage.
        this.identityUnverifiedAtGate = true;
        const source = readOptionalString(hookInput, 'source');
        const fresh = hookInput.hook_event_name === 'SessionStart' && (source === 'startup' || source === 'clear');
        return fresh || (await hasPendingOwnerSession(sessionId)) || (await hasRecordForSession(sessionId)) ? 'continue' : 'stop';
      }
      const key = recordKey(id.api_identity, id.owner_hash, sessionId);
      if (await isStopped(key)) {
        await this.queueNotice(key);
        return 'stop';
      }
      const found = await readRecord(key);
      if (found && found.kind !== 'existing' && found.kind !== 'created') {
        return found.kind === 'stamp_invalid' ? this.stopSession(key, 'resume_unknown', sessionId) : 'stop';
      }
      if (!found) {
        const source = readOptionalString(hookInput, 'source');
        const freshSession = hookInput.hook_event_name === 'SessionStart' && (source === 'startup' || source === 'clear');
        if (freshSession || (await hasPendingOwnerSession(sessionId))) return 'continue';
        return this.stopSession(key, 'resume_unknown', sessionId);
      }
      const record = found.record;
      const violation = await this.recordViolation(record, hookInput.cwd);
      if (violation === 'unreadable') return 'stop';
      if (violation) return this.stopSession(key, violation, sessionId);
      await this.queueNotice(key); // e.g. a first-hold notice the daemon wrote
      return 'continue';
    } catch (err) {
      logger.debug(`[${this.name}] transition check failed: ${err instanceof Error ? err.name : 'error'}`);
      return 'stop';
    }
  }

  /** Why this hook's folder/generation/consent no longer fits the recorded session; 'unreadable' = preferences cannot be read. */
  private async recordViolation(record: EvidenceRecord, cwd: string): Promise<StopReason | 'unreadable' | undefined> {
    const prefs = await readClaudeAnalyticsPreferences();
    if (prefs.kind !== 'ok') return 'unreadable';
    return scopeViolation(record, {
      cwd,
      projectAtCwd: await resolveProjectAtCwd(cwd, record.profile, { configuredWins: true }),
      generation: prefs.value.collectionGeneration,
    });
  }

  /**
   * The identity lookup failed at the gate, so no record could be checked there; a later successful lookup (the stamp)
   * may then name an existing session. Re-run the same checks against that record before anything is spooled.
   */
  protected override async recordGate(context: OtlpHookContext, record: EvidenceRecord): Promise<'continue' | 'stop'> {
    if (!this.identityUnverifiedAtGate) return 'continue';
    try {
      const key = recordKey(record.api_identity, record.owner_hash, record.session_id);
      if (await isStopped(key)) { // the gate could not read this stop without the owner; a stopped session spools nothing
        await this.queueNotice(key);
        return 'stop';
      }
      const violation = await this.recordViolation(record, context.cwd);
      if (!violation) return 'continue';
      if (violation !== 'unreadable') {
        await this.stopSession(key, violation, record.session_id);
      }
    } catch (err) {
      logger.debug(`[${this.name}] record check failed: ${err instanceof Error ? err.name : 'error'}`);
    }
    return 'stop';
  }

  /** Set when the gate could not establish the owner; the stamp's record is then checked by `recordGate`. */
  private identityUnverifiedAtGate = false;

  /**
   * Excluded / out-of-scope hooks collect nothing and start nothing. The one exception is a privacy-stop marker for
   * a session already recorded, so returning to the folder cannot backfill what was skipped. Disabled never writes.
   */
  protected override async onUntrackedHook(hookInput: HookInput): Promise<void> {
    try {
      const decision = await evaluateClaudeAnalyticsGate(hookInput.cwd);
      if (decision.reason !== 'project-excluded' && decision.reason !== 'not-in-allowlist') return;
      const id = await currentEvidenceIdentity();
      if (!id) return;
      const key = recordKey(id.api_identity, id.owner_hash, hookInput.session_id);
      const found = await readRecord(key);
      if (found?.kind !== 'existing' && found?.kind !== 'created') return; // unknown session: stays untracked
      await this.stopSession(key, 'scope_excluded', hookInput.session_id);
    } catch (err) {
      logger.debug(`[${this.name}] untracked-hook stop failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /** Resolved once per call so every record in the batch shares one client-version lookup. */
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {
      platform: 'claude-code',
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '',
      client_version: await resolveClientVersion(),
    };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['hook_event_name'] ?? '')] ?? 'agent.event';
  }

  /** Claude's deterministic id: per-event templates for derived records, content hash otherwise. */
  protected buildEventId(
    event: Record<string, unknown>,
    payload: Record<string, unknown>,
    timestamp: string
  ): string {
    return buildClaudeEventId(event, payload, timestamp);
  }

  protected async evaluate(hookInput: HookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.hook_event_name === 'SessionStart') {
      return await this.onSessionStart(hookInput);
    }
    if (hookInput.hook_event_name === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(hookInput);
    }
    if (hookInput.hook_event_name === 'UserPromptExpansion') {
      return await this.onUserPromptExpansion(hookInput);
    }
    if (hookInput.hook_event_name === 'PreToolUse') {
      return await this.onPreToolUse(hookInput);
    }
    if (hookInput.hook_event_name === 'PostToolUse') {
      return await this.onPostToolUse(hookInput);
    }
    if (hookInput.hook_event_name === 'PostToolUseFailure') {
      return await this.onPostToolUseFailure(hookInput);
    }
    if (hookInput.hook_event_name === 'Stop') {
      return await this.onStopEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PreCompact') {
      return await this.onPreCompactEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PostCompact') {
      return await this.onPostCompactEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'StopFailure') {
      return await this.onStopFailureEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SessionEnd') {
      return await this.onSessionEndEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SubagentStop') {
      return await this.onSubagentStopEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SubagentStart') {
      return await this.onSubagentStartEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PostModelSwitch') {
      return await this.onPostModelSwitch(hookInput);
    }
    if (hookInput.hook_event_name === 'ConfigChange') {
      return await this.onConfigChange(hookInput);
    }

    // Every other hook (`Notification`, `InstructionsLoaded`, ...) is sent as it came, except for a session that was
    // reopened without a prompt and has done nothing since: opening it must not change its analytics (EPMCDME-16993).
    if (await isSessionReopenedIdle(hookInput.session_id)) {
      return { decision: 'forward', payload: [] };
    }
    return { decision: 'forward', payload: [hookInput] };
  }

  private async onSubagentStartEvent(hookInput: SubagentStartHookInput): Promise<ClaudeForwardDecision> {
    if (!hookInput.agent_type) {
      // Same internal check-in filter as onSubagentStopEvent — not a real subagent dispatch.
      return { decision: 'forward', payload: [] };
    }

    // SubagentStart carries no agent_transcript_path (unlike SubagentStop) — build the path from
    // the triggering hook's own transcript_path (the main transcript) and agent_id instead.
    const agentTranscriptPath = subagentFilePath(hookInput.transcript_path, hookInput.agent_id);
    const marker = await readForkedSkillMarker(agentTranscriptPath);
    const skillName =
      marker.skillName || (await resolveSubagentSkill(hookInput.transcript_path, hookInput.agent_id)).skillName;
    const payload = skillName ? { ...hookInput, skill_name: skillName } : hookInput;
    return { decision: 'forward', payload: [payload] };
  }

  /**
   * Enriches the session start with opt-in fields (not stamped on other events). The hook payload is
   * spread first so a same-named payload key can never override a resolved value. The payload's
   * `model` only feeds `agent.session.env`'s `configured_model` — it is not stamped onto
   * `agent.session.start`, whose backend reads `configured_model` from the env snapshot instead.
   *
   * Also emits `agent.session.env`. `openSessionStartPass` records `git_head_start`/the session's
   * wall-clock start time into the parse state — same commit-after-send contract as every other
   * trigger (`pass.finalize`), so `onSessionEndEvent` only ever reads back a value that was
   * actually persisted after a successful send, never persisted ahead of it.
   */
  private async onSessionStart(hookInput: SessionStartHookInput): Promise<ClaudeForwardDecision> {
    const context: OtlpHookContext = { cwd: hookInput.cwd };
    const model = readOptionalString(hookInput, 'model') ?? '';
    const permissionMode = hookInput.permission_mode ?? '';
    const [envFields, identityCandidateFields, gitHeadStart, sessionEnvFields] = await Promise.all([
      resolveEnvFields(),
      resolveIdentityCandidateFields(context),
      resolveGitHeadFields(context, 'start'),
      resolveSessionEnvFields(hookInput.cwd, model, permissionMode),
    ]);
    const pass = await openSessionStartPass(
      hookInput.session_id,
      gitHeadStart.git_head_start,
      sessionEnvFields,
      hookInput.source
    );
    // Reopening an already reported session announces nothing: a start stamped now would move its
    // activity window and re-bind it to this launch (EPMCDME-16993).
    if (pass.reopened) {
      return { decision: 'forward', payload: [], finalize: pass.finalize };
    }

    const sessionStartEvent: Record<string, unknown> = {
      ...hookInput,
      ...envFields,
      ...identityCandidateFields,
      ...gitHeadStart,
      git_head_start: pass.gitHeadStart,
    };
    // The payload's `model` only feeds `agent.session.env`'s `configured_model` — the field the
    // backend actually reads. `model` on `agent.session.start` is not read, so it is not sent.
    delete sessionStartEvent.model;

    const sessionEnvEvent = buildSessionEnvEvent(hookInput.session_id, pass.sessionEnvFields);
    return {
      decision: 'forward',
      payload: [sessionStartEvent, sessionEnvEvent],
      finalize: pass.finalize,
    };
  }

  private async onStopEvent(hookInput: StopHookInput): Promise<ClaudeForwardDecision> {
    const [pass, gitHeadEnd] = await Promise.all([
      openMainTranscriptPass(hookInput.session_id, hookInput.transcript_path, 'Stop', envCheckInput(hookInput)),
      resolveGitHeadFields({ cwd: hookInput.cwd }, 'end'),
    ]);
    if (pass.suppressLifecycle) {
      return { decision: 'forward', payload: [], finalize: pass.finalize };
    }
    return {
      decision: 'forward',
      payload: [{ ...hookInput, ...gitHeadEnd }, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async onPreCompactEvent(hookInput: PreCompactHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openMainTranscriptPass(
      hookInput.session_id,
      hookInput.transcript_path,
      'PreCompact',
      envCheckInput(hookInput)
    );
    if (pass.suppressLifecycle) {
      return { decision: 'forward', payload: [], finalize: pass.finalize };
    }
    return {
      decision: 'forward',
      payload: [hookInput, ...pass.events],
      finalize: pass.finalize,
    };
  }

  /**
   * `openPostCompactPass` does the detection work itself, including the bounded, lock-free wait
   * for a still-landing `compact_boundary` line — see its own doc comment. The native
   * `PostCompact` hook event is never forwarded, same as `onPostModelSwitch`/`onConfigChange`:
   * only the derived `agent.session.compact.done` record goes out, if one was found. Forwarding
   * the raw hook too would double-emit it, since `buildCompactionDoneEvent` already sets its own
   * explicit `type`.
   */
  private async onPostCompactEvent(hookInput: PostCompactHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openPostCompactPass(hookInput.session_id, hookInput.transcript_path);
    return {
      decision: 'forward',
      payload: pass.events,
      finalize: pass.finalize,
    };
  }

  private async onStopFailureEvent(hookInput: StopFailureHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openMainTranscriptPass(
      hookInput.session_id,
      hookInput.transcript_path,
      'StopFailure',
      envCheckInput(hookInput)
    );
    if (pass.suppressLifecycle) {
      return { decision: 'forward', payload: [], finalize: pass.finalize };
    }
    return {
      decision: 'forward',
      payload: [hookInput, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async onSessionEndEvent(hookInput: SessionEndHookInput): Promise<ClaudeForwardDecision> {
    const [pass, gitHeadEnd, identityCandidateFields] = await Promise.all([
      openSessionEndPass(hookInput.session_id, hookInput.transcript_path, hookInput.cwd, envCheckInput(hookInput)),
      resolveGitHeadFields({ cwd: hookInput.cwd }, 'end'),
      resolveIdentityCandidateFields({ cwd: hookInput.cwd }),
    ]);
    if (pass.suppressLifecycle) {
      return { decision: 'forward', payload: [], finalize: pass.finalize };
    }
    const gitCommitFields = await resolveGitCommitFields(
      hookInput.cwd,
      pass.sessionStartedAt,
      identityCandidateFields.git_email
    );
    const gitSnapshotEvent = buildGitSnapshotEvent(hookInput.session_id, {
      gitHeadStart: pass.gitHeadStart,
      gitHeadEnd: gitHeadEnd.git_head_end,
      gitEmail: identityCandidateFields.git_email,
      gitCommits: gitCommitFields.git_commits,
    });

    // No later hook retries a failed SessionEnd batch, so it gets one in-process resend.
    return {
      decision: 'forward',
      payload: [{ ...hookInput, ...gitHeadEnd }, gitSnapshotEvent, ...pass.events],
      finalize: pass.finalize,
      retryOnce: true,
    };
  }

  private async onUserPromptExpansion(hookInput: UserPromptExpansionHookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.expansion_type !== 'slash_command') {
      return { decision: 'forward', payload: [] };
    }

    return {
      decision: 'forward',
      payload: [{
        session_id: hookInput.session_id,
        prompt_id: hookInput.prompt_id,
        hook_event_name: hookInput.hook_event_name,
        expansion_type: hookInput.expansion_type,
        command_name: hookInput.command_name,
        command_source: hookInput.command_source,
        skill_name: hookInput.command_name,
      }],
    };
  }

  /**
   * `/model` always changes `agent.session.env`'s `configured_model`, and might as well pay for
   * a full recompute while it's at it (rare hook, I/O cost is a non-issue) in case something else
   * drifted too. The native `PostModelSwitch`/`ConfigChange` events are never forwarded
   * themselves — only the derived `agent.session.env`, if anything actually changed.
   */
  private async onPostModelSwitch(hookInput: PostModelSwitchHookInput): Promise<ClaudeForwardDecision> {
    const check = await openSessionEnvCheckPass(hookInput.session_id, {
      effort: hookInput.effort?.level ?? '',
      permissionMode: hookInput.permission_mode ?? '',
      full: { cwd: hookInput.cwd, configuredModel: hookInput.to_model, replaceEffort: true },
    });
    if (!check.sessionEnvFields) {
      return { decision: 'forward', payload: [], finalize: check.finalize };
    }
    return {
      decision: 'forward',
      payload: [buildSessionEnvEvent(hookInput.session_id, check.sessionEnvFields)],
      finalize: check.finalize,
    };
  }

  /**
   * `source: 'skills'` is a skill-*content* edit (e.g. a `SKILL.md` change) — never env-relevant,
   * so it's skipped before touching any lock or file. Every other source
   * (`user_settings`/`project_settings`/`local_settings`/`policy_settings`) is where
   * `outputStyle`/`enabledPlugins` actually live, so those get a full recompute.
   * `configuredModel` is omitted — `ConfigChangeHookInput` doesn't carry one — so
   * `openSessionEnvCheckPass` falls back to the last snapshot's value.
   */
  private async onConfigChange(hookInput: ConfigChangeHookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.source === 'skills') {
      return { decision: 'forward', payload: [] };
    }
    const check = await openSessionEnvCheckPass(hookInput.session_id, {
      effort: hookInput.effort?.level ?? '',
      permissionMode: hookInput.permission_mode ?? '',
      full: { cwd: hookInput.cwd },
    });
    if (!check.sessionEnvFields) {
      return { decision: 'forward', payload: [], finalize: check.finalize };
    }
    return {
      decision: 'forward',
      payload: [buildSessionEnvEvent(hookInput.session_id, check.sessionEnvFields)],
      finalize: check.finalize,
    };
  }

  private async onSubagentStopEvent(hookInput: SubagentStopHookInput): Promise<ClaudeForwardDecision> {
    if (!hookInput.agent_type) {
      // Claude Code's own internal check-ins ("is it done yet?") fire SubagentStop with no
      // agent_type — not a real subagent, so nothing is derived or forwarded for it.
      return { decision: 'forward', payload: [] };
    }

    const agentTranscriptPath = hookInput.agent_transcript_path;
    if (!agentTranscriptPath) {
      return { decision: 'forward', payload: [hookInput] };
    }

    const [meta, marker] = await Promise.all([
      readSubagentMeta(agentTranscriptPath),
      readForkedSkillMarker(agentTranscriptPath),
    ]);
    // Never let agentId resolve to '' (CR-001): deriveMainEvents' api_calls filter treats an
    // empty agentId as main-thread, so a forked skill's subagent ending up with one here would
    // double-count its usage right back into api_calls. agentTranscriptPath is already confirmed
    // non-empty above, so it is always a safe final fallback.
    const derivedAgentId = basename(agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const agentId = hookInput.agent_id || derivedAgentId || agentTranscriptPath;
    const candidate: SubagentFile = {
      agentId,
      filePath: agentTranscriptPath,
      // `tool_use_id` is not declared on the SDK's SubagentStopHookInput type; the hook payload
      // wins when it carries it anyway, else fall back to the `.meta.json` sidecar.
      toolUseId: readOptionalString(hookInput, 'tool_use_id') ?? meta.toolUseId,
      agentType: hookInput.agent_type,
      spawnDepth: meta.spawnDepth,
      description: meta.description,
      cwd: hookInput.cwd,
    };
    // Resolved from the hook's own file (the actual candidate), not only from directory discovery.
    const resolved = marker.skillName
      ? { skillName: marker.skillName, pending: false }
      : await resolveSubagentSkill(hookInput.transcript_path, agentId, candidate);
    const skillName = resolved.skillName;
    const subagentFile: SubagentFile = {
      ...candidate,
      description: candidate.description || (skillName ? `/${skillName}` : undefined),
      skillName: skillName || undefined,
      pending: resolved.pending || undefined,
    };

    const pass = await openSubagentPass(
      hookInput.session_id,
      subagentFile,
      envCheckInput(hookInput)
    );
    const stopFields = resolveSubagentStopFields(subagentFile, pass.events);
    const stopPayload = {
      ...hookInput,
      ...stopFields,
      ...(skillName ? { skill_name: skillName } : {}),
    };
    return {
      decision: 'forward',
      payload: [stopPayload, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async ensureProxyAuth(): Promise<AuthGateResult> {
    // The session's profile, not the cwd's: the hook follows the agent into subdirectories (EPMCDME-16308).
    const profile = await resolveHookAuthProfile();
    // Settings written before the 180s prompt timeout keep the 30s default: never outwait the installed timeout.
    const timeoutMs = ((await readPromptHookTimeoutSeconds()) ?? LEGACY_HOOK_TIMEOUT_SECONDS) * 1000;
    const waitMs = Math.max(0, Math.min(SSO_LOGIN_WAIT_MS, timeoutMs - HOOK_TIMEOUT_HEADROOM_MS));

    // stdout carries the hook's JSON decision, so the wait notice goes to stderr.
    return await ensureCodeMieSsoAuthOrWait(
      {
        provider: profile.provider,
        ssoUrl: profile.ssoUrl,
        baseUrl: profile.baseUrl,
      },
      { waitMs, onWaitStart: (message) => process.stderr.write(message + '\n') }
    );
  }

  private async onUserPromptSubmit(hookInput: UserPromptSubmitHookInput): Promise<ClaudeForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      await markReopenedActive(hookInput.session_id); // a prompt is the reopened session's own activity
      // Derived fields read the raw prompt (the base class truncates `prompt` to 200 chars later).
      // `prompt` itself is cleaned of pasted-content tags.
      const prompt = typeof hookInput.prompt === 'string' ? hookInput.prompt : '';
      const cleaned = stripPastedContentTags(prompt);
      return {
        decision: 'forward',
        payload: [{
          ...hookInput,
          ...parsePromptFields(prompt),
          ...resolveCommandFields(prompt),
          ...(cleaned !== prompt && { prompt: cleaned }),
        }],
      }
    }

    return {
      decision: 'block',
      reason: `${describeLogin(authResult.loginOutcome, { wait: authResult.waitResult })}\n(${authResult.reason})`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        suppressOriginalPrompt: true,
      }
    }
  }

  // Tool events go through withoutSensitiveFileContent: a call on a credentials file would otherwise
  // forward the file's content in tool_input (Edit/Write) or tool_response (Read/Edit/Write).
  private async onPreToolUse(hookInput: PreToolUseHookInput): Promise<ClaudeForwardDecision> {
    const contextFields = resolveToolContextFields(hookInput.tool_name, hookInput.tool_input);
    return { decision: 'forward', payload: [{ ...withoutSensitiveFileContent(hookInput), ...contextFields }] };
  }

  private async onPostToolUse(hookInput: PostToolUseHookInput): Promise<ClaudeForwardDecision> {
    const contextFields = resolveToolContextFields(hookInput.tool_name, hookInput.tool_input);
    // Line counts and the fork id are derived from the uncut input, before its content is dropped.
    const diffFields = resolveToolDiffFields(hookInput.tool_name, hookInput.tool_input, hookInput.tool_response);
    const forkFields = resolveForkAgentFields(hookInput.tool_name, hookInput.tool_response);
    return {
      decision: 'forward',
      payload: [{ ...withoutSensitiveFileContent(hookInput), ...contextFields, ...diffFields, ...forkFields }],
    };
  }

  private async onPostToolUseFailure(hookInput: PostToolUseFailureHookInput): Promise<ClaudeForwardDecision> {
    return { decision: 'forward', payload: [withoutSensitiveFileContent(hookInput)] };
  }

  /**
   * Drops the fields no analytics consumer uses and that can be arbitrarily large. A Notification's
   * `message` and `title` go too, but other events keep `message` (e.g. Elicitation) and the session
   * summary keeps its own `title` (it carries no `hook_event_name`).
   */
  protected droppedFields(hookEvent: Record<string, unknown>): readonly string[] {
    return hookEvent['hook_event_name'] === 'Notification'
      ? [...ALWAYS_DROPPED_FIELDS, 'message', 'title']
      : ALWAYS_DROPPED_FIELDS;
  }
}

/** Cheap env fields (no I/O), folded into the handler's own transcript/subagent pass. */
function envCheckInput(hookInput: Pick<HookInput, 'cwd' | 'effort' | 'permission_mode'>): SessionEnvCheckInput {
  return {
    effort: hookInput.effort?.level ?? '',
    permissionMode: hookInput.permission_mode ?? '',
    cwd: hookInput.cwd,
  };
}

function buildGitSnapshotEvent(
  sessionId: string,
  input: { gitHeadStart: string; gitHeadEnd: string; gitEmail: string; gitCommits: GitCommitSummary[] }
): Record<string, unknown> {
  return {
    type: 'agent.git.snapshot',
    session_id: sessionId,
    git_head_start: input.gitHeadStart,
    git_head_end: input.gitHeadEnd,
    git_email: input.gitEmail,
    git_commits: input.gitCommits,
  };
}

/**
 * Reads a string field not declared on the SDK's `HookInput` typings (e.g. `tool_use_id` on
 * `SubagentStop`), in case the raw hook payload carries it anyway.
 */
function readOptionalString(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
