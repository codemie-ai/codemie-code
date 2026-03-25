#!/usr/bin/env node
/**
 * Cross-platform secrets detection using Gitleaks.
 * Supports Docker and Podman (including Colima, OrbStack, Podman Machine).
 * Works on Windows, macOS, and Linux.
 *
 * Usage:
 *   node scripts/validate-secrets.js    # scan working directory
 */

import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { resolve } from 'path'

const GITLEAKS_IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1'
const isWindows = platform() === 'win32'
const projectPath = resolve(process.cwd())
const configPath = resolve(projectPath, '.gitleaks.toml')
const hasConfig = existsSync(configPath)

function commandExists(cmd) {
  try {
    execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function daemonRunning(engine) {
  try {
    execSync(`${engine} info`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function detectEngine() {
  for (const engine of ['docker', 'podman']) {
    if (commandExists(engine)) return engine
  }
  return null
}

function hintForStoppedDaemon(engine) {
  if (engine === 'docker') {
    if (commandExists('colima')) return "Run 'colima start' to enable secrets detection locally"
    if (commandExists('orbstack')) return 'Start OrbStack to enable secrets detection locally'
  }
  if (engine === 'podman') {
    return "Run 'podman machine start' to enable secrets detection locally"
  }
  return 'Start your container engine to enable secrets detection locally'
}

const engine = detectEngine()

if (!engine) {
  console.log('No container engine found (docker/podman) - skipping secrets detection')
  console.log('Install Docker or Podman to enable local secrets scanning')
  process.exit(1)
}

if (!daemonRunning(engine)) {
  const engineLabel = engine.charAt(0).toUpperCase() + engine.slice(1)
  console.error(`${engineLabel} daemon is not running`)
  console.error(hintForStoppedDaemon(engine))
  process.exit(1)
}

const args = [
  'run',
  '--rm',
  '-v',
  `${projectPath}:/workspace`,
  GITLEAKS_IMAGE,
  'dir',
  '--no-banner',
  '--verbose',
]

if (hasConfig) {
  args.push('--config=/workspace/.gitleaks.toml')
}

args.push('/workspace')

console.log('Checking for secrets with Gitleaks...')

const gitleaks = spawn(engine, args, {
  stdio: 'inherit',
  shell: isWindows,
})

gitleaks.on('close', (code) => {
  if (code !== 0) {
    console.error('Secrets detected! Please remove sensitive data before committing.')
  }
  process.exit(code)
})

gitleaks.on('error', (err) => {
  console.error(`Failed to run Gitleaks via ${engine}:`, err.message)
  process.exit(1)
})
