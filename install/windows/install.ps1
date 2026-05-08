[CmdletBinding()]
param(
  [ValidateSet('portable', 'npm-global')]
  [string]$Mode = 'portable',
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

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'CodeMie'
}

$BinDir = Join-Path $InstallRoot 'bin'
$PrefixDir = Join-Path $InstallRoot 'npm-prefix'
$NpmPath = Get-CommandPath 'npm.cmd'
$NodePath = Get-CommandPath 'node.exe'
$GitPath = Get-CommandPath 'git.exe'
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

if ($Mode -eq 'portable') {
  if ($DryRun) {
    Write-Host "DRY RUN: would create $BinDir and $PrefixDir"
  } else {
    New-Item -ItemType Directory -Force -Path $BinDir, $PrefixDir | Out-Null
  }
  Invoke-Checked $NpmPath @('config', 'set', 'prefix', $PrefixDir, '--location', 'user') 'Failed to configure npm prefix.'
}

if (-not [string]::IsNullOrWhiteSpace($ScopeRegistryUrl)) {
  Invoke-Checked $NpmPath @('config', 'set', '@codemieai:registry', $ScopeRegistryUrl, '--location', 'user') 'Failed to configure @codemieai registry.'
}

$PackageSpec = $PackageName
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $PackageSpec = "$PackageName@$Version"
}

$ResolvedPackageVersion = Get-PackageVersion $NpmPath $PackageSpec $RegistryUrl
Write-Status 'Package' "$PackageSpec found ($ResolvedPackageVersion)"
Invoke-Checked $NpmPath @('install', '-g', $PackageSpec, '--registry', $RegistryUrl) "Failed to install $PackageSpec."

if ($Mode -eq 'portable') {
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

  Add-UserPath $BinDir
}

Write-Status 'CodeMie' "installed $ResolvedPackageVersion"
Write-Host 'Run `codemie doctor` in a new terminal to verify the installation.'
