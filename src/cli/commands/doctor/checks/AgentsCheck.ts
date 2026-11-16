/**
 * Installed agents health check
 *
 * Reports each installed agent's version against the version CodeMie
 * recommends: a supported version is `ok`, any other is a `warn` carrying the
 * recommendation, and a version below the minimum supported one is an `error`
 * (that is the only version state that actually blocks the agent).
 *
 * Under each agent that declares launch defaults it also shows the launch
 * configuration that agent ends up running with: every variable (or settings
 * key) it declares, the effective value and where it came from (agent settings
 * file, shell, provider, profile or CodeMie default). Reads only: nothing is
 * launched, written or sent.
 */

import { AgentRegistry } from '../../../../agents/registry.js';
import type { AgentAdapter } from '../../../../agents/core/types.js';
import {
  describeLaunchEnv,
  formatLaunchEnvReport,
  providerAgentEnv,
} from '../../../../agents/core/launch-env.js';
import { agentDefaultHookRuns } from '../../../../agents/core/lifecycle-helpers.js';
import { ConfigLoader } from '../../../../utils/config.js';
import { getErrorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../utils/security.js';
import { safeTerminalValue } from '../../../../utils/terminal-text.js';
import { WRAPPER_PID_ENV } from '../../../../utils/processes.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

const INSIDE_SESSION_NOTE =
  'Running inside a CodeMie agent session: launch variables are inherited; run doctor from a plain terminal for a clean reading';

/** What every agent's launch config is evaluated against, built once per doctor run. */
interface LaunchContextBase {
  shellEnv: NodeJS.ProcessEnv;
  provider?: string;
  profileName: string;
  cwd: string;
}

/** Top-level lines shown before the agents, and the context for their children (absent when the profile failed to load). */
interface LaunchSetup {
  preamble: HealthCheckDetail[];
  base?: LaunchContextBase;
}

function hasLaunchConfig(agent: AgentAdapter): boolean {
  return (agent.getLaunchEnvDefaults?.().length ?? 0) > 0;
}

export interface AgentsCheckOptions {
  /** Profile to evaluate launch config for (`codemie doctor --profile`); the active profile when omitted. */
  profile?: string;
}

export class AgentsCheck implements ItemWiseHealthCheck {
  name = 'Installed Agents';

  constructor(private readonly options: AgentsCheckOptions = {}) {}

  /**
   * Check if agent was installed via deprecated npm method
   * Returns warning detail if npm install detected, null otherwise
   */
  private async checkDeprecatedInstallation(
    agent: AgentAdapter,
    versionStr: string
  ): Promise<HealthCheckDetail | null> {
    if (agent.getInstallationMethod) {
      const method = await agent.getInstallationMethod();
      if (method === 'npm') {
        return {
          status: 'warn',
          message: `${agent.displayName}${versionStr} - installed via npm (deprecated, use: codemie install claude --supported)`
        };
      }
    }
    return null;
  }

  private async buildDetail(agent: AgentAdapter): Promise<HealthCheckDetail> {
    const version = await agent.getVersion();
    const versionStr = version ? ` (${version})` : '';

    const deprecationWarning = await this.checkDeprecatedInstallation(agent, versionStr);
    if (deprecationWarning) {
      return deprecationWarning;
    }

    if (!version || !agent.checkVersionCompatibility) {
      return { status: 'ok', message: `${agent.displayName}${versionStr}` };
    }

    const compat = await agent.checkVersionCompatibility();

    if (compat.isBelowMinimum) {
      return {
        status: 'error',
        message: `${agent.displayName}${versionStr} - below minimum supported v${compat.minimumSupportedVersion}`,
        hint: `codemie install ${agent.name} --supported`
      };
    }

    if (!compat.isSupported) {
      return {
        status: 'warn',
        message: `${agent.displayName}${versionStr} - CodeMie recommends v${compat.supportedVersion}`,
        hint: `codemie install ${agent.name} --supported`
      };
    }

    return { status: 'ok', message: `${agent.displayName}${versionStr}` };
  }

  /** Loads the active profile once, only when some agent has launch config to show. */
  private async setupLaunchContext(agents: AgentAdapter[]): Promise<LaunchSetup> {
    if (!agents.some(hasLaunchConfig)) return { preamble: [] };

    const shellEnv = process.env;
    const cwd = process.cwd();
    try {
      const config = await ConfigLoader.load(
        cwd,
        this.options.profile ? { name: this.options.profile } : undefined
      );
      const profileName = config.name ?? 'default';
      const preamble: HealthCheckDetail[] = [
        { status: 'info', message: `Profile "${safeTerminalValue(profileName)}", evaluated in ${safeTerminalValue(cwd)}` },
      ];
      if (shellEnv[WRAPPER_PID_ENV]) preamble.push({ status: 'info', message: INSIDE_SESSION_NOTE });

      // The launcher always sets CODEMIE_PROVIDER and CODEMIE_PROFILE_CONFIG from the loaded profile
      // (AgentCLI), overwriting any inherited value, so doctor does the same.
      const launchEnv: NodeJS.ProcessEnv = {
        ...shellEnv,
        CODEMIE_PROVIDER: config.provider,
        CODEMIE_PROFILE_CONFIG: JSON.stringify(config),
      };
      return { preamble, base: { shellEnv: launchEnv, provider: config.provider, profileName, cwd } };
    } catch (error) {
      return {
        // The profile can come from the repository's own config file, so its parse error can quote it.
        preamble: [
          {
            status: 'warn',
            message: `Launch config not shown: could not load the profile (${safeTerminalValue(getErrorMessage(error))})`,
          },
        ],
      };
    }
  }

  private async launchChildren(agent: AgentAdapter, base: LaunchContextBase): Promise<HealthCheckDetail[]> {
    const defaults = agent.getLaunchEnvDefaults?.() ?? [];
    try {
      const settingsLayers = (await agent.readLaunchSettingsLayers?.(base.cwd, base.shellEnv)) ?? [];
      const report = describeLaunchEnv(defaults, {
        shellEnv: base.shellEnv,
        defaultsApply: agentDefaultHookRuns('beforeRun', base.provider, agent.name),
        settingsLayers,
        providerEnv: providerAgentEnv(base.provider, agent.name),
      });
      return formatLaunchEnvReport(report, { provider: base.provider, profileName: base.profileName });
    } catch (error) {
      logger.debug('[doctor] launch config', ...sanitizeLogArgs({ agent: agent.name, error: getErrorMessage(error) }));
      return [{ status: 'info', message: `launch config unavailable: ${safeTerminalValue(getErrorMessage(error))}` }];
    }
  }

  private async buildAgentDetail(agent: AgentAdapter, base: LaunchContextBase | undefined): Promise<HealthCheckDetail> {
    const detail = await this.buildDetail(agent);
    if (!base || !hasLaunchConfig(agent)) return detail;
    const children = await this.launchChildren(agent, base);
    return children.length > 0 ? { ...detail, children } : detail;
  }

  private result(details: HealthCheckDetail[]): HealthCheckResult {
    return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
  }

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      const { preamble, base } = await this.setupLaunchContext(installedAgents);
      details.push(...preamble);
      const agentDetails = await Promise.all(
        installedAgents.map((agent) => this.buildAgentDetail(agent, base))
      );
      details.push(...agentDetails);
    } else {
      details.push({
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)'
      });
    }

    return this.result(details);
  }

  async runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void
  ): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      const { preamble, base } = await this.setupLaunchContext(installedAgents);
      for (const line of preamble) {
        details.push(line);
        onDisplayItem(line);
      }
      for (const agent of installedAgents) {
        onStartItem(`Checking ${agent.displayName}...`);
        const detail = await this.buildAgentDetail(agent, base);
        details.push(detail);
        onDisplayItem(detail);
      }
    } else {
      const detail: HealthCheckDetail = {
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)'
      };
      details.push(detail);
      onDisplayItem(detail);
    }

    return this.result(details);
  }
}
