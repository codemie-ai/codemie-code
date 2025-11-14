import { execSync, spawn } from 'child_process';
import { ClientAdapter } from '../registry.js';
import { logger } from '../../utils/logger.js';
import * as os from 'os';

export class GitHubClientAdapter implements ClientAdapter {
  name = 'github';
  displayName = 'GitHub CLI';
  description = 'Official GitHub command-line tool (gh)';
  cliCommand = 'gh';

  async isInstalled(): Promise<boolean> {
    try {
      execSync('gh --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const output = execSync('gh --version', { encoding: 'utf-8' });
      // Extract version from output like "gh version 2.40.0 (2023-12-13)"
      const match = output.match(/gh version (\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async install(): Promise<void> {
    const platform = os.platform();

    logger.info(`Installing GitHub CLI (gh)...`);

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

      logger.success('GitHub CLI installed successfully!');
    } catch (error) {
      logger.error('Failed to install GitHub CLI');
      throw error;
    }
  }

  private async installOnMac(): Promise<void> {
    try {
      // Check if Homebrew is available
      execSync('which brew', { stdio: 'ignore' });
      execSync('brew install gh', { stdio: 'inherit' });
    } catch {
      throw new Error('Homebrew is required to install gh on macOS. Install from: https://brew.sh');
    }
  }

  private async installOnLinux(): Promise<void> {
    // Try to detect package manager
    try {
      execSync('which apt-get', { stdio: 'ignore' });
      // Debian/Ubuntu
      execSync('type -p curl >/dev/null || (sudo apt update && sudo apt install curl -y)', { stdio: 'inherit' });
      execSync('curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg', { stdio: 'inherit' });
      execSync('sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg', { stdio: 'inherit' });
      execSync('echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null', { stdio: 'inherit' });
      execSync('sudo apt update && sudo apt install gh -y', { stdio: 'inherit' });
      return;
    } catch {
      // Not Debian/Ubuntu
    }

    try {
      execSync('which yum', { stdio: 'ignore' });
      // RHEL/Fedora/CentOS
      execSync('sudo dnf install gh -y', { stdio: 'inherit' });
      return;
    } catch {
      // Not RHEL
    }

    throw new Error('Could not detect package manager. Please install gh manually: https://github.com/cli/cli/blob/trunk/docs/install_linux.md');
  }

  private async installOnWindows(): Promise<void> {
    throw new Error('Please install GitHub CLI manually from: https://cli.github.com/');
  }

  async uninstall(): Promise<void> {
    const platform = os.platform();

    logger.info('Uninstalling GitHub CLI...');

    try {
      switch (platform) {
        case 'darwin':
          execSync('brew uninstall gh', { stdio: 'inherit' });
          break;
        case 'linux':
          try {
            execSync('which apt-get', { stdio: 'ignore' });
            execSync('sudo apt remove gh -y', { stdio: 'inherit' });
          } catch {
            execSync('sudo dnf remove gh -y', { stdio: 'inherit' });
          }
          break;
        default:
          throw new Error('Please uninstall GitHub CLI manually');
      }

      logger.success('GitHub CLI uninstalled successfully');
    } catch (error) {
      logger.error('Failed to uninstall GitHub CLI');
      throw error;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      execSync('gh auth status', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    logger.info('Starting GitHub authentication...');

    return new Promise((resolve, reject) => {
      const authProcess = spawn('gh', ['auth', 'login'], {
        stdio: 'inherit',
        shell: true
      });

      authProcess.on('close', (code) => {
        if (code === 0) {
          logger.success('GitHub authentication successful!');
          resolve();
        } else {
          reject(new Error('GitHub authentication failed'));
        }
      });

      authProcess.on('error', (error) => {
        reject(error);
      });
    });
  }
}
