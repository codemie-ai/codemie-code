/**
 * Installed agents health check
 */

import { AgentRegistry } from '../../../../agents/registry.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class AgentsCheck implements ItemWiseHealthCheck {
  name = 'Installed Agents';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const installedAgents = await AgentRegistry.getInstalledAgents();

    if (installedAgents.length > 0) {
      for (const agent of installedAgents) {
        const version = await agent.getVersion();
        const versionStr = version ? ` (${version})` : '';
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
