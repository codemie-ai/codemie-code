import { execSync, spawn } from 'child_process';
import { ClientAdapter } from '../registry.js';
import { logger } from '../../utils/logger.js';
import * as os from 'os';

export class GitLabClientAdapter implements ClientAdapter {
  name = 'gitlab';
  displayName = 'GitLab CLI';
  description = 'Official GitLab command-line tool (glab)';
  cliCommand = 'glab';

  async isInstalled(): Promise<boolean> {
    try {
      execSync('glab --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const output = execSync('glab --version', { encoding: 'utf-8' });
      // Extract version from output like "glab version 1.36.0 (2024-01-10)"
      const match = output.match(/glab version (\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async install(): Promise<void> {
    const platform = os.platform();

    logger.info(`Installing GitLab CLI (glab)...`);

    try {
      switch (platform) {
        case 'darwin': // macOS
          await this.installOnMac();
          break;
        case 'linux':
          await this.installOnLinux();
          break;
        case 'win32':
          await this.installOnWindows();
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      logger.success('GitLab CLI installed successfully!');
    } catch (error) {
      logger.error('Failed to install GitLab CLI');
      throw error;
    }
  }

  private async installOnMac(): Promise<void> {
    try {
      // Check if Homebrew is available
      execSync('which brew', { stdio: 'ignore' });
      execSync('brew install glab', { stdio: 'inherit' });
    } catch {
      throw new Error('Homebrew is required to install glab on macOS. Install from: https://brew.sh');
    }
  }

  private async installOnLinux(): Promise<void> {
    // Try to detect package manager
    try {
      execSync('which apt-get', { stdio: 'ignore' });
      // Debian/Ubuntu
      execSync('sudo apt-get update', { stdio: 'inherit' });
      execSync('sudo apt-get install glab -y', { stdio: 'inherit' });
      return;
    } catch {
      // Not Debian/Ubuntu or glab not in default repos
    }

    try {
      execSync('which yum', { stdio: 'ignore' });
      // RHEL/Fedora/CentOS
      execSync('sudo dnf install glab -y', { stdio: 'inherit' });
      return;
    } catch {
      // Not RHEL
    }

    throw new Error('Could not detect package manager or glab not available. Please install glab manually: https://gitlab.com/gitlab-org/cli');
  }

  private async installOnWindows(): Promise<void> {
    throw new Error('Please install GitLab CLI manually from: https://gitlab.com/gitlab-org/cli');
  }

  async uninstall(): Promise<void> {
    const platform = os.platform();

    logger.info('Uninstalling GitLab CLI...');

    try {
      switch (platform) {
        case 'darwin':
          execSync('brew uninstall glab', { stdio: 'inherit' });
          break;
        case 'linux':
          try {
            execSync('which apt-get', { stdio: 'ignore' });
            execSync('sudo apt remove glab -y', { stdio: 'inherit' });
          } catch {
            execSync('sudo dnf remove glab -y', { stdio: 'inherit' });
          }
          break;
        default:
          throw new Error('Please uninstall GitLab CLI manually');
      }

      logger.success('GitLab CLI uninstalled successfully');
    } catch (error) {
      logger.error('Failed to uninstall GitLab CLI');
      throw error;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      execSync('glab auth status', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    logger.info('Starting GitLab authentication...');

    return new Promise((resolve, reject) => {
      const authProcess = spawn('glab', ['auth', 'login'], {
        stdio: 'inherit',
        shell: true
      });

      authProcess.on('close', (code) => {
        if (code === 0) {
          logger.success('GitLab authentication successful!');
          resolve();
        } else {
          reject(new Error('GitLab authentication failed'));
        }
      });

      authProcess.on('error', (error) => {
        reject(error);
      });
    });
  }
}
