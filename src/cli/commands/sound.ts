import { Command } from 'commander';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getCodemiePath } from '../../utils/paths.js';
import { commandExists } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';

export function createSoundCommand(): Command {
  return new Command('sound')
    .description('Play a random sound for the given hook event')
    .argument('<event>', 'Hook event name (e.g. SessionStart, Stop, PermissionRequest)')
    .action(async (event: string) => {
      try {
        const soundDir = getCodemiePath('sounds', event);

        if (!existsSync(soundDir)) {
          logger.debug(`[sound] Directory not found: ${soundDir}`);
          process.exitCode = 0;
          return;
        }

        const audioFiles = readdirSync(soundDir)
          .filter(f => /\.(wav|mp3)$/i.test(f))
          .map(f => join(soundDir, f));

        if (audioFiles.length === 0) {
          logger.debug(`[sound] No audio files found in: ${soundDir}`);
          process.exitCode = 0;
          return;
        }

        const selectedFile = audioFiles[Math.floor(Math.random() * audioFiles.length)];
        logger.debug(`[sound] Playing: ${selectedFile}`);

        await playSoundBackground(selectedFile);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[sound] Failed to play sound: ${message}`);
      } finally {
        process.exitCode = 0;
      }
    });
}

async function playSoundBackground(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    playOnWindows(filePath);
    return;
  }

  // macOS and Linux: try audio players in priority order
  const players: Array<{ cmd: string; getArgs: (f: string) => string[] }> = [
    { cmd: 'afplay', getArgs: (f) => [f] },
    { cmd: 'aplay',  getArgs: (f) => ['-q', f] },
    { cmd: 'paplay', getArgs: (f) => [f] },
    { cmd: 'mpg123', getArgs: (f) => ['-q', f] },
  ];

  for (const { cmd, getArgs } of players) {
    if (await commandExists(cmd)) {
      spawnDetached(cmd, getArgs(filePath));
      return;
    }
  }

  logger.debug('[sound] No supported audio player found (afplay, aplay, paplay, mpg123)');
}

function playOnWindows(filePath: string): void {
  // Escape single quotes for PowerShell string literal
  const escapedPath = filePath.replace(/'/g, "''");
  const psCommand = [
    `$ErrorActionPreference='SilentlyContinue';`,
    `$f='${escapedPath}';`,
    `if (Get-Command mpg123 -ErrorAction SilentlyContinue) {`,
    `  Start-Process mpg123 -ArgumentList @('-q',$f) -NoNewWindow`,
    `} elseif (Test-Path $f) {`,
    `  try {`,
    `    $wmp = New-Object -ComObject WMPlayer.OCX;`,
    `    $wmp.URL = $f;`,
    `    $wmp.controls.play();`,
    `    Start-Sleep -Milliseconds 500`,
    `  } catch {}`,
    `}`,
  ].join(' ');

  spawnDetached('powershell', ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-Command', psCommand]);
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}