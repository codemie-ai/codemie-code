/**
 * Lifecycle event emitter for `codemie skills *` commands.
 *
 * Each event is POSTed to the CodeMie backend at `/v1/skills/events`, where
 * it is persisted in Postgres (authoritative, durable) and mirrored to the
 * legacy Elastic-backed metrics path. Postgres survives Elastic retention,
 * so install-count / popularity queries remain accurate forever.
 *
 * Behaviour:
 * - **Auth-gated (spec §7).** If no SSO credentials are present, the helper
 *   becomes a no-op silently — no event is sent.
 * - **Fan-out per skill.** When the wrapper knows which skills the operation
 *   targets (explicit `--skill foo bar`), one POST is emitted per skill so
 *   the backend stores `(event, skill)` rows and trivial COUNT(*) queries
 *   work. For ops without a specific skill (bare `list`, `find`, interactive
 *   `add`), a single POST is sent with `skill_*` fields null.
 * - **Best-effort.** Any failure to load credentials, resolve the API URL,
 *   or POST is logged at debug level and swallowed — telemetry must never
 *   block a real user command.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { getDirname } from '@/utils/paths.js';
import type { CodeMieConfigOptions } from '@/env/types.js';

const AGENT_NAME = 'codemie-skills';
const ENDPOINT_PATH = '/v1/skills/events';

// Wrapper-known input shapes (typed once here so command files don't reach
// across module boundaries to import an unrelated metrics-types module).
export type SkillCommand = 'add' | 'update' | 'remove' | 'list' | 'find';
export type SkillStatus = 'started' | 'completed' | 'failed';
export type SkillScope = 'global' | 'project' | 'unknown';
export type AgentSelectionMode = 'explicit' | 'auto_detected' | 'prompted' | 'upstream';

interface PartialAttributes {
  scope?: SkillScope;
  source?: string;
  skill_names?: string[];
  skill_count?: number;
  target_agents?: string[];
  agent_selection_mode?: AgentSelectionMode;
  error_code?: string;
  /**
   * Forward-compat escape hatch matching the backend `attributes` JSONB
   * field on `SkillEventRequest`. Use this for command-specific telemetry
   * (e.g. `find`'s `query_length`, `internal_available`, `result_count_*`)
   * that does not fit the strict top-level schema.
   */
  attributes?: Record<string, unknown>;
}

export interface SkillMetricSession {
  command: SkillCommand;
  sessionId: string;
  agentVersion: string;
  workingDirectory: string;
  /**
   * Resolved transport. `null` when no SSO credentials are available — every
   * `emit*` becomes a no-op.
   */
  transport: SkillEventTransport | null;
}

interface SkillEventTransport {
  apiUrl: string;
  cookieHeader: string;
  cliVersion: string;
}

/**
 * Build a metric session for a single `codemie skills <command>` invocation.
 * Loads SSO credentials best-effort; if anything fails, returns a session
 * whose `transport` is null and the lifecycle helpers become no-ops.
 */
export async function startSkillMetric(
  command: SkillCommand,
  workingDirectory = process.cwd()
): Promise<SkillMetricSession> {
  const sessionId = process.env.CODEMIE_SESSION_ID ?? randomUUID();
  const agentVersion = readPackageVersion();
  const transport = await tryBuildTransport(agentVersion);

  return {
    command,
    sessionId,
    agentVersion,
    workingDirectory,
    transport,
  };
}

export async function emitStarted(
  session: SkillMetricSession,
  partial: Pick<
    PartialAttributes,
    'scope' | 'source' | 'skill_names' | 'skill_count' | 'target_agents' | 'agent_selection_mode'
  >
): Promise<void> {
  await emit(session, 'started', partial);
}

export async function emitCompleted(
  session: SkillMetricSession,
  partial: PartialAttributes
): Promise<void> {
  await emit(session, 'completed', partial);
}

export async function emitFailed(
  session: SkillMetricSession,
  partial: PartialAttributes
): Promise<void> {
  await emit(session, 'failed', partial);
}

interface SkillEventBody {
  session_id: string;
  command: SkillCommand;
  status: SkillStatus;
  scope?: SkillScope;
  error_code?: string;
  agent_selection_mode?: AgentSelectionMode;
  target_agents?: string[];
  source?: string;
  skill_name?: string;
  skill_slug?: string;
  skill_id?: string;
  agent: string;
  agent_version: string;
  repository?: string;
  branch?: string;
  project?: string;
  attributes?: Record<string, unknown>;
}

async function emit(
  session: SkillMetricSession,
  status: SkillStatus,
  partial: PartialAttributes
): Promise<void> {
  if (!session.transport) {
    return;
  }

  const transport = session.transport;

  try {
    const [branch, repository] = await Promise.all([
      detectGitBranch(session.workingDirectory),
      detectGitRemoteRepo(session.workingDirectory),
    ]);

    const baseBody: Omit<SkillEventBody, 'skill_name' | 'skill_slug' | 'skill_id'> = {
      session_id: session.sessionId,
      command: session.command,
      status,
      ...(partial.scope !== undefined && { scope: partial.scope }),
      ...(partial.error_code !== undefined && { error_code: partial.error_code }),
      ...(partial.agent_selection_mode !== undefined && {
        agent_selection_mode: partial.agent_selection_mode,
      }),
      ...(partial.target_agents && partial.target_agents.length > 0 && {
        target_agents: partial.target_agents,
      }),
      ...(partial.source !== undefined && { source: partial.source }),
      agent: AGENT_NAME,
      agent_version: session.agentVersion,
      ...(repository && { repository }),
      ...(branch && { branch }),
      ...(partial.attributes && Object.keys(partial.attributes).length > 0 && {
        attributes: partial.attributes,
      }),
    };

    const targetedSkills = partial.skill_names ?? [];
    const bodies: SkillEventBody[] =
      targetedSkills.length > 0
        ? targetedSkills.map((name) => ({
            ...baseBody,
            skill_name: name,
            skill_slug: toSkillSlug(name),
            skill_id: composeSkillId(partial.source, toSkillSlug(name)),
          }))
        : [{ ...baseBody }];

    logger.debug('[skills] Emitting skill events', {
      command: session.command,
      status,
      scope: partial.scope,
      session_id: session.sessionId,
      events: bodies.length,
    });

    await Promise.all(bodies.map((body) => postOne(transport, body)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[skills] Event emission failed (${status}): ${message}`);
  }
}

async function postOne(transport: SkillEventTransport, body: SkillEventBody): Promise<void> {
  const url = `${transport.apiUrl}${ENDPOINT_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `codemie-cli/${transport.cliVersion}`,
    'X-CodeMie-CLI': `codemie-cli/${transport.cliVersion}`,
    'X-CodeMie-Client': 'codemie-cli',
    Cookie: transport.cookieHeader,
  };
  if (body.repository) headers['X-CodeMie-Repository'] = body.repository;
  if (body.branch) headers['X-CodeMie-Branch'] = body.branch;
  if (body.project) headers['X-CodeMie-Project'] = body.project;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.debug(
        `[skills] /v1/skills/events POST returned HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`
      );
      return;
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    logger.debug('[skills] Skill event recorded', {
      id: data.id,
      command: body.command,
      status: body.status,
      skill_id: body.skill_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[skills] Skill event POST failed: ${message}`);
  }
}

/**
 * Mirror of upstream `skills` CLI `toSkillSlug`. Keeping the algorithm
 * byte-for-byte identical means the canonical `<source>/<slug>` we send
 * matches whatever the upstream tooling computes, so cross-system joins
 * (e.g. comparing our install counts to skills.sh download counts) work
 * without a translation layer.
 */
export function toSkillSlug(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function composeSkillId(source: string | undefined, slug: string): string | undefined {
  if (!slug) return undefined;
  return source ? `${source}/${slug}` : slug;
}

async function tryBuildTransport(agentVersion: string): Promise<SkillEventTransport | null> {
  let config: CodeMieConfigOptions;
  try {
    config = await ConfigLoader.load();
  } catch (error) {
    logger.debug('[skills] Skipping event emission: configuration not loaded', error);
    return null;
  }

  const ssoUrl = config.codeMieUrl || config.baseUrl;
  if (!ssoUrl) {
    logger.debug('[skills] Skipping event emission: no CodeMie URL configured');
    return null;
  }

  let cookieHeader = '';
  let apiUrl: string | undefined;
  try {
    const { CodeMieSSO } = await import('@/providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);

    if (credentials?.cookies) {
      cookieHeader = Object.entries(credentials.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
    }
    // credentials.apiUrl is the resolved API base (e.g.
    // "<codeMieUrl>/code-assistant-api"). The bare baseUrl from the profile
    // points at the LLM proxy for SSO providers and does NOT serve our
    // events endpoint, so we prefer the credential-stored URL.
    apiUrl = credentials?.apiUrl;
  } catch (error) {
    logger.debug('[skills] Failed to load SSO credentials for events', error);
  }

  if (!cookieHeader) {
    logger.debug('[skills] Skipping event emission: no SSO cookies available');
    return null;
  }

  if (!apiUrl) {
    try {
      const { ensureApiBase } = await import('@/providers/core/codemie-auth-helpers.js');
      apiUrl = ensureApiBase(ssoUrl);
    } catch (error) {
      logger.debug('[skills] Skipping event emission: cannot resolve API base URL', error);
      return null;
    }
  }

  logger.debug('[skills] Built skill events transport', { apiUrl });
  return { apiUrl, cookieHeader, cliVersion: agentVersion };
}

function readPackageVersion(): string {
  try {
    const here = getDirname(import.meta.url);
    // Walk up from <root>/{src,dist}/cli/commands/skills/lib to <root>.
    const root = path.resolve(here, '..', '..', '..', '..', '..');
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return process.env.CODEMIE_CLI_VERSION ?? 'unknown';
  }
}
