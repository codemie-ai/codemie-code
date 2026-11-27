/**
 * Installed agents health check
 *
 * Reports each installed agent's version against the version CodeMie
 * recommends: a supported version is `ok`, any other is a `warn` carrying the
 * recommendation, and a version below the minimum supported one is an `error`
 * (that is the only version state that actually blocks the agent).
 */

import { AgentRegistry } from '../../../../agents/registry.js';
import { AgentAdapter } from '../../../../agents/core/types.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';
import { formatNotOnPathHint, formatNotOnPathShort, type ShadowVerdict } from '../../../../utils/path-shadow.js';
import { formatPutAheadLine } from '../../../../utils/active-cli.js';
import { getPathModule } from '../../../../utils/platform.js';
import { logger } from '../../../../utils/logger.js';

const SHADOW_DEADLINE_MS = 5000;
const UNKNOWN_VERDICT: ShadowVerdict = { status: 'unknown' };

export class AgentsCheck implements ItemWiseHealthCheck {
  name = 'Installed Agents';

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

  /** Version detail, upgraded to a PATH-shadow warning when another install shadows the managed one. */
  private async buildDetail(agent: AgentAdapter): Promise<HealthCheckDetail> {
    const detail = await this.buildVersionDetail(agent);
    const verdict = await this.safeShadowVerdict(agent);
    if (verdict.status !== 'shadowed') return detail;

    const version = await agent.getVersion();
    const versionStr = version ? ` (${version})` : '';
    const activeDir = getPathModule(process.platform).dirname(verdict.active);
    const shadowMessage = `${agent.displayName}${versionStr} - another install shadows the CodeMie-managed one (active: ${verdict.active})`;
    const versionNote = detail.status === 'ok' ? '' : `; ${detail.message}`;
    return {
      status: detail.status === 'error' ? 'error' : 'warn',
      message: `${shadowMessage}${versionNote}`,
      hint: formatPutAheadLine(verdict.managedDir, activeDir)
    };
  }

  private async safeShadowVerdict(agent: AgentAdapter): Promise<ShadowVerdict> {
    if (!agent.checkPathShadow) return UNKNOWN_VERDICT;
    try {
      return await agent.checkPathShadow();
    } catch (error: unknown) {
      logger.debug('PATH shadow check failed', error);
      return UNKNOWN_VERDICT;
    }
  }

  /**
   * Agents isInstalled() reports false never reach the installed list, so a managed shim that
   * exists on disk but is off PATH is reported here. One shared deadline; unfinished -> unknown.
   */
  private async buildNotOnPathDetails(installed: AgentAdapter[]): Promise<HealthCheckDetail[]> {
    const candidates = AgentRegistry.getManageableAgents().filter((a) => !installed.includes(a));
    if (candidates.length === 0) return [];

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ShadowVerdict>((resolve) => {
      timer = setTimeout(() => resolve(UNKNOWN_VERDICT), SHADOW_DEADLINE_MS);
    });
    try {
      const verdicts = await Promise.all(
        candidates.map(async (agent): Promise<ShadowVerdict> => {
          if (!agent.checkPathShadow) return UNKNOWN_VERDICT;
          try {
            return await Promise.race([agent.checkPathShadow(), deadline]);
          } catch (error: unknown) {
            logger.debug('PATH shadow check failed', error);
            return UNKNOWN_VERDICT;
          }
        })
      );
      const details: HealthCheckDetail[] = [];
      verdicts.forEach((verdict, i) => {
        if (verdict.status !== 'missing-on-path') return;
        details.push({
          status: 'warn',
          message: `${candidates[i].displayName} - ${formatNotOnPathShort(verdict)}`,
          hint: formatNotOnPathHint(verdict).join('\n')
        });
      });
      return details;
    } finally {
      clearTimeout(timer);
    }
  }

  private async buildVersionDetail(agent: AgentAdapter): Promise<HealthCheckDetail> {
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

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      // Parallelize version + installation method checks across all agents
      const agentDetails = await Promise.all(
        installedAgents.map((agent) => this.buildDetail(agent))
      );
      details.push(...agentDetails);
    } else {
      details.push({
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)'
      });
    }
    details.push(...(await this.buildNotOnPathDetails(installedAgents)));

    return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
  }

  async runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void
  ): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      for (const agent of installedAgents) {
        onStartItem(`Checking ${agent.displayName}...`);
        const detail = await this.buildDetail(agent);
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

    for (const detail of await this.buildNotOnPathDetails(installedAgents)) {
      details.push(detail);
      onDisplayItem(detail);
    }

    return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
  }
}
