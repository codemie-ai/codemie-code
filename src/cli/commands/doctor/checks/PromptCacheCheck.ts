/**
 * Claude prompt-cache health check
 *
 * Reports which prompt-cache TTL a `codemie-claude` session started from this directory would ask
 * for, and which variable or Claude settings file decides it. It uses the same resolver as the
 * launch debug line, reads only (no settings file is written, nothing is spawned, no model request
 * is sent) and never fails doctor: anything other than the 1h TTL is a warning with the way to
 * remove it.
 */

import { AgentRegistry } from '@/agents/registry.js';
import {
  describePromptCacheSource,
  resolvePromptCacheSetup,
  type CacheSource,
  type PromptCacheSetup,
} from '@/agents/plugins/claude/prompt-cache.js';
import { ConfigLoader } from '@/utils/config.js';
import { getErrorMessage } from '@/utils/errors.js';
import { HealthCheck, HealthCheckDetail, HealthCheckResult } from '../types.js';

const CONFIRM_DETAIL: HealthCheckDetail = {
  status: 'info',
  message:
    'To confirm what is billed, run: codemie-claude -p "hi" --output-format json — then compare ' +
    'usage.cache_creation.ephemeral_1h_input_tokens with ephemeral_5m_input_tokens',
};

const UNREADABLE = 'unreadable settings';

/** How to remove what decided: unset the variable, delete the key from the file, or repair the file. */
function removalHint(decidedBy: string, source: CacheSource): string {
  if (source.kind === 'settings') {
    return decidedBy === UNREADABLE
      ? `Fix the JSON or the permissions of ${source.path}`
      : `Remove ${decidedBy} from ${source.path}`;
  }
  if (source.kind === 'shell') return `unset ${decidedBy}`;
  return 'Set ENABLE_PROMPT_CACHING_1H=1 in the shell';
}

function decidedByText(decidedBy: string, value: string | undefined, source: CacheSource): string {
  return `${decidedBy}${value === undefined ? '' : `=${value}`}, from ${describePromptCacheSource(source)}`;
}

function outcomeDetail(setup: PromptCacheSetup, provider: string | undefined): HealthCheckDetail {
  const decided = decidedByText(setup.decidedBy, setup.value, setup.source);

  if (setup.ttl === '1h') {
    return setup.confirmed
      ? { status: 'ok', message: `1h cache TTL requested (${decided})` }
      : { status: 'info', message: '1h requested, not confirmed on this provider path' };
  }

  if (provider === 'bedrock' && setup.source.kind === 'upstream-default') {
    return {
      status: 'info',
      message: "CodeMie's 1h default is not applied on bedrock (known gap); the Claude Code default TTL is in effect",
    };
  }

  const state = setup.ttl === 'disabled' ? 'Prompt caching disabled' : `Cache TTL ${setup.ttl}`;
  return {
    status: 'warn',
    message: `${state} (${decided})`,
    hint: removalHint(setup.decidedBy, setup.source),
  };
}

export class PromptCacheCheck implements HealthCheck {
  name = 'Claude Prompt Cache';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    try {
      const installedAgents = await AgentRegistry.getInstalledAgents();
      if (!installedAgents.some((agent) => agent.name === 'claude')) {
        details.push({ status: 'info', message: 'Claude Code not installed (skipped)' });
        return { name: this.name, success: true, details };
      }

      const config = await ConfigLoader.load();
      const provider = config.provider;
      const cwd = process.cwd();
      const setup = await resolvePromptCacheSetup({
        env: { ...process.env, CODEMIE_PROVIDER: provider },
        // bedrock replaces the agent's default beforeRun, so CodeMie's cache defaults are not applied there.
        codemieDefaults: provider !== 'bedrock',
        cwd,
      });

      details.push({ status: 'info', message: `Profile "${config.name ?? 'default'}", evaluated in ${cwd}` });
      details.push(outcomeDetail(setup, provider));

      if (setup.subagent && setup.subagent.ttl !== '1h') {
        const { ttl, decidedBy, source } = setup.subagent;
        details.push({
          status: 'warn',
          message: `Subagent cache TTL ${ttl} (${decidedByText(decidedBy, undefined, source)})`,
          hint: removalHint(decidedBy, source),
        });
      }

      details.push(CONFIRM_DETAIL);
    } catch (error) {
      return {
        name: this.name,
        success: true,
        details: [{ status: 'warn', message: `Could not evaluate the prompt-cache setup: ${getErrorMessage(error)}` }],
      };
    }

    return { name: this.name, success: true, details };
  }
}
