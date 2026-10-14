/**
 * Profile Display Utility
 *
 * Reusable profile formatting for consistent display across commands.
 */

import chalk from 'chalk';
import type { ProviderProfile } from '../../../env/types.js';
import type { AuthStatus } from '../../../providers/core/types.js';
import { renderProfileInfo, type AuthStatusDisplay } from '../../../utils/profile.js';
import { resolveProfileModels } from '../../../utils/config.js';

/**
 * Profile information for display
 */
export interface ProfileInfo {
  name: string;
  active: boolean;
  profile: ProviderProfile;
  source?: 'local' | 'global';
}

/**
 * Resolved CodeMie identity of a profile for display: URL and the project text
 * with its binding state (see describeProjectBinding()). `project` undefined
 * means no Project line (providers without a CodeMie project).
 */
export interface ProfileIdentityDisplay {
  codeMieUrl?: string;
  project?: string;
}


/**
 * Profile display utility class
 */
export class ProfileDisplay {
  /**
   * Format a single profile
   *
   * @param info - Profile information
   * @returns Formatted string
   */
  static format(info: ProfileInfo, identity: ProfileIdentityDisplay = {}): string {
    const { name, active, profile, source } = info;

    const otherModels = resolveProfileModels(profile).filter(id => id !== profile.model);

    const baseInfo = renderProfileInfo({
      profile: name,
      provider: profile.provider || 'N/A',
      model: profile.model || 'N/A',
      otherModels,
      codeMieUrl: identity.codeMieUrl,
      project: identity.project,
      isActive: active
    });

    // Add source indicator if available
    if (source) {
      const sourceIndicator = source === 'local'
        ? chalk.yellow('  [Local]')
        : chalk.cyan('  [Global]');
      return baseInfo + sourceIndicator;
    }

    return baseInfo;
  }

  /**
   * Display list of profiles
   *
   * @param profiles - Array of profile information
   * @param identities - Resolved identity per profile name: each profile resolves
   *   its own URL and project, since two global profiles can target different
   *   CodeMie environments and projects
   */
  static formatList(
    profiles: ProfileInfo[],
    identities: Map<string, ProfileIdentityDisplay> = new Map()
  ): void {
    if (profiles.length === 0) {
      console.log(chalk.yellow('\nNo profiles found. Run "codemie setup" to create one.\n'));
      return;
    }

    console.log(chalk.bold.cyan('\n📋 All Profiles:\n'));

    profiles.forEach((profile, index) => {
      const formatted = this.format(profile, identities.get(profile.name));
      console.log(formatted);

      // Add separator between profiles except for the last one
      if (index < profiles.length - 1) {
        console.log(chalk.dim('─'.repeat(50)));
      }
    });

    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.bold('  Next Steps:'));
    console.log('');
    console.log('  ' + chalk.white('• Switch active profile:') + '  ' + chalk.cyan('codemie profile switch'));
    console.log('  ' + chalk.white('• View profile status:') + '    ' + chalk.cyan('codemie profile status'));
    console.log('  ' + chalk.white('• Refresh profile auth:') + '   ' + chalk.cyan('codemie profile refresh'));
    console.log('  ' + chalk.white('• Create new profile:') + '     ' + chalk.cyan('codemie setup'));
    console.log('  ' + chalk.white('• Remove a profile:') + '       ' + chalk.cyan('codemie profile delete'));
    console.log('  ' + chalk.white('• Explore more:') + '           ' + chalk.cyan('codemie --help'));
    console.log('');
  }

  /**
   * Display profile with authentication status
   *
   * @param info - Profile information
   * @param authStatus - Authentication status (optional)
   */
  static formatStatus(info: ProfileInfo, authStatus?: AuthStatus, identity: ProfileIdentityDisplay = {}): void {
    console.log(chalk.bold.cyan('\n📋 Profile Status:\n'));

    const { name, active, profile } = info;

    // Convert AuthStatus to AuthStatusDisplay
    const authStatusDisplay: AuthStatusDisplay | undefined = authStatus
      ? {
          authenticated: authStatus.authenticated,
          expiresAt: authStatus.expiresAt,
          apiUrl: authStatus.apiUrl
        }
      : undefined;

    const otherModels = resolveProfileModels(profile).filter(id => id !== profile.model);

    const formatted = renderProfileInfo({
      profile: name,
      provider: profile.provider || 'N/A',
      model: profile.model || 'N/A',
      otherModels,
      codeMieUrl: identity.codeMieUrl,
      project: identity.project,
      authStatus: authStatusDisplay,
      isActive: active
    });

    console.log(formatted);

    // Show login hint if not authenticated
    if (authStatus && !authStatus.authenticated) {
      console.log(chalk.yellow('💡 Run: codemie profile login'));
      console.log('');
    }
  }

}
