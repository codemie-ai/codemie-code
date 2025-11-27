/**
 * Repository & Workflows health check
 */

import { detectVCSProvider, listInstalledWorkflows } from '../../../../workflows/index.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class WorkflowsCheck implements HealthCheck {
  name = 'Repository & Workflows';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    const vcsDetection = detectVCSProvider();

    if (vcsDetection.isGitRepo) {
      details.push({
        status: 'ok',
        message: 'Git repository detected'
      });

      if (vcsDetection.provider) {
        details.push({
          status: 'ok',
          message: `Provider: ${vcsDetection.provider}`
        });

        if (vcsDetection.remoteUrl) {
          details.push({
            status: 'info',
            message: `Remote: ${vcsDetection.remoteUrl}`
          });
        }

        // List installed workflows
        const installedWorkflows = listInstalledWorkflows(vcsDetection.provider);
        if (installedWorkflows.length > 0) {
          details.push({
            status: 'ok',
            message: `${installedWorkflows.length} workflow(s) installed`
          });
          installedWorkflows.forEach(workflow => {
            const fileName = workflow.split('/').pop();
            details.push({
              status: 'info',
              message: `  • ${fileName}`
            });
          });
        } else {
          details.push({
            status: 'info',
            message: 'No workflows installed',
            hint: 'Install workflows with: codemie workflow install <workflow-id>'
          });
        }
      } else {
        details.push({
          status: 'warn',
          message: 'VCS provider not detected'
        });
        if (vcsDetection.remoteUrl) {
          details.push({
            status: 'info',
            message: `Remote URL: ${vcsDetection.remoteUrl}`
          });
        }
      }
    } else {
      details.push({
        status: 'info',
        message: 'Not a git repository'
      });
    }

    return { name: this.name, success, details };
  }
}
