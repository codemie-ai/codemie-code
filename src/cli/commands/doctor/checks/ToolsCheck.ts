/**
 * VCS Tools health check
 */

import { checkAllTools, checkGitStatus, getToolStatusAsync } from '../../../../tools/index.js';
import { ItemWiseHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class ToolsCheck implements ItemWiseHealthCheck {
  name = 'VCS Tools';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const toolsStatus = checkAllTools();

    // Check git first
    if (toolsStatus.git.installed) {
      details.push({
        status: 'ok',
        message: `Git v${toolsStatus.git.version}`
      });
    } else {
      details.push({
        status: 'warn',
        message: 'Git not installed'
      });
    }

    // Check GitHub CLI
    if (toolsStatus.gh.installed) {
      const authStatus = toolsStatus.gh.authenticated
        ? `authenticated as ${toolsStatus.gh.authUser}`
        : 'not authenticated';
      const status = toolsStatus.gh.authenticated ? 'ok' : 'warn';
      details.push({
        status,
        message: `GitHub CLI (gh) v${toolsStatus.gh.version} - ${authStatus}`
      });
    } else {
      details.push({
        status: 'info',
        message: 'GitHub CLI (gh) not installed',
        hint: 'Install with: codemie tools install gh'
      });
    }

    // Check GitLab CLI
    if (toolsStatus.glab.installed) {
      const authStatus = toolsStatus.glab.authenticated
        ? `authenticated as ${toolsStatus.glab.authUser}`
        : 'not authenticated';
      const status = toolsStatus.glab.authenticated ? 'ok' : 'warn';
      details.push({
        status,
        message: `GitLab CLI (glab) v${toolsStatus.glab.version} - ${authStatus}`
      });
    } else {
      details.push({
        status: 'info',
        message: 'GitLab CLI (glab) not installed',
        hint: 'Install with: codemie tools install glab'
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

    // Check git first
    onStartItem('Checking Git...');
    const gitStatus = await checkGitStatus();
    if (gitStatus.installed) {
      const detail: HealthCheckDetail = {
        status: 'ok',
        message: `Git v${gitStatus.version}`
      };
      details.push(detail);
      onDisplayItem(detail);
    } else {
      const detail: HealthCheckDetail = {
        status: 'warn',
        message: 'Git not installed'
      };
      details.push(detail);
      onDisplayItem(detail);
    }

    // Check GitHub CLI
    onStartItem('Checking GitHub CLI (gh)...');
    const ghStatus = await getToolStatusAsync('gh');
    if (ghStatus.installed) {
      const authStatus = ghStatus.authenticated
        ? `authenticated as ${ghStatus.authUser}`
        : 'not authenticated';
      const status = ghStatus.authenticated ? 'ok' : 'warn';
      const detail: HealthCheckDetail = {
        status,
        message: `GitHub CLI (gh) v${ghStatus.version} - ${authStatus}`
      };
      details.push(detail);
      onDisplayItem(detail);
    } else {
      const detail: HealthCheckDetail = {
        status: 'info',
        message: 'GitHub CLI (gh) not installed',
        hint: 'Install with: codemie tools install gh'
      };
      details.push(detail);
      onDisplayItem(detail);
    }

    // Check GitLab CLI
    onStartItem('Checking GitLab CLI (glab)...');
    const glabStatus = await getToolStatusAsync('glab');
    if (glabStatus.installed) {
      const authStatus = glabStatus.authenticated
        ? `authenticated as ${glabStatus.authUser}`
        : 'not authenticated';
      const status = glabStatus.authenticated ? 'ok' : 'warn';
      const detail: HealthCheckDetail = {
        status,
        message: `GitLab CLI (glab) v${glabStatus.version} - ${authStatus}`
      };
      details.push(detail);
      onDisplayItem(detail);
    } else {
      const detail: HealthCheckDetail = {
        status: 'info',
        message: 'GitLab CLI (glab) not installed',
        hint: 'Install with: codemie tools install glab'
      };
      details.push(detail);
      onDisplayItem(detail);
    }

    return { name: this.name, success, details };
  }
}
