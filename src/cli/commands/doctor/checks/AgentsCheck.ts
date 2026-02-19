/**
 * Installed agents health check
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

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      // Parallelize version + installation method checks across all agents
      const agentResults = await Promise.all(
        installedAgents.map(async (agent) => {
          const version = await agent.getVersion();
          const versionStr = version ? ` (${version})` : '';
          const deprecationWarning = await this.checkDeprecatedInstallation(agent, versionStr);
          return { agent, versionStr, deprecationWarning };
        })
      );

      for (const { agent, versionStr, deprecationWarning } of agentResults) {
        if (deprecationWarning) {
          details.push(deprecationWarning);
          continue;
        }

        details.push({
          status: 'ok',
          message: `${agent.displayName}${versionStr}`
        });
      }
    } else {
      details.push({
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)'
      });
    }

    return { name: this.name, success, details };
  }

  async runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void
  ): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      for (const agent of installedAgents) {
        onStartItem(`Checking ${agent.displayName}...`);
        const version = await agent.getVersion();
        const versionStr = version ? ` (${version})` : '';

        // Check for deprecated npm installation
        const deprecationWarning = await this.checkDeprecatedInstallation(agent, versionStr);
        if (deprecationWarning) {
          details.push(deprecationWarning);
          onDisplayItem(deprecationWarning);
          continue;
        }

        const detail: HealthCheckDetail = {
          status: 'ok',
          message: `${agent.displayName}${versionStr}`
        };
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

    return { name: this.name, success, details };
  }
}
