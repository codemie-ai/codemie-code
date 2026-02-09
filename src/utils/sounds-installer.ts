/**
 * Sounds Installer
 *
 * Automated installation of the sound hooks system for Claude Code.
 * Creates hook directories, installs play-random-sound.sh script, and configures hooks.
 */

import chalk from 'chalk';
import ora from 'ora';
import { homedir } from 'os';
import { exec } from './processes.js';
import {getClaudeGlobalPath, getDirname} from './paths.js';
import { existsSync } from 'fs';
import { mkdir, copyFile, chmod, access } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import { createErrorContext } from './errors.js';
import type { HooksConfiguration } from '../hooks/types.js';

/**
 * Check if required audio player is available
 * @returns Audio player command name if found, null otherwise
 */
async function checkAudioPlayer(): Promise<string | null> {
  const players = ['afplay', 'aplay', 'paplay', 'mpg123'];

  for (const player of players) {
    try {
      await exec('command', ['-v', player]);
      return player;
    } catch {
      // Player not found, try next
    }
  }

  return null;
}

/**
 * Create hook directories for sound files
 */
async function createHookDirectories(): Promise<void> {
  const hooksDir = getClaudeGlobalPath('hooks');
  const directories = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'];

  // Create directories in parallel for better performance
  await Promise.all(
    directories.map(dir => mkdir(join(hooksDir, dir), { recursive: true }))
  );
}

/**
 * Install play-random-sound.sh script to hooks directory
 */
async function installSoundScript(): Promise<void> {
  const hooksDir = getClaudeGlobalPath('hooks');
  const targetScript = join(hooksDir, 'play-random-sound.sh');

  // Try plugin installation path first (cross-platform home directory)
  const pluginScriptPath = join(
    homedir(),
    '.codemie',
    'claude-plugin',
    'scripts',
    'play-random-sound.sh'
  );

  // Fallback to development path
  const devScriptPath = join(
    getDirname(import.meta.url),
    '..',
    'agents',
    'plugins',
    'claude',
    'plugin',
    'addons',
    'scripts',
    'play-random-sound.sh'
  );

  let sourceScript = pluginScriptPath;

  // Check if plugin path exists, otherwise use dev path
  try {
    await access(pluginScriptPath);
  } catch (error) {
    logger.debug('Plugin script not found, using development path', {
      pluginPath: pluginScriptPath,
      fallbackPath: devScriptPath,
      error: error instanceof Error ? error.message : String(error)
    });
    sourceScript = devScriptPath;
  }

  // Copy script
  await copyFile(sourceScript, targetScript);

  // Make executable
  await chmod(targetScript, 0o755);
}

/**
 * Build hooks configuration for sound system
 * @returns HooksConfiguration object with sound hooks
 */
export function buildSoundHooksConfig(): HooksConfiguration {
  const hooksDir = getClaudeGlobalPath('hooks');
  const scriptPath = join(hooksDir, 'play-random-sound.sh');

  return {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: `${scriptPath} ${join(hooksDir, 'SessionStart')}`
          }
        ]
      }
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: `${scriptPath} ${join(hooksDir, 'UserPromptSubmit')}`
          }
        ]
      }
    ],
    PermissionRequest: [
        {
            hooks: [
                {
                    type: 'command',
                    command: `${scriptPath} ${join(hooksDir, 'PermissionRequest')}`
                }
            ]
        }
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: `${scriptPath} ${join(hooksDir, 'Stop')}`
          }
        ]
      }
    ]
  };
}

/**
 * Display post-installation instructions
 *
 * NOTE: This function violates typical utils layer pattern by handling UI directly.
 * This is an intentional exception because:
 * 1. The instructions are tightly coupled to the installation implementation details
 * 2. The installation function is only called from CLI contexts (setup command)
 * 3. Extracting to CLI layer would require passing extensive path information
 *
 * Future refactor: Consider returning an InstallationResult data structure
 * and moving display logic to CLI layer if this utility needs reuse in non-CLI contexts.
 */
function displayPostInstallInstructions(): void {
  const hooksDir = getClaudeGlobalPath('hooks');

  console.log();
  console.log(chalk.bold.green('🎉 Sounds installed successfully!'));
  console.log();
  console.log(chalk.cyan('📂 Next Steps:'));
  console.log();
  console.log(chalk.white('1. Download your favorite sound effects (WAV or MP3 format)'));
  console.log(chalk.white('2. Add them to these directories:'));
  console.log(chalk.dim(`   ${join(hooksDir, 'SessionStart')}/`), chalk.white('(plays when starting)'));
  console.log(chalk.dim(`   ${join(hooksDir, 'UserPromptSubmit')}/`), chalk.white('(plays when you send a message)'));
  console.log(chalk.dim(`   ${join(hooksDir, 'PermissionRequest')}/`), chalk.white('(plays when you claude asks for clarification or permission)'));
  console.log(chalk.dim(`   ${join(hooksDir, 'Stop')}/`), chalk.white('(plays when Claude completes)'));
  console.log();
  console.log(chalk.white('💡 Suggestions:'));
  console.log(chalk.dim('   • SessionStart:'), chalk.white('Welcome sounds, greetings'));
  console.log(chalk.dim('   • UserPromptSubmit:'), chalk.white('Acknowledgment sounds (e.g., "Roger")'));
  console.log(chalk.dim('   • PermissionRequest:'), chalk.white('Question sounds (e.g., "Proceed?")'));
  console.log(chalk.dim('   • Stop:'), chalk.white('Completion sounds (e.g., "Done")'));
  console.log();
  console.log(chalk.white('🎮 Example sound packs:'));
  console.log(chalk.dim('   • Warcraft peon sounds (classic "Work work", "Yes milord")'));
  console.log(chalk.dim('   • StarCraft unit acknowledgments'));
  console.log(chalk.dim('   • Portal 2 GLaDOS quotes'));
  console.log();
  console.log(chalk.white('💾 Where to download sounds:'));
  console.log(chalk.blueBright('   https://x.com/delba_oliveira/status/2020515010985005255'));
  console.log();
  console.log(chalk.dim(`⚙️  Hooks configuration saved in: ${getClaudeGlobalPath('settings.json')}`));
  console.log(chalk.dim(`📜 Script location: ${join(hooksDir, 'play-random-sound.sh')}`));
  console.log();
}

/**
 * Claude settings structure
 */
interface ClaudeSettings {
  hooks?: HooksConfiguration;
  [key: string]: unknown;
}

/**
 * Save hooks configuration to Claude settings.json
 * Merges with existing configuration to preserve other settings
 */
async function saveHooksToClaudeSettings(hooksConfig: HooksConfiguration): Promise<void> {
  const { readFile, writeFile } = await import('fs/promises');
  const settingsPath = getClaudeGlobalPath('settings.json');

  let existingSettings: ClaudeSettings = {};

  // Try to read existing settings
  try {
    const settingsContent = await readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(settingsContent);

    // Validate structure - must be a non-null object (not an array)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existingSettings = parsed as ClaudeSettings;
    } else {
      logger.warn('Invalid settings.json structure, creating new file', {
        type: typeof parsed,
        isArray: Array.isArray(parsed)
      });
      existingSettings = {};
    }
  } catch (error) {
    // File doesn't exist or is invalid JSON - start with empty object
    logger.debug('No existing Claude settings found, creating new file', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Merge hooks configuration
  existingSettings.hooks = hooksConfig;

  // Write back to file with pretty formatting
  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2), 'utf-8');
}

/**
 * Install fun sounds system
 * Creates directories, installs script, and saves hooks configuration to ~/.claude/settings.json
 *
 * @returns Hooks configuration object if successful, null if installation failed
 */
export async function installSounds(): Promise<HooksConfiguration | null> {
  try {
    // 1. Pre-flight: Check audio player
    const spinner = ora('Checking audio player...').start();
    const audioPlayer = await checkAudioPlayer();

    if (!audioPlayer) {
      spinner.fail(chalk.red('No audio player found'));
      console.log();
      console.log(chalk.yellow('Please install an audio player first:'));
      console.log(chalk.white('  macOS:'), chalk.dim('afplay (built-in)'));
      console.log(chalk.white('  Linux:'), chalk.dim('sudo apt install alsa-utils (aplay)'));
      console.log(chalk.white('         '), chalk.dim('or sudo apt install pulseaudio-utils (paplay)'));
      console.log(chalk.white('  Windows:'), chalk.dim('Install mpg123 via Chocolatey: choco install mpg123'));
      console.log(chalk.white('  Alternative:'), chalk.dim('brew install mpg123 (macOS), sudo apt install mpg123 (Linux)'));
      console.log();
      return null;
    }

    spinner.succeed(chalk.green(`Audio player found: ${audioPlayer}`));

    // 2. Create hook directories
    const dirSpinner = ora('Creating hook directories...').start();
    await createHookDirectories();
    dirSpinner.succeed(chalk.green('Hook directories created'));

    // 3. Install sound script
    const scriptSpinner = ora('Installing play-random-sound.sh...').start();
    try {
      await installSoundScript();
      scriptSpinner.succeed(chalk.green('Sound script installed'));
    } catch (error) {
      scriptSpinner.fail(chalk.red('Failed to install sound script'));
      const errorContext = createErrorContext(error);
      logger.error('Sound script installation failed', {
        ...errorContext,
        operation: 'installSoundScript'
      });
      throw error;
    }

    // 4. Build hooks configuration
    const hooksConfig = buildSoundHooksConfig();

    // 5. Save hooks configuration to Claude settings.json
    const saveSpinner = ora('Saving hooks configuration...').start();
    try {
      await saveHooksToClaudeSettings(hooksConfig);
      saveSpinner.succeed(chalk.green('Hooks configuration saved to ~/.claude/settings.json'));
    } catch (error) {
      saveSpinner.fail(chalk.red('Failed to save hooks configuration'));
      const errorContext = createErrorContext(error);
      logger.error('Failed to save hooks to settings.json', {
        ...errorContext,
        operation: 'saveHooksToClaudeSettings',
        settingsPath: getClaudeGlobalPath('settings.json')
      });
      throw error;
    }

    // 6. Display post-install instructions
    displayPostInstallInstructions();

    return hooksConfig;

  } catch (error) {
    const errorContext = createErrorContext(error);
    logger.error('Sounds installation failed', {
      ...errorContext,
      operation: 'installSounds'
    });
    console.log();
    console.log(chalk.red('❌ Sounds installation failed'));
    console.log(chalk.yellow('You can try again later by running: codemie setup --sounds'));
    console.log();
    return null;
  }
}

/**
 * Check if fun sounds are already installed
 * @returns true if hooks directory and script exist
 */
export function isSoundsInstalled(): boolean {
  const hooksDir = getClaudeGlobalPath('hooks');
  const scriptPath = join(hooksDir, 'play-random-sound.sh');

  return existsSync(hooksDir) && existsSync(scriptPath);
}
