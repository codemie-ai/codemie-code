[CmdletBinding()]
param(
  [ValidateSet('auto', 'npm-global', 'portable')]
  [string]$Mode = 'auto',
  [string]$Version = '',
  [string]$RegistryUrl = 'https://registry.npmjs.org/',
  [string]$ScopeRegistryUrl = '',
  [string]$InstallRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PackageName = '@codemieai/code'
$MinimumNodeMajor = 20
$Commands = @(
  'codemie',
  'codemie-code',
  'codemie-claude',
  'codemie-claude-acp',
  'codemie-gemini',
  'codemie-opencode',
  'codemie-mcp-proxy'
)

function Write-Status {
  param([string]$Name, [string]$Value)
  Write-Host ('{0,-18} {1}' -f "${Name}:", $Value)
}

function Get-CommandPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return ''
  }
  return $command.Source
}

function Get-NodeMajor {
  param([string]$NodePath)
  if ([string]::IsNullOrWhiteSpace($NodePath)) {
    return 0
  }

  $version = & $NodePath --version
  if ($version -match '^v(\d+)\.') {
    return [int]$Matches[1]
  }

  return 0
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  if ($DryRun) {
    Write-Host "DRY RUN: $FilePath $($Arguments -join ' ')"
    return
  }

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function Get-PackageVersion {
  param(
    [string]$NpmPath,
    [string]$PackageSpec,
    [string]$RegistryUrl
  )

  if ($DryRun) {
    Write-Host "DRY RUN: $NpmPath view $PackageSpec version --registry $RegistryUrl"
    return 'dry-run'
  }

  $output = & $NpmPath @('view', $PackageSpec, 'version', '--registry', $RegistryUrl) 2>&1
  if ($LASTEXITCODE -ne 0) {
    $message = @(
      "Package $PackageSpec was not found in registry $RegistryUrl.",
      'Ask IT to expose @codemieai/code through the approved virtual npm repository, or rerun with -ScopeRegistryUrl pointing to the approved registry.',
      "npm output: $($output -join ' ')"
    ) -join ' '
    throw $message
  }

  return ($output | Select-Object -First 1).ToString().Trim()
}

function Add-UserPath {
  param([string]$PathToAdd)

  $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($currentUserPath)) {
    $currentUserPath = ''
  }

  $pathEntries = $currentUserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($pathEntries -icontains $PathToAdd) {
    Write-Status 'PATH update' 'already present'
    return
  }

  if ($DryRun) {
    Write-Status 'PATH update' "DRY RUN: would add $PathToAdd to user PATH"
    return
  }

  $newPath = if ($currentUserPath) { "$currentUserPath;$PathToAdd" } else { $PathToAdd }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Status 'PATH update' 'user PATH updated; open a new terminal'
}

function Remove-UserPath {
  param([string]$PathToRemove)

  $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($currentUserPath)) {
    Write-Status 'PATH update' 'already absent'
    return
  }

  $pathEntries = $currentUserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($pathEntries -inotcontains $PathToRemove) {
    Write-Status 'PATH update' 'already absent'
    return
  }

  if ($DryRun) {
    Write-Status 'PATH update' "DRY RUN: would remove $PathToRemove from user PATH"
    return
  }

  $remainingEntries = $pathEntries | Where-Object { $_ -ine $PathToRemove }
  $newPath = $remainingEntries -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Status 'PATH update' 'removed from user PATH; open a new terminal'
}

function Test-DirWritable {
  param([string]$Path)

  $probePath = $Path
  while (-not (Test-Path -LiteralPath $probePath)) {
    $parent = Split-Path -Path $probePath -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probePath) {
      return $false
    }
    $probePath = $parent
  }

  $testFile = Join-Path $probePath ([System.IO.Path]::GetRandomFileName())
  try {
    [System.IO.File]::WriteAllText($testFile, '')
    Remove-Item -LiteralPath $testFile -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Get-NpmPrefix {
  param([switch]$IgnoreUserConfig)

  $savedUserConfig = $env:npm_config_userconfig
  if ($IgnoreUserConfig) {
    $env:npm_config_userconfig = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
  }
  try {
    $prefix = & $NpmPath @('config', 'get', 'prefix') | Select-Object -First 1
  } finally {
    $env:npm_config_userconfig = $savedUserConfig
  }

  if ($null -eq $prefix) {
    return ''
  }
  return $prefix.ToString().Trim()
}

function Get-UserNpmrcPrefix {
  $userConfig = "$(& $NpmPath @('config', 'get', 'userconfig') | Select-Object -First 1)".Trim()
  if (-not $userConfig -or -not (Test-Path -LiteralPath $userConfig)) {
    return ''
  }

  $prefix = ''
  foreach ($line in Get-Content -LiteralPath $userConfig) {
    if ($line -match '^\s*prefix\s*=\s*(.*?)\s*$') {
      $prefix = $Matches[1].Trim('"')
    }
  }
  return $prefix
}

function Test-SamePath {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  return $Left.TrimEnd('\') -ieq $Right.TrimEnd('\')
}

function Resolve-InstallMode {
  param([string]$NpmPrefix)
  if (-not [string]::IsNullOrWhiteSpace($NpmPrefix) -and (Test-DirWritable $NpmPrefix)) {
    return 'npm-global'
  }
  return 'portable'
}

function Write-CommandShims {
  foreach ($CommandName in $Commands) {
    $shimPath = Join-Path $BinDir "$CommandName.cmd"
    $targetPath = Join-Path $PrefixDir "$CommandName.cmd"
    $fallbackTargetPath = Join-Path $PrefixDir "node_modules\.bin\$CommandName.cmd"
    $shim = @(
      '@echo off',
      "if exist `"$targetPath`" (",
      "  call `"$targetPath`" %*",
      '  exit /b %ERRORLEVEL%',
      ')',
      "if exist `"$fallbackTargetPath`" (",
      "  call `"$fallbackTargetPath`" %*",
      '  exit /b %ERRORLEVEL%',
      ')',
      "echo CodeMie command shim could not find $CommandName.cmd in $PrefixDir",
      'exit /b 1'
    ) -join "`r`n"

    if ($DryRun) {
      Write-Host "DRY RUN: would write $shimPath"
    } else {
      $shim | Set-Content -Path $shimPath -Encoding ASCII
    }
  }
}

function Remove-CommandShims {
  foreach ($CommandName in $Commands) {
    $shimPath = Join-Path $BinDir "$CommandName.cmd"
    if ($DryRun) {
      Write-Host "DRY RUN: would remove $shimPath"
    } elseif (Test-Path -LiteralPath $shimPath) {
      Remove-Item -LiteralPath $shimPath -Force
    }
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'CodeMie'
}

$BinDir = Join-Path $InstallRoot 'bin'
$PrefixDir = Join-Path $InstallRoot 'npm-prefix'
$NpmPath = Get-CommandPath 'npm.cmd'
$NodePath = Get-CommandPath 'node.exe'
$GitPath = Get-CommandPath 'git.exe'

# Fallback: probe common Node.js install locations when PATH lookup fails.
# GUI apps (e.g. Connect wizard) may not inherit the user's shell PATH.
if (-not $NodePath) {
  $probes = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($probe in $probes) {
    if (Test-Path $probe) {
      $NodePath = $probe
      if (-not $NpmPath) {
        $NpmPath = Join-Path (Split-Path $probe) 'npm.cmd'
      }
      break
    }
  }
}

$NodeMajor = Get-NodeMajor $NodePath

Write-Host 'CodeMie installer diagnostics'
Write-Status 'OS' ([System.Environment]::OSVersion.VersionString)
Write-Status 'Shell' 'PowerShell'
Write-Status 'Install mode' $Mode
Write-Status 'Install root' $InstallRoot
Write-Status 'Node' $(if ($NodePath) { "$NodePath (major $NodeMajor)" } else { 'not found' })
Write-Status 'npm' $(if ($NpmPath) { $NpmPath } else { 'not found' })
Write-Status 'Git' $(if ($GitPath) { $GitPath } else { 'not found' })
Write-Status 'Registry' $RegistryUrl

if (-not $NodePath -or $NodeMajor -lt $MinimumNodeMajor) {
  throw "Node.js $MinimumNodeMajor or newer is required. Install the corporate-approved Node.js package, then rerun this installer."
}

if (-not $NpmPath) {
  throw 'npm.cmd was not found. Reinstall Node.js with npm enabled, then rerun this installer.'
}

$LegacyOverrideDetected = Test-SamePath (Get-UserNpmrcPrefix) $PrefixDir

if ($LegacyOverrideDetected) {
  Write-Host "Legacy npm prefix override detected at $PrefixDir"
  if (Test-Path -LiteralPath $PrefixDir) {
    Write-Host 'Packages stranded in the legacy prefix:'
    & $NpmPath @('ls', '-g', '--prefix', $PrefixDir, '--depth=0')
  }
  Invoke-Checked $NpmPath @('config', 'delete', 'prefix', '--location', 'user') 'Failed to delete the legacy npm prefix override.'
  if (-not $DryRun) {
    Write-Status 'npm config' 'removed the user prefix override'
  }
  Write-Host "Revert: npm config set prefix `"$PrefixDir`" --location user"
}

if ($Mode -eq 'auto') {
  # A dry run keeps the override, so preview the prefix a real run would see after deleting it.
  $ResolvedMode = Resolve-InstallMode (Get-NpmPrefix -IgnoreUserConfig:($DryRun -and $LegacyOverrideDetected))
} else {
  $ResolvedMode = $Mode
}
Write-Status 'Mode' $ResolvedMode

if ($ResolvedMode -eq 'portable') {
  if ($DryRun) {
    Write-Host "DRY RUN: would create $BinDir and $PrefixDir"
  } else {
    New-Item -ItemType Directory -Force -Path $BinDir, $PrefixDir | Out-Null
  }
}

if (-not [string]::IsNullOrWhiteSpace($ScopeRegistryUrl)) {
  Invoke-Checked $NpmPath @('config', 'set', '@codemieai:registry', $ScopeRegistryUrl, '--location', 'user') 'Failed to configure @codemieai registry.'
  Write-Host 'Revert: npm config delete @codemieai:registry --location user'
}

$PackageSpec = $PackageName
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $PackageSpec = "$PackageName@$Version"
}

$ResolvedPackageVersion = Get-PackageVersion $NpmPath $PackageSpec $RegistryUrl
Write-Status 'Package' "$PackageSpec found ($ResolvedPackageVersion)"

$InstallArgs = @('install', '-g', $PackageSpec, '--registry', $RegistryUrl)
if ($ResolvedMode -eq 'portable') {
  $InstallArgs += @('--prefix', $PrefixDir)
}
Invoke-Checked $NpmPath $InstallArgs "Failed to install $PackageSpec."

if ($ResolvedMode -eq 'portable') {
  Write-CommandShims
  Add-UserPath $BinDir
  # Agents that CodeMie installs land in the prefix itself.
  Add-UserPath $PrefixDir
} elseif ($LegacyOverrideDetected) {
  Remove-CommandShims
  Remove-UserPath $BinDir
  Write-Host 'Reinstall stranded packages, for example: npm i -g @anthropic-ai/claude-code@latest'
  Write-Host "Optional cleanup: Remove-Item -Recurse `"$PrefixDir`""
}

Write-Status 'CodeMie' "installed $ResolvedPackageVersion"
Write-Host 'Run `codemie doctor` in a new terminal to verify the installation.'
