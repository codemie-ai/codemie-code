/**
 * Installed agents health check
 *
 * Reports each installed agent's version against the version CodeMie
 * recommends: a match is `ok`, a mismatch is a `warn` carrying the
 * recommendation, and a version below the minimum supported one is an `error`
 * (that is the only version state that actually blocks the agent).
 */

import { AgentRegistry } from '../../../../agents/registry.js';
import { AgentAdapter } from '../../../../agents/core/types.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

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

    if (version !== compat.supportedVersion) {
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

    return { name: this.name, success: !details.some((d) => d.status === 'error'), details };
  }
}
