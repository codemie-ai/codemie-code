/**
 * Installed agents health check
 *
 * Displays each installed agent's version and its "verification status"
 * against the running CodeMie version:
 *  - Acknowledged — a one-time-warning marker exists for the tuple.
 *  - Untested     — installed but no marker yet.
 *  - Not installed — `getVersion()` returned null.
 *
 * See EPMCDME-13734 / spec.md for the semantics.
 */

import { AgentRegistry } from '../../../../agents/registry.js';
import { AgentAdapter } from '../../../../agents/core/types.js';
import { VersionWarningStore } from '../../../../utils/version-warnings.js';
import { getCurrentCliVersion } from '../../../../utils/cli-updater.js';
import { logger } from '../../../../utils/logger.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class AgentsCheck implements ItemWiseHealthCheck {
  name = 'Installed Agents';

  /**
   * Check if agent was installed via deprecated npm method
   * Returns warning detail if npm install detected, null otherwise
   */
  private async checkDeprecatedInstallation(
    agent: AgentAdapter,
    versionStr: string,
  ): Promise<HealthCheckDetail | null> {
    if (agent.getInstallationMethod) {
      const method = await agent.getInstallationMethod();
      if (method === 'npm') {
        return {
          status: 'warn',
          message: `${agent.displayName}${versionStr} - installed via npm (deprecated, use: codemie install ${agent.name} --latest)`,
        };
      }
    }
    return null;
  }

  private async buildDetail(
    agent: AgentAdapter,
    codemieVersion: string,
  ): Promise<HealthCheckDetail> {
    const version = await agent.getVersion();
    if (!version) {
      return { status: 'info', message: `${agent.displayName} — Not installed` };
    }

    const versionStr = ` (${version})`;
    const deprecationWarning = await this.checkDeprecatedInstallation(agent, versionStr);
    if (deprecationWarning) {
      return deprecationWarning;
    }

    let acknowledged = false;
    try {
      acknowledged = await VersionWarningStore.hasWarned(agent.name, version);
    } catch (err) {
      // A store read failure must NEVER crash `codemie doctor` — degrade to
      // "Untested" so the user still sees the row.
      logger.warn('[AgentsCheck] VersionWarningStore.hasWarned failed; treating as Untested', {
        agent: agent.name,
        err: String(err),
      });
    }
    if (acknowledged) {
      return {
        status: 'ok',
        message: `${agent.displayName}${versionStr} — Acknowledged with CodeMie ${codemieVersion}`,
      };
    }
    return {
      status: 'warn',
      message: `${agent.displayName}${versionStr} — Untested with CodeMie ${codemieVersion}`,
    };
  }

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    const success = true;

    const installedAgents = await AgentRegistry.getInstalledAgents();
    const codemieVersion = (await getCurrentCliVersion()) ?? 'unknown';

    if (installedAgents.length > 0) {
      const detailResults = await Promise.all(
        installedAgents.map((agent) => this.buildDetail(agent, codemieVersion)),
      );
      for (const detail of detailResults) {
        details.push(detail);
      }
    } else {
      details.push({
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)',
      });
    }

    return { name: this.name, success, details };
  }

  async runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void,
  ): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    const success = true;

    const installedAgents = await AgentRegistry.getInstalledAgents();
    const codemieVersion = (await getCurrentCliVersion()) ?? 'unknown';

    if (installedAgents.length > 0) {
      for (const agent of installedAgents) {
        onStartItem(`Checking ${agent.displayName}...`);
        const detail = await this.buildDetail(agent, codemieVersion);
        details.push(detail);
        onDisplayItem(detail);
      }
    } else {
      const detail: HealthCheckDetail = {
        status: 'info',
        message: 'No agents installed (CodeMie Code is built-in)',
      };
      details.push(detail);
      onDisplayItem(detail);
    }

    return { name: this.name, success, details };
  }
}
