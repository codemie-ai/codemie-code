/**
 * Sounds Installer
 *
 * Automated installation of the sound hooks system for Claude Code.
 * Creates hook directories, installs play-random-sound.sh script, and configures hooks.
 */

import chalk from 'chalk';
import ora from 'ora';
import {exec} from '../../../utils/exec.js';
import {getCodemiePath} from '@/utils/paths.js';
import {existsSync} from 'fs';
import {mkdir} from 'fs/promises';
import {join} from 'path';
import {logger} from '../../../utils/logger.js';
import {createErrorContext} from '../../../utils/errors.js';

/**
 * Check if required audio player is available
 * @returns Audio player command name if found, null otherwise
 */
async function checkAudioPlayer(): Promise<string | null> {
    const players = ['afplay', 'aplay', 'paplay', 'mpg123'];

    for (const player of players) {
        try {
            await exec('command', ['-v', player]);
            logger.debug('Audio player found', { player, feature: 'sounds' });
            return player;
        } catch (error) {
            // Log the specific error for debugging
            logger.debug('Audio player not available', {
                player,
                feature: 'sounds',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    logger.debug('No audio players found', {
        checkedPlayers: players,
        feature: 'sounds',
        note: 'User needs to install an audio player for sounds to work'
    });
    return null;
}

/**
 * Create hook directories for sound files
 */
async function createSoundDirectories(): Promise<void> {
    const soundsDir = getCodemiePath('sounds');
    const directories = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'];

    // Create directories in parallel for better performance
    await Promise.all(
        directories.map(dir => mkdir(join(soundsDir, dir), {recursive: true}))
    );
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
    const soundsDir = getCodemiePath('sounds');

    console.log();
    console.log(chalk.bold.green('🎉 Sounds installed successfully!'));
    console.log();
    console.log(chalk.cyan('📂 Next Steps:'));
    console.log();
    console.log(chalk.white('1. Download your favorite sound effects (WAV or MP3 format)'));
    console.log(chalk.white('2. Add them to these directories:'));
    console.log(chalk.dim(`   ${join(soundsDir, 'SessionStart')}/`), chalk.white('(plays when starting)'));
    console.log(chalk.dim(`   ${join(soundsDir, 'UserPromptSubmit')}/`), chalk.white('(plays when you send a message)'));
    console.log(chalk.dim(`   ${join(soundsDir, 'PermissionRequest')}/`), chalk.white('(plays when you claude asks for clarification or permission)'));
    console.log(chalk.dim(`   ${join(soundsDir, 'Stop')}/`), chalk.white('(plays when Claude completes)'));
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
    console.log(chalk.dim(`⚙️  Hooks configuration saved in: ${getCodemiePath('claude-plugin/hooks/hooks.json')}`));
    console.log(chalk.dim(`📜 Script location: ${join(soundsDir, 'play-random-sound.sh')}`));
    console.log(chalk.dim('   Script would appear after codemie-claude first run'));
    console.log(chalk.white('💡 If script did not appear, remove ~/.codemie/claude-plugin directory and restart codemie-claude'));
    console.log();
}

/**
 * Install fun sounds system
 * Creates directories, installs script, and saves hooks configuration to ~/.claude/settings.json
 *
 * @returns Hooks configuration object if successful, null if installation failed
 */
export async function installSounds(): Promise<string | null> {
    try {
        // 1. Pre-flight: Check audio player
        const spinner = ora('Checking audio player...').start();
        const audioPlayer = await checkAudioPlayer();

        if (!audioPlayer) {
            spinner.fail(chalk.red('No audio player found'));

            logger.warn('Sounds installation skipped - no audio player available', {
                operation: 'installSounds',
                feature: 'sounds',
                checkedPlayers: ['afplay', 'aplay', 'paplay', 'mpg123']
            });

            console.log();
            console.log(chalk.yellow('⚠️  Sounds require an audio player to work.'));
            console.log(chalk.white('Checked for: afplay, aplay, paplay, mpg123'));
            console.log();
            console.log(chalk.white('Install instructions:'));
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
        const dirSpinner = ora('Creating sound directories...').start();
        await createSoundDirectories();
        dirSpinner.succeed(chalk.green('Sound directories created'));

        // 3. Display post-install instructions
        displayPostInstallInstructions();

        return "success";

    } catch (error) {
        const errorContext = createErrorContext(error);
        logger.error('Sounds installation failed', {
            ...errorContext,
            operation: 'installSounds'
        });
        console.log();
        console.log(chalk.red('❌ Sounds installation failed'));
        console.log(chalk.yellow('You can try again later by running: codemie install claude --sounds'));
        console.log();
        return null;
    }
}

/**
 * Check if sounds are already installed
 * @returns true if exist sounds directory
 */
export function isSoundsInstalled(): boolean {
    const soundsDir = getCodemiePath('sounds');

    return existsSync(soundsDir);
}
