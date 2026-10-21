<#
.SYNOPSIS
  CodeMie CLI Windows diagnostics: System Requirements, current user rights,
  current codemie-cli installation state, and Group Policy settings that
  affect the PATH environment variable (applied values, local cache, SYSVOL).

.DESCRIPTION
  Diagnostic script. It does not install, configure, or remove anything and
  does not change registry, PATH, npm, or CodeMie configuration.
  Side effects are limited to:
    - the report file (see -ReportPath);
    - writability probes that create and immediately delete a zero-byte
      temporary file in each probed directory (disable with -NoWriteProbe);
    - temporary gpresult XML files under %TEMP% (deleted after parsing);
    - running read-only commands: node/npm --version, npm config, npm view,
      codemie --version, codemie doctor (disable with -SkipDoctor), gpresult.

  Secrets (API keys, tokens, passwords, cookies, npm auth, proxy credentials)
  and e-mail addresses are masked in the report.

  Supported: Windows 10 / Windows Server 2016 or newer, Windows PowerShell 5.1
  or PowerShell 7+.

.PARAMETER ReportPath
  Where to save the full console transcript. Defaults to a timestamped file
  under %TEMP%. Pass '' (empty string) to skip saving a report file.

.PARAMETER SkipNetworkCheck
  Skip outbound connectivity checks and the npm package visibility check.

.PARAMETER SkipDoctor
  Do not run `codemie doctor` (the `codemie --version` check still runs).

.PARAMETER DoctorTimeoutSec
  Timeout for `codemie doctor`. Default 180.

.PARAMETER NoWriteProbe
  Do not create temporary files to test directory writability.

.PARAMETER RunGpoCheck
  Run the Group Policy section (skipped by default).

.PARAMETER ScanAllSysvolGpos
  Additionally scan every GPO in the domain SYSVOL (not only the applied ones)
  for PATH-related preference settings. Can be slow in large domains.

.PARAMETER SkipDeepSearch
  Skip the filesystem fallback search that runs when PATH lookup cannot
  locate codemie-cli.

.PARAMETER SearchRoots
  Roots for the fallback filesystem search. Nested roots are de-duplicated.

.PARAMETER MaxSearchDepth
  Maximum recursion depth for the fallback filesystem search. Default 6.

.PARAMETER SearchTimeoutSec
  Hard time budget for the fallback filesystem search. Default 60.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\clidiag.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\clidiag.ps1 -SkipDoctor -ScanAllSysvolGpos

.EXAMPLE
  # Run straight from GitHub (available once the script is on the main branch)
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/clidiag.ps1))) -SkipDoctor
#>

[CmdletBinding()]
param(
  [string]$ReportPath = (Join-Path ([System.IO.Path]::GetTempPath()) ("codemie-diagnostics-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [switch]$SkipNetworkCheck,
  [switch]$SkipDoctor,
  [int]$DoctorTimeoutSec = 180,
  [switch]$NoWriteProbe,
  [switch]$RunGpoCheck,
  [switch]$ScanAllSysvolGpos,
  [switch]$SkipDeepSearch,
  [string[]]$SearchRoots = @(
    $env:LOCALAPPDATA,
    $env:APPDATA,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    $env:USERPROFILE
  ),
  [int]$MaxSearchDepth = 6,
  [int]$SearchTimeoutSec = 60
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$ScriptVersion = '2026.10.16.4'
$PackageName = '@codemieai/code'
$MinimumNodeMajor = 20
$MinimumWindowsMajor = 10
$MinimumPsVersion = [version]'5.1'
$GitHubTargets = @('https://github.com/', 'https://objects.githubusercontent.com/')
$KnownCommands = @(
  'codemie',
  'codemie-code',
  'codemie-claude',
  'codemie-claude-acp',
  'codemie-codex',
  'codemie-codex-acp',
  'codemie-gemini',
  'codemie-gemini-acp',
  'codemie-opencode',
  'codemie-opencode-acp',
  'codemie-pi',
  'codemie-kimi',
  'codemie-kimi-acp',
  'codemie-openwiki',
  'codemie-mcp-proxy'
)
$SearchExcludedDirNames = @('WindowsApps', 'Packages', '$Recycle.Bin', 'WinSxS', 'System32', 'SysWOW64', '.git', 'Installer', 'Package Cache')
$MachineEnvKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$AdminsSid = 'S-1-5-32-544'
$IntegrityLevels = @{
  'S-1-16-4096'  = 'Low'
  'S-1-16-8192'  = 'Medium'
  'S-1-16-8448'  = 'Medium Plus'
  'S-1-16-12288' = 'High (elevated)'
  'S-1-16-16384' = 'System'
}
$SensitiveNamePattern = '(?i)(key|token|secret|password|passwd|pwd|auth|cookie|credential)'

$Script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
$Script:Results = New-Object System.Collections.Generic.List[object]
$Script:Ctx = @{
  NodePath      = ''
  NpmPath       = ''
  NpmConfig     = $null
  NpmConfigRead = $false
  IsAdmin       = $false
  UserSid       = ''
  PartOfDomain  = $false
  Domain        = ''
  PackagesFound = 0
  LiteralVarEntries = New-Object System.Collections.Generic.List[object]
  EntraJoined   = $false
  MdmEnrolled   = $false
}

# ============================================================================
# Output and redaction helpers
# ============================================================================

function Write-SectionHeader {
  param([string]$Title)
  Write-Host ''
  Write-Host ('=' * 78) -ForegroundColor Cyan
  Write-Host "  $Title" -ForegroundColor Cyan
  Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-SubHeader {
  param([string]$Title)
  Write-Host ''
  Write-Host "-- $Title --" -ForegroundColor DarkCyan
}

function Add-Check {
  param(
    [string]$Category,
    [string]$Name,
    [ValidateSet('OK', 'WARN', 'FAIL', 'INFO')]
    [string]$Status,
    [string]$Detail = ''
  )

  $color = switch ($Status) {
    'OK' { 'Green' }
    'WARN' { 'Yellow' }
    'FAIL' { 'Red' }
    default { 'Gray' }
  }

  Write-Host ('  [{0,-4}] {1,-38} {2}' -f $Status, $Name, $Detail) -ForegroundColor $color

  $Script:Results.Add([PSCustomObject]@{
    Category = $Category
    Check    = $Name
    Status   = $Status
    Detail   = $Detail
  })
}

function Write-Indented {
  param([string]$Text, [int]$Indent = 4)
  if ($null -eq $Text) { return }
  $pad = ' ' * $Indent
  foreach ($line in ($Text -split "`r?`n")) {
    Write-Host "$pad$line"
  }
}

function Protect-Url {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  return ($Text -replace '(?<=://)[^/@\s"'']+@', '***@')
}

function Protect-SensitiveText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }

  $out = [regex]::Replace($Text, '(?i)"(?<k>[A-Za-z0-9_]*(?:key|token|secret|password|cookiesEncrypted|credential)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"', '"${k}": "***REDACTED***"')
  $out = [regex]::Replace($out, '(?im)^(?<k>\s*[^=;#\r\n]*(?:_auth|_authToken|_password|password|token|secret|apikey|api-key|certfile|keyfile)[^=\r\n]*=).*$', '${k}***REDACTED***')
  $out = [regex]::Replace($out, '(?i)(?<k>bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '${k}***REDACTED***')
  $out = [regex]::Replace($out, '(?i)(?<k>[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|cookie|credential|authorization)[A-Za-z0-9_.-]*[''"]?\s*[:=]\s*)(?<q>[''"]?)(?!(?:\d+|true|false|null)\b|\*\*\*)[^''"\s,;}&]+', '${k}${q}***REDACTED***')
  $out = [regex]::Replace($out, '(?<a>[A-Za-z0-9])[A-Za-z0-9._%+-]*@(?<d>[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})', '${a}***@${d}')
  return (Protect-Url $out)
}

function Protect-EnvValue {
  param([string]$Name, [string]$Value)
  if ($Name -match $SensitiveNamePattern) { return '***REDACTED***' }
  return (Protect-SensitiveText $Value)
}

# ============================================================================
# Generic probes
# ============================================================================

function Join-PathSafe {
  param([string]$Parent, [string]$Child)
  if ([string]::IsNullOrWhiteSpace($Parent)) { return '' }
  return (Join-Path $Parent $Child)
}

function Get-CommandSource {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $cmd) { return '' }
  if ($cmd.Source) { return $cmd.Source }
  return $cmd.Path
}

function ConvertTo-NormalizedPath {
  param([string]$Path, [switch]$NoExpand)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $value = $Path.Trim().Trim('"')
  if (-not $NoExpand) { $value = [Environment]::ExpandEnvironmentVariables($value) }
  return $value.TrimEnd('\', '/').ToLowerInvariant()
}

function Test-DirWritable {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }

  $probePath = $Path
  while (-not (Test-Path -LiteralPath $probePath -ErrorAction SilentlyContinue)) {
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

function Add-WritableCheck {
  param([string]$Category, [string]$Name, [string]$Path, [string]$NotWritableStatus = 'INFO', [string]$NotWritableHint = '')
  if ($NoWriteProbe) {
    Add-Check $Category $Name 'INFO' "$Path -> probe skipped (-NoWriteProbe)"
    return
  }
  if (Test-DirWritable $Path) {
    Add-Check $Category $Name 'OK' "$Path -> writable"
  } else {
    $detail = "$Path -> not writable"
    if ($NotWritableHint) { $detail = "$detail; $NotWritableHint" }
    Add-Check $Category $Name $NotWritableStatus $detail
  }
}

function ConvertTo-QuotedArg {
  param([string]$Value, [switch]$Force)
  if ($null -eq $Value -or $Value -eq '') { return '""' }
  if ($Force -or $Value -match '[\s"&|<>^]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [int]$TimeoutSec = 60,
    [switch]$Oem
  )

  $result = [PSCustomObject]@{
    ExitCode = -1
    StdOut   = ''
    StdErr   = ''
    TimedOut = $false
    Error    = ''
  }

  if ([string]::IsNullOrWhiteSpace($FilePath)) {
    $result.Error = 'executable not found'
    return $result
  }

  $argString = (@($Arguments) | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' '
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  if ($Script:OnWindows -and ($extension -eq '.cmd' -or $extension -eq '.bat')) {
    $comSpec = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot 'System32\cmd.exe' }
    $psi.FileName = $comSpec
    $psi.Arguments = '/d /s /c "' + (ConvertTo-QuotedArg $FilePath -Force) + ' ' + $argString + '"'
  } else {
    $psi.FileName = $FilePath
    $psi.Arguments = $argString
  }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $encoding = [System.Text.Encoding]::UTF8
  if ($Oem -and $Script:OnWindows) {
    try { $encoding = [Console]::OutputEncoding } catch {
      try { $encoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch { }
    }
  }
  $psi.StandardOutputEncoding = $encoding
  $psi.StandardErrorEncoding = $encoding
  $psi.EnvironmentVariables['NO_COLOR'] = '1'
  $psi.EnvironmentVariables['FORCE_COLOR'] = '0'
  $psi.EnvironmentVariables['NO_UPDATE_NOTIFIER'] = '1'

  try {
    $process = [System.Diagnostics.Process]::Start($psi)
  } catch {
    $result.Error = $_.Exception.Message
    return $result
  }

  try { $process.StandardInput.Close() } catch { }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()

  if (-not $process.WaitForExit($TimeoutSec * 1000)) {
    $result.TimedOut = $true
    if ($Script:OnWindows) {
      & taskkill.exe /T /F /PID $process.Id 2>&1 | Out-Null
    } else {
      try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
    }
    $process.WaitForExit(5000) | Out-Null
  } else {
    $process.WaitForExit()
  }

  try { $result.ExitCode = $process.ExitCode } catch { }
  if ($stdoutTask.Wait(5000)) { $result.StdOut = $stdoutTask.Result }
  if ($stderrTask.Wait(5000)) { $result.StdErr = $stderrTask.Result }
  return $result
}

function Get-FirstLine {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  return (($Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
}

function Open-RegistryKey {
  param([ValidateSet('HKLM', 'HKCU')][string]$Hive, [string]$SubKey)
  if (-not $Script:OnWindows) { return $null }
  try {
    $hiveId = if ($Hive -eq 'HKLM') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
    $view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Default }
    return [Microsoft.Win32.RegistryKey]::OpenBaseKey($hiveId, $view).OpenSubKey($SubKey, $false)
  } catch {
    return $null
  }
}

function Get-RegistrySubKeyNames {
  param($Key)
  if ($null -eq $Key) { return @() }
  try { return @($Key.GetSubKeyNames()) } catch { return @() }
}

function Get-RegistryValueSafe {
  param($Key, [string]$Name)
  if ($null -eq $Key) { return $null }
  try { return $Key.GetValue($Name) } catch { return $null }
}

function Invoke-Section {
  param([string]$Name, [scriptblock]$Body)
  try {
    & $Body
  } catch {
    $line = if ($_.InvocationInfo) { $_.InvocationInfo.ScriptLineNumber } else { '?' }
    Add-Check 'Script' "Section crashed: $Name" 'FAIL' "$($_.Exception.Message) (line $line); the rest of this section was skipped, other sections still ran"
  }
}

# ============================================================================
# Node / npm resolution
# ============================================================================

function Resolve-NodeAndNpm {
  $nodePath = Get-CommandSource 'node.exe'
  if (-not $nodePath) { $nodePath = Get-CommandSource 'node' }
  if (-not $nodePath) {
    foreach ($probe in @(
        (Join-PathSafe $env:ProgramFiles 'nodejs\node.exe'),
        (Join-PathSafe ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-PathSafe $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
      )) {
      if ($probe -and (Test-Path -LiteralPath $probe -ErrorAction SilentlyContinue)) {
        $nodePath = $probe
        break
      }
    }
  }

  $npmPath = Get-CommandSource 'npm.cmd'
  if (-not $npmPath -and $nodePath) {
    $probe = Join-Path (Split-Path $nodePath) 'npm.cmd'
    if (Test-Path -LiteralPath $probe -ErrorAction SilentlyContinue) { $npmPath = $probe }
  }
  if (-not $npmPath -and $Script:OnWindows) {
    $npmPs1 = Get-CommandSource 'npm.ps1'
    if ($npmPs1) {
      $probe = Join-Path (Split-Path $npmPs1) 'npm.cmd'
      if (Test-Path -LiteralPath $probe -ErrorAction SilentlyContinue) { $npmPath = $probe }
    }
  }
  if (-not $npmPath -and -not $Script:OnWindows) {
    $npmPath = Get-CommandSource 'npm'
  }

  $Script:Ctx.NodePath = $nodePath
  $Script:Ctx.NpmPath = $npmPath
}

function Get-NpmConfigValue {
  param([string]$Key)
  if (-not $Script:Ctx.NpmPath) { return '' }

  if (-not $Script:Ctx.NpmConfigRead) {
    $Script:Ctx.NpmConfigRead = $true
    $res = Invoke-External $Script:Ctx.NpmPath @('config', 'list', '--json') 60
    if ($res.ExitCode -eq 0 -and $res.StdOut) {
      try { $Script:Ctx.NpmConfig = $res.StdOut | ConvertFrom-Json } catch { $Script:Ctx.NpmConfig = $null }
    }
  }

  $value = $null
  if ($Script:Ctx.NpmConfig) {
    $prop = $Script:Ctx.NpmConfig.PSObject.Properties[$Key]
    if ($prop) { $value = $prop.Value }
  }
  if ($null -eq $value) {
    $res = Invoke-External $Script:Ctx.NpmPath @('config', 'get', $Key) 30
    if ($res.ExitCode -eq 0) { $value = Get-FirstLine $res.StdOut }
  }

  $text = "$value".Trim()
  if ($text -eq 'undefined' -or $text -eq 'null') { return '' }
  return $text
}

function Get-EffectiveCodemieRegistry {
  $scope = Get-NpmConfigValue '@codemieai:registry'
  if ($scope) { return $scope }
  $registry = Get-NpmConfigValue 'registry'
  if ($registry) { return $registry }
  return 'https://registry.npmjs.org/'
}

# ============================================================================
# Network probes
# ============================================================================

function Get-InnerWebException {
  param($Exception)
  $ex = $Exception
  while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
  return $ex
}

function Test-HttpsEndpoint {
  param([string]$Url, [string]$ProxyUrl = '')

  $outcome = [PSCustomObject]@{ Reachable = $false; Detail = '' }
  try {
    $request = [System.Net.WebRequest]::Create($Url)
    $request.Method = 'HEAD'
    $request.Timeout = 15000
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'codemie-diagnostics'
    if ($ProxyUrl) {
      $proxyUri = New-Object System.Uri($ProxyUrl)
      $proxy = New-Object System.Net.WebProxy(('{0}://{1}:{2}' -f $proxyUri.Scheme, $proxyUri.Host, $proxyUri.Port))
      $proxy.UseDefaultCredentials = $true
      $request.Proxy = $proxy
    } else {
      $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
      $systemProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
      $request.Proxy = $systemProxy
    }
    $response = $request.GetResponse()
    $outcome.Reachable = $true
    $outcome.Detail = "HTTP $([int]$response.StatusCode)"
    $response.Close()
  } catch {
    $webEx = Get-InnerWebException $_.Exception
    if ($webEx -and $webEx.Response) {
      $statusCode = [int]$webEx.Response.StatusCode
      if ($statusCode -eq 407) {
        $outcome.Detail = 'HTTP 407 proxy authentication required (credentials rejected or not supplied)'
      } else {
        $outcome.Reachable = $true
        $outcome.Detail = "HTTP $statusCode (server responded)"
      }
      try { $webEx.Response.Close() } catch { }
    } elseif ($webEx) {
      $outcome.Detail = "$($webEx.Status): $($webEx.Message)"
    } else {
      $outcome.Detail = $_.Exception.Message
    }
  }
  return $outcome
}

function Test-TcpEndpoint {
  param([string]$HostName, [int]$Port = 443, [int]$TimeoutMs = 3000)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connectTask = $client.ConnectAsync($HostName, $Port)
    $completed = $connectTask.Wait($TimeoutMs)
    $success = $completed -and $client.Connected
    $client.Close()
    return [bool]$success
  } catch {
    return $false
  }
}

# ============================================================================
# Section 1: System Requirements
# ============================================================================

function Invoke-SystemRequirementsCheck {
  Write-SectionHeader '1. System Requirements'

  Write-SubHeader 'Operating system and shell'
  if (-not $Script:OnWindows) {
    Add-Check 'Requirements' 'Platform' 'WARN' 'not running on Windows; Windows-specific checks will be skipped or incomplete'
  }

  $os = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { }
  if ($os) {
    $osVersion = [version]$os.Version
    $productType = switch ([int]$os.ProductType) { 1 { 'Workstation' } 2 { 'Domain Controller' } 3 { 'Server' } default { 'Unknown' } }
    $detail = "$($os.Caption) $($os.Version) build $($os.BuildNumber), $($os.OSArchitecture), $productType"
    if ($osVersion.Major -lt $MinimumWindowsMajor) {
      Add-Check 'Requirements' 'Operating System' 'FAIL' "$detail (requires Windows 10 / Server 2016 or newer)"
    } else {
      Add-Check 'Requirements' 'Operating System' 'OK' $detail
    }
  } else {
    Add-Check 'Requirements' 'Operating System' 'INFO' ([System.Environment]::OSVersion.VersionString)
  }

  $psVersion = $PSVersionTable.PSVersion
  $psDetail = "$psVersion ($($PSVersionTable.PSEdition))"
  if ([version]("{0}.{1}" -f $psVersion.Major, $psVersion.Minor) -lt $MinimumPsVersion) {
    Add-Check 'Requirements' 'PowerShell' 'FAIL' "$psDetail (requires $MinimumPsVersion or newer)"
  } else {
    Add-Check 'Requirements' 'PowerShell' 'OK' $psDetail
  }

  Write-SubHeader 'Node.js and npm'
  $nodePath = $Script:Ctx.NodePath
  if (-not $nodePath) {
    Add-Check 'Requirements' 'Node.js' 'FAIL' "not found on PATH or in common install locations (requires >=$MinimumNodeMajor.0.0)"
  } else {
    $res = Invoke-External $nodePath @('--version') 30
    $nodeVersion = Get-FirstLine $res.StdOut
    $nodeMajor = 0
    if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt $MinimumNodeMajor) {
      Add-Check 'Requirements' 'Node.js' 'FAIL' "'$nodeVersion' at $nodePath (requires >=$MinimumNodeMajor.0.0)"
    } else {
      Add-Check 'Requirements' 'Node.js' 'OK' "$nodeVersion at $nodePath"
    }
    $archRes = Invoke-External $nodePath @('-p', 'process.arch') 30
    Add-Check 'Requirements' 'Node.js architecture' 'INFO' (Get-FirstLine $archRes.StdOut)
  }

  $npmPath = $Script:Ctx.NpmPath
  if (-not $npmPath) {
    Add-Check 'Requirements' 'npm' 'FAIL' 'npm.cmd not found; reinstall Node.js with npm enabled'
    return
  }

  $npmRes = Invoke-External $npmPath @('--version') 60
  if ($npmRes.ExitCode -eq 0) {
    Add-Check 'Requirements' 'npm' 'OK' "$(Get-FirstLine $npmRes.StdOut) at $npmPath"
  } else {
    Add-Check 'Requirements' 'npm' 'FAIL' "found at $npmPath but 'npm --version' failed: $(Get-FirstLine ($npmRes.StdErr + $npmRes.Error))"
  }

  $npmPrefix = Get-NpmConfigValue 'prefix'
  if ($npmPrefix) {
    Add-WritableCheck 'Requirements' 'npm global prefix' $npmPrefix 'WARN' 'install.ps1 will fall back to a portable install'
  } else {
    Add-Check 'Requirements' 'npm global prefix' 'WARN' 'could not resolve npm prefix'
  }

  Write-SubHeader 'Registry and proxy configuration'
  $registry = Get-NpmConfigValue 'registry'
  $scopeRegistry = Get-NpmConfigValue '@codemieai:registry'
  Add-Check 'Requirements' 'npm registry' 'INFO' (Protect-Url $(if ($registry) { $registry } else { 'default (https://registry.npmjs.org/)' }))
  Add-Check 'Requirements' 'npm @codemieai:registry' 'INFO' (Protect-Url $(if ($scopeRegistry) { $scopeRegistry } else { 'not set (uses npm registry)' }))

  $npmProxy = Get-NpmConfigValue 'proxy'
  $npmHttpsProxy = Get-NpmConfigValue 'https-proxy'
  Add-Check 'Requirements' 'npm proxy / https-proxy' 'INFO' ("proxy={0}; https-proxy={1}" -f (Protect-Url $npmProxy), (Protect-Url $npmHttpsProxy))
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { Add-Check 'Requirements' "env:$name" 'INFO' (Protect-Url $value) }
  }
  if ($Script:OnWindows) {
    $winHttp = Invoke-External 'netsh.exe' @('winhttp', 'show', 'proxy') 30 -Oem
    $winHttpLines = ($winHttp.StdOut -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Skip 1
    Add-Check 'Requirements' 'WinHTTP proxy (netsh)' 'INFO' ((($winHttpLines | ForEach-Object { $_.Trim() }) -join ' | '))
  }

  if ($SkipNetworkCheck) {
    Add-Check 'Requirements' 'Network checks' 'INFO' 'skipped (-SkipNetworkCheck)'
    return
  }

  Write-SubHeader 'Network access (HTTPS via system proxy, plus npm proxy if set)'
  try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  } catch { }

  $targets = New-Object System.Collections.Generic.List[string]
  $effectiveRegistry = Get-EffectiveCodemieRegistry
  foreach ($url in @($effectiveRegistry, $registry, 'https://registry.npmjs.org/') + $GitHubTargets) {
    if ($url -and -not ($targets -contains $url)) { $targets.Add($url) }
  }

  $npmProxyForHttps = if ($npmHttpsProxy) { $npmHttpsProxy } else { $npmProxy }
  foreach ($url in $targets) {
    $uri = $null
    try { $uri = New-Object System.Uri($url) } catch { continue }
    $label = "HTTPS $($uri.Host)"

    $systemProxy = $null
    try { $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($uri) } catch { }
    $route = if ($systemProxy -and $systemProxy.AbsoluteUri -ne $uri.AbsoluteUri) { "via system proxy $(Protect-Url $systemProxy.AbsoluteUri)" } else { 'direct' }

    $probe = Test-HttpsEndpoint $url
    if ($probe.Reachable) {
      Add-Check 'Requirements' $label 'OK' "$($probe.Detail), $route"
    } elseif ($npmProxyForHttps) {
      $viaNpm = Test-HttpsEndpoint $url $npmProxyForHttps
      if ($viaNpm.Reachable) {
        Add-Check 'Requirements' $label 'OK' "$($viaNpm.Detail) via npm proxy (system route failed: $($probe.Detail))"
      } else {
        Add-Check 'Requirements' $label 'FAIL' "unreachable (${route}: $($probe.Detail); npm proxy: $($viaNpm.Detail))"
      }
    } else {
      Add-Check 'Requirements' $label 'FAIL' "unreachable ($route): $($probe.Detail)"
    }

    $tcpPort = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
    $direct = Test-TcpEndpoint -HostName $uri.Host -Port $tcpPort
    Add-Check 'Requirements' "  direct TCP $($uri.Host):$tcpPort" 'INFO' $(if ($direct) { 'open' } else { 'blocked/unreachable (normal behind a mandatory proxy)' })
  }

  Write-SubHeader "Package visibility ($PackageName)"
  $viewRes = Invoke-External $npmPath @('view', $PackageName, 'version') 90
  if ($viewRes.TimedOut) {
    Add-Check 'Requirements' "npm view $PackageName" 'FAIL' "timed out via $(Protect-Url $effectiveRegistry)"
  } elseif ($viewRes.ExitCode -eq 0 -and (Get-FirstLine $viewRes.StdOut)) {
    Add-Check 'Requirements' "npm view $PackageName" 'OK' "latest $(Get-FirstLine $viewRes.StdOut) via $(Protect-Url $effectiveRegistry)"
  } else {
    $err = Protect-SensitiveText (Get-FirstLine (($viewRes.StdErr -split "`r?`n" | Where-Object { $_ -match 'npm (ERR|error)' }) -join "`n"))
    Add-Check 'Requirements' "npm view $PackageName" 'FAIL' "not visible via $(Protect-Url $effectiveRegistry): $err"
  }
}

# ============================================================================
# Section 2: Current user rights
# ============================================================================

function Get-InteractiveUser {
  if (-not $Script:OnWindows) { return '' }
  try {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
    if ($explorer) {
      $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner -ErrorAction Stop
      if ($owner.User) { return "$($owner.Domain)\$($owner.User)" }
    }
  } catch { }
  return ''
}

function ConvertFrom-DsregOutput {
  param([string]$Text)
  $state = [PSCustomObject]@{ Available = $false; EntraJoined = $false; DomainJoined = $false; MdmEnrolled = $false; MdmUrl = ''; TenantName = '' }
  $fields = @{}
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$') { $fields[$Matches[1]] = $Matches[2] }
  }
  if ($fields.Count -eq 0) { return $state }
  $state.Available = $fields.ContainsKey('AzureAdJoined')
  $state.EntraJoined = $fields['AzureAdJoined'] -eq 'YES'
  $state.DomainJoined = $fields['DomainJoined'] -eq 'YES'
  $state.TenantName = [string]$fields['TenantName']
  $state.MdmUrl = [string]$fields['MdmUrl']
  $state.MdmEnrolled = -not [string]::IsNullOrWhiteSpace($state.MdmUrl)
  return $state
}

function Get-DeviceJoinState {
  if (-not $Script:OnWindows) { return (ConvertFrom-DsregOutput '') }
  $res = Invoke-External 'dsregcmd.exe' @('/status') 60 -Oem
  return (ConvertFrom-DsregOutput $res.StdOut)
}

function Invoke-UserRightsCheck {
  Write-SectionHeader '2. Current User Rights'

  $identity = $null
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $Script:Ctx.IsAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $Script:Ctx.UserSid = $identity.User.Value
    Add-Check 'User' 'Identity' 'INFO' "$($identity.Name) ($($identity.User.Value))"
    Add-Check 'User' 'Authentication type' 'INFO' $identity.AuthenticationType
  } catch {
    Add-Check 'User' 'Identity' 'WARN' "could not resolve Windows identity: $($_.Exception.Message)"
  }

  $whoamiGroups = @()
  if ($Script:OnWindows) {
    $res = Invoke-External 'whoami.exe' @('/groups', '/fo', 'csv', '/nh') 30 -Oem
    if ($res.ExitCode -eq 0) {
      try { $whoamiGroups = @($res.StdOut | ConvertFrom-Csv -Header 'Name', 'Type', 'Sid', 'Attributes') } catch { }
    }
  }

  $enabledSids = @()
  if ($identity) {
    $enabledSids = @($identity.Groups | ForEach-Object { $_.Value })
  }
  $allSids = @($whoamiGroups | ForEach-Object { $_.Sid }) + $enabledSids

  $isMember = $allSids -contains $AdminsSid
  $isEnabled = $enabledSids -contains $AdminsSid
  if ($Script:Ctx.IsAdmin) {
    Add-Check 'User' 'Administrators (S-1-5-32-544)' 'OK' 'member, token elevated'
  } elseif ($isMember -and -not $isEnabled) {
    Add-Check 'User' 'Administrators (S-1-5-32-544)' 'INFO' 'member, but UAC-filtered (deny-only) token; run elevated to use admin rights'
  } elseif ($isMember) {
    Add-Check 'User' 'Administrators (S-1-5-32-544)' 'INFO' 'member'
  } else {
    Add-Check 'User' 'Administrators (S-1-5-32-544)' 'INFO' 'not a member (standard user); user-local install is required'
  }
  Add-Check 'User' 'Running elevated' 'INFO' $(if ($Script:Ctx.IsAdmin) { 'yes' } else { 'no' })

  $integrity = $whoamiGroups | Where-Object { $IntegrityLevels.ContainsKey($_.Sid) } | Select-Object -First 1
  if ($integrity) {
    Add-Check 'User' 'Integrity level' 'INFO' $IntegrityLevels[$integrity.Sid]
  }

  if ($identity) {
    $interactive = Get-InteractiveUser
    if ($interactive -and $interactive -ine $identity.Name) {
      Add-Check 'User' 'Interactive user' 'WARN' "script runs as '$($identity.Name)' but the desktop user is '$interactive'; user PATH, HKCU, CodeMie config and user GPOs below belong to '$($identity.Name)'. Rerun as '$interactive' (non-elevated) to diagnose that user"
    } elseif ($interactive) {
      Add-Check 'User' 'Interactive user' 'OK' "$interactive (same account as this script)"
    }
  }

  $cs = $null
  try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch { }
  if ($cs) {
    $Script:Ctx.PartOfDomain = [bool]$cs.PartOfDomain
    $Script:Ctx.Domain = if ($cs.PartOfDomain) { $cs.Domain } else { '' }
  }
  $join = Get-DeviceJoinState
  $Script:Ctx.EntraJoined = $join.EntraJoined
  $Script:Ctx.MdmEnrolled = $join.MdmEnrolled
  $joinType = if ($Script:Ctx.PartOfDomain -and $join.EntraJoined) { "hybrid: AD domain $($Script:Ctx.Domain) + Entra ID" }
    elseif ($Script:Ctx.PartOfDomain) { "AD domain $($Script:Ctx.Domain)" }
    elseif ($join.EntraJoined) { 'Entra ID (Azure AD) joined, no on-premises AD domain' }
    elseif ($cs) { "workgroup $($cs.Workgroup)" }
    else { 'unknown' }
  if ($join.TenantName) { $joinType += ", tenant $($join.TenantName)" }
  Add-Check 'User' 'Device join type' 'INFO' $joinType
  if ($join.Available) {
    Add-Check 'User' 'MDM (Intune) enrollment' 'INFO' $(if ($join.MdmEnrolled) { "yes ($($join.MdmUrl))" } else { 'no' })
  }

  if ($Script:OnWindows) {
    $uacKey = Open-RegistryKey 'HKLM' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $enableLua = Get-RegistryValueSafe $uacKey 'EnableLUA'
    $consent = Get-RegistryValueSafe $uacKey 'ConsentPromptBehaviorAdmin'
    Add-Check 'User' 'UAC enabled (EnableLUA)' 'INFO' $(if ($null -ne $enableLua) { $enableLua } else { 'unknown' })
    Add-Check 'User' 'UAC admin consent prompt level' 'INFO' $(if ($null -ne $consent) { $consent } else { 'unknown' })
  }

  try {
    Get-ExecutionPolicy -List | ForEach-Object {
      Add-Check 'User' "Execution policy ($($_.Scope))" 'INFO' $_.ExecutionPolicy
    }
    $effective = [string](Get-ExecutionPolicy)
    $status = if ($effective -in @('Restricted', 'AllSigned')) { 'WARN' } else { 'OK' }
    Add-Check 'User' 'Execution policy (effective)' $status "$effective$(if ($status -eq 'WARN') { '; npm-generated *.ps1 shims will not run, use *.cmd' })"
  } catch { }

  Write-SubHeader 'Directory writability'
  foreach ($dir in @(
      @{ Name = 'LOCALAPPDATA'; Path = $env:LOCALAPPDATA },
      @{ Name = 'APPDATA'; Path = $env:APPDATA },
      @{ Name = 'USERPROFILE'; Path = $env:USERPROFILE },
      @{ Name = 'TEMP'; Path = [System.IO.Path]::GetTempPath() },
      @{ Name = 'ProgramFiles'; Path = $env:ProgramFiles }
    )) {
    if (-not $dir.Path) { continue }
    Add-WritableCheck 'User' "Writable: $($dir.Name)" $dir.Path
  }
}

# ============================================================================
# Section 3: codemie-cli installation state
# ============================================================================

function Get-RegistryPathValue {
  param([ValidateSet('Machine', 'User')][string]$Scope)

  $info = [PSCustomObject]@{ Scope = $Scope; Raw = ''; Kind = ''; Available = $false; Error = '' }
  if (-not $Script:OnWindows) {
    $info.Error = 'registry not available on this platform'
    return $info
  }

  $keyPath = if ($Scope -eq 'Machine') { "HKLM:\$MachineEnvKey" } else { 'HKCU:\Environment' }
  try {
    $key = Get-Item -LiteralPath $keyPath -ErrorAction Stop
    $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $raw) {
      $info.Raw = [string]$raw
      $info.Kind = [string]$key.GetValueKind('Path')
      $info.Available = $true
    }
  } catch {
    $info.Error = $_.Exception.Message
  }
  return $info
}

function Show-PathScope {
  param([string]$Scope, [string]$Raw, [string]$Kind, [hashtable]$Seen)

  $literal = $Kind -eq 'String'
  $effective = if ($literal) { $Raw } else { [Environment]::ExpandEnvironmentVariables($Raw) }
  $kindText = switch ($Kind) { 'String' { 'REG_SZ' } 'ExpandString' { 'REG_EXPAND_SZ' } '' { 'n/a' } default { $Kind } }
  Add-Check 'Installation' "PATH ($Scope)" 'INFO' "type $kindText, raw length $($Raw.Length), effective length $($effective.Length)"

  $effectiveEntries = New-Object System.Collections.Generic.List[string]
  $index = 0
  foreach ($entry in @($Raw -split ';')) {
    $index++
    if ([string]::IsNullOrWhiteSpace($entry)) {
      Write-Host ('    [{0,3}] <empty entry>' -f $index) -ForegroundColor Yellow
      continue
    }
    $flags = @()
    $hasVariable = $entry -match '%[^%]+%'
    if ($literal -and $hasVariable) {
      $flags += 'REG_SZ WITH %VAR%: expansion is not guaranteed'
      $Script:Ctx.LiteralVarEntries.Add([PSCustomObject]@{ Scope = $Scope; Entry = $entry.Trim().Trim('"') })
      $effectiveEntry = $entry.Trim().Trim('"')
    } else {
      $effectiveEntry = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
      if (-not (Test-Path -LiteralPath $effectiveEntry -PathType Container -ErrorAction SilentlyContinue)) { $flags += 'MISSING' }
    }
    $effectiveEntries.Add($effectiveEntry)

    $normalized = ConvertTo-NormalizedPath $effectiveEntry -NoExpand
    if ($Seen.ContainsKey($normalized)) { $flags += "DUPLICATE of $($Seen[$normalized])" } else { $Seen[$normalized] = "$Scope[$index]" }
    if ($entry -match '(?i)codemie|nodejs|\\npm') { $flags += 'NODE/CODEMIE' }

    $line = '    [{0,3}] {1}' -f $index, $entry
    if ($effectiveEntry -ne $entry.Trim().Trim('"')) { $line += "  ->  $effectiveEntry" }
    if ($flags.Count -gt 0) { $line += "  [$($flags -join ', ')]" }
    $color = if ($flags -match 'REG_SZ WITH') { 'Red' } elseif ($flags -match 'MISSING|DUPLICATE') { 'Yellow' } elseif ($flags -contains 'NODE/CODEMIE') { 'Green' } else { 'Gray' }
    Write-Host $line -ForegroundColor $color
  }

  return $effectiveEntries.ToArray()
}

function Get-RegSzFixCommand {
  param([string]$Scope)
  $hive = if ($Scope -eq 'Machine') { 'LocalMachine' } else { 'CurrentUser' }
  $sub = if ($Scope -eq 'Machine') { $MachineEnvKey } else { 'Environment' }
  return "`$k=[Microsoft.Win32.Registry]::$hive.OpenSubKey('$sub',`$true); `$k.SetValue('Path',`$k.GetValue('Path','','DoNotExpandEnvironmentNames'),'ExpandString')"
}

function Test-DirHasContent {
  param([string]$Dir)
  if (-not (Test-Path -LiteralPath $Dir -PathType Container -ErrorAction SilentlyContinue)) { return $false }
  try {
    return [bool](Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop | Select-Object -First 1)
  } catch {
    return $true
  }
}

function Show-LiteralVarVerdict {
  param([string[]]$ProcessNormalized)
  $why = 'PATH is REG_SZ, so Windows does not guarantee %VARIABLES% expansion: some ways of starting processes (logon, Explorer refresh) expand them, others pass the text literally'
  foreach ($scope in @('Machine', 'User')) {
    $items = @($Script:Ctx.LiteralVarEntries | Where-Object { $_.Scope -eq $scope })
    if ($items.Count -eq 0) { continue }
    $fix = "Fix: convert PATH to REG_EXPAND_SZ: $(Get-RegSzFixCommand $scope)"

    $used = @($items | Where-Object { Test-DirHasContent ([Environment]::ExpandEnvironmentVariables($_.Entry)) })
    $unused = @($items | Where-Object { $used -notcontains $_ })
    $usedLiteral = @($used | Where-Object { $ProcessNormalized -contains (ConvertTo-NormalizedPath $_.Entry -NoExpand) })

    if ($usedLiteral.Count -gt 0) {
      Add-Check 'Installation' "PATH ($scope) value type" 'FAIL' "unresolved in THIS session (PATH holds the literal text), so commands in it are not found: $(($usedLiteral | ForEach-Object { $_.Entry }) -join '; '). $why. $fix"
    } elseif ($used.Count -gt 0) {
      Add-Check 'Installation' "PATH ($scope) value type" 'WARN' "$($used.Count) entr(ies) with %VARIABLES%: $(($used | ForEach-Object { $_.Entry }) -join '; '). Expanded in this session, but other sessions may get the literal text. $why. $fix"
    }
    if ($unused.Count -gt 0) {
      Add-Check 'Installation' "PATH ($scope) unused %VAR% entries" 'WARN' "$(($unused | ForEach-Object { $_.Entry }) -join '; '): may not resolve ($why), but the directory is empty or missing, so nothing depends on it today. Suggested: remove the entry from the $scope PATH"
    }
  }
}

function Show-PathAnalysis {
  Write-SubHeader 'PATH environment variable (raw registry values, unexpanded)'
  $seen = @{}
  $Script:Ctx.LiteralVarEntries = New-Object System.Collections.Generic.List[object]
  $machine = Get-RegistryPathValue -Scope 'Machine'
  $user = Get-RegistryPathValue -Scope 'User'

  $machineEntries = @()
  $userEntries = @()
  if ($machine.Available) {
    $machineEntries = @(Show-PathScope -Scope 'Machine' -Raw $machine.Raw -Kind $machine.Kind -Seen $seen)
  } else {
    Add-Check 'Installation' 'PATH (Machine)' 'INFO' "not available: $($machine.Error)"
  }
  if ($user.Available) {
    $userEntries = @(Show-PathScope -Scope 'User' -Raw $user.Raw -Kind $user.Kind -Seen $seen)
  } else {
    Add-Check 'Installation' 'PATH (User)' 'INFO' "not set or not available $($user.Error)"
  }

  $combinedLength = (($machineEntries -join ';').Length) + (($userEntries -join ';').Length) + 1
  if ($machine.Available -or $user.Available) {
    if ($combinedLength -gt 32000) {
      Add-Check 'Installation' 'PATH combined length' 'FAIL' "$combinedLength chars; exceeds the 32767 environment variable limit"
    } elseif ($combinedLength -gt 2047) {
      Add-Check 'Installation' 'PATH combined length' 'WARN' "$combinedLength chars; legacy tools and 'setx' (1024) may truncate PATH"
    } else {
      Add-Check 'Installation' 'PATH combined length' 'OK' "$combinedLength chars"
    }
  }

  Write-SubHeader 'PATH of this PowerShell session'
  $processRaw = "$env:PATH"
  $processEntries = @($processRaw -split [System.IO.Path]::PathSeparator | Where-Object { $_.Trim() })
  Add-Check 'Installation' 'PATH (Process)' 'INFO' "$($processEntries.Count) entries, length $($processRaw.Length)"
  $index = 0
  foreach ($entry in $processEntries) {
    $index++
    Write-Host ('    [{0,3}] {1}' -f $index, $entry)
  }

  if ($machine.Available -or $user.Available) {
    $processNormalized = @($processEntries | ForEach-Object { ConvertTo-NormalizedPath $_ -NoExpand })
    $registryForms = @(@($machineEntries) + @($userEntries) | Where-Object { $_ } | ForEach-Object {
        [PSCustomObject]@{ Literal = (ConvertTo-NormalizedPath $_ -NoExpand); Expanded = (ConvertTo-NormalizedPath $_) }
      })
    $knownForms = @($registryForms | ForEach-Object { $_.Literal; $_.Expanded } | Select-Object -Unique)
    $missingInProcess = @($registryForms | Where-Object { ($processNormalized -notcontains $_.Literal) -and ($processNormalized -notcontains $_.Expanded) } | ForEach-Object { $_.Literal } | Select-Object -Unique)
    $extraInProcess = @($processNormalized | Where-Object { $knownForms -notcontains $_ } | Select-Object -Unique)
    if ($missingInProcess.Count -gt 0) {
      Add-Check 'Installation' 'Session PATH vs registry' 'WARN' "$($missingInProcess.Count) registry entr(ies) missing in this session; open a new terminal or sign out/in"
      $missingInProcess | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
    } else {
      Add-Check 'Installation' 'Session PATH vs registry' 'OK' 'all registry PATH entries are present in this session'
    }
    if ($extraInProcess.Count -gt 0) {
      Add-Check 'Installation' 'Session-only PATH entries' 'INFO' "$($extraInProcess.Count) entr(ies) added by the shell/parent process (not in registry)"
      $extraInProcess | ForEach-Object { Write-Host "    + $_" }
    }
    Show-LiteralVarVerdict -ProcessNormalized $processNormalized
  }
}

function Test-RunnableOnWindows {
  param([string]$Path)
  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  $pathExt = if ($env:PATHEXT) { $env:PATHEXT } else { '.COM;.EXE;.BAT;.CMD' }
  return ($extension -and (($pathExt.ToLowerInvariant() -split ';') -contains $extension))
}

function Show-CommandResolution {
  Write-SubHeader 'Command resolution (all matches on PATH, first one wins)'
  $resolved = New-Object System.Collections.Generic.List[string]
  $effectivePolicy = 'Unrestricted'
  try { $effectivePolicy = [string](Get-ExecutionPolicy) } catch { }

  foreach ($cmdName in $KnownCommands) {
    $all = @(Get-Command $cmdName -All -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandType -in @('Application', 'ExternalScript') })
    if ($all.Count -eq 0) {
      Add-Check 'Installation' "Command: $cmdName" 'INFO' 'not found on PATH'
      continue
    }

    $paths = @($all | ForEach-Object { if ($_.Source) { $_.Source } else { $_.Path } })
    $firstPath = $paths[0]
    $status = 'OK'
    $detail = $firstPath
    if ($firstPath -like '*.ps1' -and $effectivePolicy -in @('Restricted', 'AllSigned')) {
      $status = 'WARN'
      $detail = "$firstPath (PowerShell picks .ps1, blocked by execution policy $effectivePolicy; use $cmdName.cmd)"
    }
    $dirs = @($paths | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)
    if ($cmdName -ne 'codemie' -and $paths.Count -gt 1) {
      $detail += " (+$($paths.Count - 1) more in $(if ($dirs.Count -gt 1) { "$($dirs.Count) directories" } else { 'the same directory' }))"
    }
    Add-Check 'Installation' "Command: $cmdName" $status $detail

    foreach ($path in $paths) {
      if (-not ($resolved -contains $path)) { $resolved.Add($path) }
    }

    if ($cmdName -eq 'codemie') {
      foreach ($path in $paths) {
        $note = ''
        if ($Script:OnWindows -and -not ($path -like '*.ps1') -and -not (Test-RunnableOnWindows $path)) { $note = ' - POSIX shell shim for Git Bash/WSL, not runnable from cmd/PowerShell' }
        Write-Host "      - $path$note"
      }
      if ($Script:OnWindows) {
        $whereRes = Invoke-External 'where.exe' @($cmdName) 15 -Oem
        $cmdPick = @($whereRes.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and (Test-RunnableOnWindows $_) }) | Select-Object -First 1
        if ($cmdPick) { Write-Host "      cmd.exe runs: $cmdPick" }
      }
    }
  }

  $distinctDirs = @($resolved | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)
  if ($distinctDirs.Count -gt 1) {
    Add-Check 'Installation' 'Command locations' 'WARN' "CodeMie commands come from $($distinctDirs.Count) different directories: $($distinctDirs -join '; ')"
  }
  return $resolved
}

function Get-ShimTarget {
  param([string]$ShimPath)
  try {
    $info = Get-Item -LiteralPath $ShimPath -ErrorAction Stop
    if ($info.Length -gt 65536) { return '' }
    $content = Get-Content -LiteralPath $ShimPath -Raw -ErrorAction Stop
  } catch {
    return ''
  }
  $dir = Split-Path $ShimPath -Parent
  $candidate = ''
  if ($content -match '(?im)^\s*call\s+"([^"]+\.cmd)"') {
    $candidate = $Matches[1]
  } elseif ($content -match '"(?:%~?dp0%?|\$basedir)[\\/]+([^"]*node_modules[\\/][^"]+)"') {
    $candidate = Join-Path $dir $Matches[1]
  } elseif ($content -match '"([A-Za-z]:\\[^"]*node_modules\\[^"]+)"') {
    $candidate = $Matches[1]
  }
  if (-not $candidate) { return '' }
  return ($candidate -replace '[\\/]+', [string][System.IO.Path]::DirectorySeparatorChar)
}

function Get-PackageDirFromPath {
  param([string]$Path)
  if ($Path -match '^(.*[\\/]node_modules[\\/]@codemieai[\\/]code)(?:[\\/]|$)') { return $Matches[1] }
  return ''
}

function Show-ShimChain {
  param([string]$Executable)
  Write-SubHeader "Shim target ($Executable)"
  $current = $Executable
  for ($hop = 1; $hop -le 3; $hop++) {
    $target = Get-ShimTarget $current
    if (-not $target) {
      if ($hop -eq 1) { Add-Check 'Installation' 'Shim target' 'INFO' 'not a recognizable npm/CodeMie shim' }
      return ''
    }
    if (-not (Test-Path -LiteralPath $target -ErrorAction SilentlyContinue)) {
      Add-Check 'Installation' "Shim target (hop $hop)" 'FAIL' "$current points to missing $target; the installation is broken, reinstall $PackageName"
      return ''
    }
    Add-Check 'Installation' "Shim target (hop $hop)" 'OK' $target
    $packageDir = Get-PackageDirFromPath $target
    if ($packageDir) { return $packageDir }
    $current = $target
  }
  return ''
}

function Get-PreferredCodemieExecutable {
  param([string[]]$Candidates)
  $codemie = @($Candidates | Where-Object { [System.IO.Path]::GetFileNameWithoutExtension($_) -ieq 'codemie' })
  if ($codemie.Count -eq 0) { return '' }
  $cmd = $codemie | Where-Object { $_ -like '*.cmd' } | Select-Object -First 1
  if ($cmd) { return $cmd }
  $runnable = $codemie | Where-Object { $_ -notlike '*.ps1' -and (-not $Script:OnWindows -or (Test-RunnableOnWindows $_)) } | Select-Object -First 1
  if ($runnable) { return $runnable }
  return ''
}

function Get-DoctorVerdict {
  param($Result)
  if ($Result.TimedOut) { return [PSCustomObject]@{ Status = 'WARN'; Detail = "timed out after $DoctorTimeoutSec s (partial output below)" } }
  $errorMark = [string][char]0x2717
  $warnMark = [string][char]0x26A0
  $lines = @("$($Result.StdOut)" -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch 'Some issues detected' })
  $errors = @($lines | Where-Object { $_.StartsWith($errorMark) }).Count
  $warnings = @($lines | Where-Object { $_.StartsWith($warnMark) }).Count
  if ($Result.ExitCode -eq 0) { return [PSCustomObject]@{ Status = 'OK'; Detail = 'all checks passed' } }
  if ($errors -gt 0) { return [PSCustomObject]@{ Status = 'FAIL'; Detail = "$errors error(s), $warnings warning(s) reported (see output below)" } }
  if ($warnings -gt 0) { return [PSCustomObject]@{ Status = 'INFO'; Detail = "no errors, $warnings warning(s) reported (exit code $($Result.ExitCode) is used for warnings too; see output below)" } }
  return [PSCustomObject]@{ Status = 'WARN'; Detail = "exit code $($Result.ExitCode): $(Get-FirstLine $Result.StdErr)" }
}

function Invoke-CodemieCommands {
  param([string]$Executable)

  Write-SubHeader "CodeMie CLI self-check ($Executable)"
  $versionRes = Invoke-External $Executable @('--version') 60
  if ($versionRes.ExitCode -eq 0 -and (Get-FirstLine $versionRes.StdOut)) {
    Add-Check 'Installation' 'codemie --version' 'OK' (Get-FirstLine $versionRes.StdOut)
  } else {
    $why = if ($versionRes.TimedOut) { 'timed out' } else { "exit $($versionRes.ExitCode): $(Get-FirstLine ($versionRes.StdErr + $versionRes.Error))" }
    Add-Check 'Installation' 'codemie --version' 'FAIL' $why
  }

  if ($SkipDoctor) {
    Add-Check 'Installation' 'codemie doctor' 'INFO' 'skipped (-SkipDoctor)'
    return
  }

  $doctorRes = Invoke-External $Executable @('doctor') $DoctorTimeoutSec
  $verdict = Get-DoctorVerdict $doctorRes
  Add-Check 'Installation' 'codemie doctor' $verdict.Status $verdict.Detail
  $output = (Protect-SensitiveText ($doctorRes.StdOut + "`n" + $doctorRes.StdErr)) -replace '\x1B\[[0-9;?]*[ -/]*[@-~]', ''
  Write-Host '    --- codemie doctor output ---'
  Write-Indented $output.Trim() 4
  Write-Host '    --- end ---'
}

function Show-PackageInstallations {
  param([string[]]$ResolvedCommands, [string[]]$ExtraPackageDirs = @())

  Write-SubHeader "Installed $PackageName packages"
  $npmGlobalRoot = ''
  if ($Script:Ctx.NpmPath) {
    $rootRes = Invoke-External $Script:Ctx.NpmPath @('root', '-g') 60
    if ($rootRes.ExitCode -eq 0) { $npmGlobalRoot = Get-FirstLine $rootRes.StdOut }
  }

  $nodeModuleDirs = New-Object System.Collections.Generic.List[string]
  $candidates = @(
    $npmGlobalRoot,
    (Join-PathSafe $env:LOCALAPPDATA 'CodeMie\npm-prefix\node_modules'),
    (Join-PathSafe $env:APPDATA 'npm\node_modules'),
    (Join-PathSafe $env:ProgramFiles 'nodejs\node_modules')
  )
  if ($Script:Ctx.NodePath) { $candidates += (Join-Path (Split-Path $Script:Ctx.NodePath) 'node_modules') }
  foreach ($pkgDir in $ExtraPackageDirs) {
    if ($pkgDir) { $candidates += (Split-Path (Split-Path $pkgDir -Parent) -Parent) }
  }
  foreach ($cmdPath in $ResolvedCommands) {
    $dir = Split-Path $cmdPath -Parent
    $candidates += (Join-Path $dir 'node_modules')
    $candidates += (Join-Path (Split-Path $dir -Parent) 'lib/node_modules')
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $normalized = ConvertTo-NormalizedPath $candidate
    if (-not ($nodeModuleDirs | Where-Object { (ConvertTo-NormalizedPath $_) -eq $normalized })) {
      $nodeModuleDirs.Add($candidate)
    }
  }

  $found = 0
  foreach ($dir in $nodeModuleDirs) {
    $pkgJson = Join-Path $dir '@codemieai/code/package.json'
    if (Test-Path -LiteralPath $pkgJson -ErrorAction SilentlyContinue) {
      $found++
      $version = ''
      try { $version = (Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json).version } catch { }
      $label = if ((ConvertTo-NormalizedPath $dir) -eq (ConvertTo-NormalizedPath $npmGlobalRoot)) { 'npm global root' } else { 'node_modules' }
      Add-Check 'Installation' "Package ($label)" 'OK' "$version at $(Split-Path $pkgJson -Parent)"
    }
  }

  if ($found -eq 0) {
    Add-Check 'Installation' "Package $PackageName" 'WARN' "not found in: $($nodeModuleDirs -join '; ')"
  } elseif ($found -gt 1) {
    Add-Check 'Installation' "Package $PackageName" 'WARN' "$found installations found; PATH order decides which one runs"
  }

  Write-SubHeader 'Known install roots'
  $Script:Ctx.PackagesFound = $found
  foreach ($root in @(
      @{ Name = 'Portable install root'; Path = (Join-PathSafe $env:LOCALAPPDATA 'CodeMie') },
      @{ Name = 'Portable bin dir'; Path = (Join-PathSafe $env:LOCALAPPDATA 'CodeMie\bin') },
      @{ Name = 'Portable npm-prefix'; Path = (Join-PathSafe $env:LOCALAPPDATA 'CodeMie\npm-prefix') },
      @{ Name = 'npm global root'; Path = $npmGlobalRoot },
      @{ Name = 'npm user bin (APPDATA\npm)'; Path = (Join-PathSafe $env:APPDATA 'npm') }
    )) {
    if (-not $root.Path) { continue }
    if (Test-Path -LiteralPath $root.Path -ErrorAction SilentlyContinue) {
      Add-Check 'Installation' $root.Name 'OK' $root.Path
    } else {
      Add-Check 'Installation' $root.Name 'INFO' "not present ($($root.Path))"
    }
  }

  Show-PortableContents
}

function Get-NodeModulesPackages {
  param([string]$NodeModules)
  if (-not (Test-Path -LiteralPath $NodeModules -PathType Container -ErrorAction SilentlyContinue)) { return @() }
  $names = foreach ($entry in Get-ChildItem -LiteralPath $NodeModules -Directory -ErrorAction SilentlyContinue) {
    if ($entry.Name -like '.*') { continue }
    if ($entry.Name -like '@*') {
      Get-ChildItem -LiteralPath $entry.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object { "$($entry.Name)/$($_.Name)" }
    } else {
      $entry.Name
    }
  }
  return @($names)
}

function Show-PortableContents {
  $root = Join-PathSafe $env:LOCALAPPDATA 'CodeMie'
  if (-not $root -or -not (Test-Path -LiteralPath $root -ErrorAction SilentlyContinue)) { return }

  $binDir = Join-Path $root 'bin'
  $prefixDir = Join-Path $root 'npm-prefix'
  $shims = @(Get-ChildItem -LiteralPath $binDir -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $packages = @(Get-NodeModulesPackages (Join-Path $prefixDir 'node_modules'))
  Add-Check 'Installation' 'Portable bin contents' 'INFO' $(if ($shims.Count) { "$($shims.Count) file(s): $($shims -join ', ')" } else { 'empty' })
  Add-Check 'Installation' 'Portable npm-prefix packages' 'INFO' $(if ($packages.Count) { $packages -join ', ' } else { 'none' })

  $binOnPath = Test-DirOnAnyPath $binDir
  $prefixOnPath = Test-DirOnAnyPath $prefixDir
  $hasPackage = $packages -contains $PackageName
  if ($shims.Count -gt 0 -and -not $hasPackage) {
    if ($binOnPath) {
      Add-Check 'Installation' 'Portable install state' 'WARN' "$binDir is on PATH and holds CodeMie shims, but $PackageName is missing from $prefixDir; those commands fail or shadow the working install. Remove $binDir from PATH (or rerun install.ps1)"
    } else {
      Add-Check 'Installation' 'Portable install state' 'INFO' "leftover shims of an old portable install in $binDir; not on PATH, so harmless"
    }
  }
  if ($prefixOnPath -and $packages.Count -eq 0) {
    Add-Check 'Installation' 'Portable npm-prefix on PATH' 'INFO' "$prefixDir is on PATH but empty; the PATH entry is unused and can be removed"
  }
  if ($packages.Count -gt 0 -and -not $hasPackage) {
    Add-Check 'Installation' 'Portable install state' 'INFO' "packages stranded in the old portable prefix (installed by an older installer); reinstall them with npm i -g <name> if you still need them"
  }
  if (-not $hasPackage -and -not $binOnPath -and -not $prefixOnPath) {
    Add-Check 'Installation' 'Portable leftovers' 'INFO' "nothing in $root is in use; the folder can be deleted"
  }
}

function Test-DirOnAnyPath {
  param([string]$Dir)
  $target = ConvertTo-NormalizedPath $Dir
  $entries = @("$env:PATH" -split [System.IO.Path]::PathSeparator)
  foreach ($scope in @('Machine', 'User')) {
    $reg = Get-RegistryPathValue -Scope $scope
    if ($reg.Available) { $entries += @($reg.Raw -split ';') }
  }
  foreach ($entry in $entries) {
    if ($entry -and (ConvertTo-NormalizedPath $entry) -eq $target) { return $true }
  }
  return $false
}

function Show-TextFile {
  param([string]$Label, [string]$Path, [string]$Category = 'Installation')
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction SilentlyContinue)) {
    Add-Check $Category $Label 'INFO' "not found$(if ($Path) { " at $Path" })"
    return
  }

  Add-Check $Category $Label 'OK' "found at $Path"
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    Write-Host "    --- $Path (secrets and e-mails masked) ---"
    Write-Indented (Protect-SensitiveText $raw) 4
    Write-Host '    --- end ---'
  } catch {
    Write-Host "    (could not read file: $($_.Exception.Message))"
  }
}

function Get-NpmrcPrefix {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)) { return '' }
  $prefix = ''
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
    if ($line -match '^\s*prefix\s*=\s*(.*?)\s*$') { $prefix = $Matches[1].Trim('"') }
  }
  return $prefix
}

function Show-Configuration {
  Write-SubHeader 'CodeMie configuration'
  $codemieHome = if ($env:CODEMIE_HOME) { $env:CODEMIE_HOME } else { Join-PathSafe $env:USERPROFILE '.codemie' }
  if (-not $codemieHome -and $HOME) { $codemieHome = Join-Path $HOME '.codemie' }
  $homeSource = if ($env:CODEMIE_HOME) { 'CODEMIE_HOME' } else { 'default' }

  if ($codemieHome -and (Test-Path -LiteralPath $codemieHome -ErrorAction SilentlyContinue)) {
    Add-Check 'Installation' 'CodeMie home' 'OK' "$codemieHome ($homeSource)"
    Get-ChildItem -LiteralPath $codemieHome -Force -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
      $kind = if ($_.PSIsContainer) { '<dir> ' } else { '{0,8:N0}' -f $_.Length }
      Write-Host ('    {0} {1:yyyy-MM-dd HH:mm}  {2}' -f $kind, $_.LastWriteTime, $_.Name)
    }
  } else {
    Add-Check 'Installation' 'CodeMie home' 'INFO' "not present ($codemieHome, $homeSource)"
  }

  Show-TextFile -Label 'Config: global' -Path (Join-PathSafe $codemieHome 'codemie-cli.config.json')
  Show-TextFile -Label 'Config: current directory' -Path (Join-Path (Get-Location).Path '.codemie\codemie-cli.config.json')

  $parentDir = Split-Path (Get-Location).Path -Parent
  $depth = 0
  $globalNormalized = ConvertTo-NormalizedPath (Join-PathSafe $codemieHome 'codemie-cli.config.json')
  while ($parentDir -and $depth -lt 3) {
    $candidate = Join-Path $parentDir '.codemie\codemie-cli.config.json'
    if ((ConvertTo-NormalizedPath $candidate) -ne $globalNormalized -and (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue)) {
      Show-TextFile -Label "Config: parent $parentDir" -Path $candidate
    }
    $next = Split-Path $parentDir -Parent
    if ($next -eq $parentDir) { break }
    $parentDir = $next
    $depth++
  }

  Write-SubHeader 'Environment variables (CodeMie, Node.js, npm, proxy)'
  $envPattern = '^(CODEMIE_|NODE_|NPM_CONFIG_|HTTPS?_PROXY$|NO_PROXY$|ANTHROPIC_|OPENAI_)'
  $scopes = @('Process')
  if ($Script:OnWindows) { $scopes += @('User', 'Machine') }
  $any = $false
  foreach ($scope in $scopes) {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($name in ($vars.Keys | Sort-Object)) {
      if ($name -match $envPattern) {
        $any = $true
        Write-Host ('    [{0,-7}] {1} = {2}' -f $scope, $name, (Protect-EnvValue $name ([string]$vars[$name])))
      }
    }
  }
  if (-not $any) { Add-Check 'Installation' 'Relevant environment variables' 'INFO' 'none set' }

  if (-not $Script:Ctx.NpmPath) { return }

  Write-SubHeader 'npm configuration files'
  $userConfig = Get-NpmConfigValue 'userconfig'
  $globalConfig = Get-NpmConfigValue 'globalconfig'
  Show-TextFile -Label 'npmrc: user' -Path $userConfig
  Show-TextFile -Label 'npmrc: global' -Path $globalConfig
  if ($Script:Ctx.NodePath) {
    Show-TextFile -Label 'npmrc: builtin' -Path (Join-Path (Split-Path $Script:Ctx.NodePath) 'node_modules\npm\npmrc')
  }
  Show-TextFile -Label 'npmrc: current directory' -Path (Join-Path (Get-Location).Path '.npmrc')

  $legacyPrefix = Join-PathSafe $env:LOCALAPPDATA 'CodeMie\npm-prefix'
  $userPrefix = Get-NpmrcPrefix $userConfig
  if ($userPrefix -and $legacyPrefix -and ((ConvertTo-NormalizedPath $userPrefix) -eq (ConvertTo-NormalizedPath $legacyPrefix))) {
    Add-Check 'Installation' 'Legacy npm prefix override' 'WARN' "user .npmrc sets prefix=$userPrefix; every 'npm install -g' goes there. Fix: npm config delete prefix --location user (or rerun install.ps1)"
  } elseif ($userPrefix -and ((ConvertTo-NormalizedPath $userPrefix) -eq (ConvertTo-NormalizedPath (Join-PathSafe $env:APPDATA 'npm')))) {
    Add-Check 'Installation' 'User npm prefix override' 'OK' "user .npmrc sets prefix=$userPrefix (same as the npm default, harmless)"
  } elseif ($userPrefix) {
    Add-Check 'Installation' 'User npm prefix override' 'INFO' "user .npmrc sets prefix=$userPrefix"
  } else {
    Add-Check 'Installation' 'Legacy npm prefix override' 'OK' 'not present'
  }
}

function Get-SearchRoots {
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $full = @($SearchRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container -ErrorAction SilentlyContinue) } | ForEach-Object {
      [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/')
    } | Sort-Object -Property Length)

  $result = New-Object System.Collections.Generic.List[string]
  foreach ($root in $full) {
    $covered = $false
    foreach ($kept in $result) {
      if ($root -ieq $kept -or $root.StartsWith($kept + $separator, [System.StringComparison]::OrdinalIgnoreCase)) {
        $covered = $true
        break
      }
    }
    if (-not $covered) { $result.Add($root) }
  }
  return $result
}

function Search-CodemieFilesystem {
  Write-SubHeader 'Fallback filesystem search (PATH lookup did not reveal the installation)'

  $roots = @(Get-SearchRoots)
  if ($roots.Count -eq 0) {
    Add-Check 'Installation' 'Filesystem search' 'WARN' 'no valid search roots available'
    return @()
  }
  Add-Check 'Installation' 'Filesystem search roots' 'INFO' "$($roots -join '; ') (depth $MaxSearchDepth, budget $SearchTimeoutSec s)"

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $hits = New-Object System.Collections.Generic.List[string]
  $packages = New-Object System.Collections.Generic.List[string]
  $queue = New-Object System.Collections.Generic.Queue[object]
  foreach ($root in $roots) { $queue.Enqueue(@($root, 0)) }
  $timedOut = $false
  $scannedDirs = 0

  while ($queue.Count -gt 0) {
    if ($stopwatch.Elapsed.TotalSeconds -gt $SearchTimeoutSec) {
      $timedOut = $true
      break
    }
    $item = $queue.Dequeue()
    $dirPath = $item[0]
    $depth = $item[1]
    $scannedDirs++

    try {
      $dirInfo = New-Object System.IO.DirectoryInfo($dirPath)
      $dirName = $dirInfo.Name

      foreach ($file in $dirInfo.GetFiles()) {
        if ($file.Name -ieq 'codemie-cli.config.json' -or ($file.Name -like 'codemie*' -and $file.Extension -in @('.cmd', '.ps1', '.exe', ''))) {
          $hits.Add($file.FullName)
        }
      }

      if ($depth -ge $MaxSearchDepth) { continue }

      foreach ($sub in $dirInfo.GetDirectories()) {
        if ($sub.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ($SearchExcludedDirNames -contains $sub.Name) { continue }
        if ($dirName -ieq 'node_modules' -and $sub.Name -notin @('@codemieai', '.bin')) { continue }
        if ($dirName -ieq '@codemieai') {
          if ($sub.Name -ieq 'code' -and (Test-Path -LiteralPath (Join-Path $sub.FullName 'package.json'))) {
            $packages.Add($sub.FullName)
          }
          continue
        }
        $queue.Enqueue(@($sub.FullName, ($depth + 1)))
      }
    } catch { }
  }
  $stopwatch.Stop()

  $elapsed = [int]$stopwatch.Elapsed.TotalSeconds
  if ($timedOut) {
    Add-Check 'Installation' 'Filesystem search' 'WARN' "time budget exhausted after $scannedDirs directories; results are partial (raise -SearchTimeoutSec)"
  }

  foreach ($pkg in ($packages | Select-Object -Unique)) {
    $version = ''
    try { $version = (Get-Content -LiteralPath (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version } catch { }
    Add-Check 'Installation' 'Found package' 'OK' "$version at $pkg"
  }

  $uniqueHits = @($hits | Select-Object -Unique)
  if ($uniqueHits.Count -eq 0 -and $packages.Count -eq 0) {
    Add-Check 'Installation' 'Filesystem search result' 'WARN' "nothing found ($scannedDirs directories, $elapsed s)"
  } else {
    Add-Check 'Installation' 'Filesystem search result' 'OK' "$($uniqueHits.Count) file(s), $($packages.Count) package(s) ($scannedDirs directories, $elapsed s)"
    foreach ($hit in $uniqueHits) { Write-Host "    - $hit" }

    $pathDirs = @("$env:PATH" -split [System.IO.Path]::PathSeparator | ForEach-Object { ConvertTo-NormalizedPath $_ } | Where-Object { $_ })
    $shimDirs = @($uniqueHits | Where-Object { [System.IO.Path]::GetFileName($_) -like 'codemie*' -and $_ -notlike '*.json' } | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)
    foreach ($dir in $shimDirs) {
      if ($pathDirs -notcontains (ConvertTo-NormalizedPath $dir)) {
        Add-Check 'Installation' 'Found but not on PATH' 'WARN' "$dir holds CodeMie commands but is not on PATH; add it to the user PATH (or rerun install.ps1) and open a new terminal"
      }
    }
  }
  return $uniqueHits
}

function Invoke-InstallationStateCheck {
  Write-SectionHeader '3. codemie-cli Installation State'

  Invoke-Section 'PATH analysis' { Show-PathAnalysis }
  $resolved = @(Show-CommandResolution)
  $executable = Get-PreferredCodemieExecutable $resolved
  $shimPackage = ''
  if ($executable) { $shimPackage = Show-ShimChain $executable }

  $Script:Ctx.PackagesFound = 0
  Invoke-Section 'Installed packages' { Show-PackageInstallations -ResolvedCommands $resolved -ExtraPackageDirs @($shimPackage) }
  Invoke-Section 'Configuration' { Show-Configuration }

  $needSearch = ($resolved.Count -eq 0) -or ($Script:Ctx.PackagesFound -eq 0)
  if ($needSearch) {
    if ($SkipDeepSearch) {
      Add-Check 'Installation' 'Filesystem search' 'INFO' 'skipped (-SkipDeepSearch); PATH lookup did not reveal the installation'
    } else {
      $hits = @(Search-CodemieFilesystem)
      if (-not $executable) { $executable = Get-PreferredCodemieExecutable $hits }
    }
  }

  if ($executable) {
    Invoke-CodemieCommands $executable
  } else {
    Add-Check 'Installation' 'codemie executable' 'FAIL' 'no runnable codemie executable found'
  }
}

# ============================================================================
# Section 4: Group Policy settings for PATH
# ============================================================================

function ConvertTo-GppAction {
  param([string]$Code)
  switch ($Code) {
    'C' { 'Create' }
    'R' { 'Replace' }
    'U' { 'Update' }
    'D' { 'Delete' }
    default { $Code }
  }
}

function Test-EnvRegistryKey {
  param([string]$Hive, [string]$Key)
  $k = $Key.Trim('\')
  if ($k -match '(?i)^SYSTEM\\(CurrentControlSet|ControlSet\d+)\\Control\\Session Manager\\Environment$') { return $true }
  if ($Hive -match '(?i)HKEY_CURRENT_USER|HKCU|HKEY_USERS' -and $k -match '(?i)(^|\\)Environment$') { return $true }
  return $false
}

function Read-GppEnvironmentXml {
  param([string]$Path)
  [xml]$doc = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  foreach ($node in $doc.SelectNodes("//*[local-name()='EnvironmentVar' or local-name()='EnvironmentVariable']")) {
    $props = $node.SelectSingleNode("*[local-name()='Properties']")
    if (-not $props) { continue }
    $filters = $node.SelectSingleNode("*[local-name()='Filters']")
    [PSCustomObject]@{
      Kind     = 'Environment'
      Name     = $props.GetAttribute('name')
      Action   = ConvertTo-GppAction $props.GetAttribute('action')
      Value    = $props.GetAttribute('value')
      Target   = if ($props.GetAttribute('user') -eq '1') { 'User variable' } else { 'System variable' }
      Partial  = $props.GetAttribute('partial') -eq '1'
      Disabled = $node.GetAttribute('disabled') -eq '1'
      Filtered = [bool]($filters -and $filters.HasChildNodes)
    }
  }
}

function Read-GppRegistryXml {
  param([string]$Path)
  [xml]$doc = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  foreach ($node in $doc.SelectNodes("//*[local-name()='Registry']")) {
    $props = $node.SelectSingleNode("*[local-name()='Properties']")
    if (-not $props) { continue }
    $hive = $props.GetAttribute('hive')
    $key = $props.GetAttribute('key')
    if (-not (Test-EnvRegistryKey $hive $key)) { continue }
    $filters = $node.SelectSingleNode("*[local-name()='Filters']")
    [PSCustomObject]@{
      Kind     = 'Registry'
      Name     = $props.GetAttribute('name')
      Action   = ConvertTo-GppAction $props.GetAttribute('action')
      Value    = $props.GetAttribute('value')
      Target   = "$hive\$key ($($props.GetAttribute('type')))"
      Partial  = $false
      Disabled = $node.GetAttribute('disabled') -eq '1'
      Filtered = [bool]($filters -and $filters.HasChildNodes)
    }
  }
}

function Get-GppEffect {
  param($Setting)
  if ($Setting.Disabled) { return [PSCustomObject]@{ Text = 'DISABLED, not applied'; Severity = 'INFO' } }
  $suffix = if ($Setting.Filtered) { ' (only where item-level targeting matches)' } else { '' }
  if ($Setting.Kind -eq 'Environment' -and $Setting.Partial) {
    $text = switch ($Setting.Action) { 'Delete' { 'removes this entry from PATH' } default { 'appends this entry to PATH if missing' } }
    return [PSCustomObject]@{ Text = "$text$suffix"; Severity = 'INFO' }
  }
  switch ($Setting.Action) {
    'Create' { return [PSCustomObject]@{ Text = "sets PATH only if it does not exist yet, so no effect on an existing PATH$suffix"; Severity = 'INFO' } }
    'Delete' { return [PSCustomObject]@{ Text = "DELETES THE WHOLE PATH VALUE$suffix"; Severity = 'WARN' } }
    default { return [PSCustomObject]@{ Text = "OVERWRITES THE WHOLE PATH VALUE$suffix"; Severity = 'WARN' } }
  }
}

function Write-GppSettings {
  param([object[]]$Settings, [string]$Source)
  $pathSettings = @($Settings | Where-Object { $_.Name -match '(?i)^path$' })
  $otherCount = @($Settings).Count - $pathSettings.Count
  $destructive = 0
  foreach ($s in $pathSettings) {
    $effect = Get-GppEffect $s
    if ($effect.Severity -eq 'WARN') { $destructive++ }
    $color = if ($effect.Severity -eq 'WARN') { 'Yellow' } else { 'Green' }
    Write-Host "    [$($s.Kind)] $($s.Action) '$($s.Name)' -> $($s.Target) [$($effect.Text)]" -ForegroundColor $color
    Write-Host "      value: $($s.Value)"
  }
  if ($destructive -gt 0) {
    Add-Check 'GPO' 'PATH setting(s)' 'WARN' "$destructive setting(s) in $Source overwrite or delete the whole PATH; installer/user PATH changes are reverted on every policy refresh"
  } elseif ($pathSettings.Count -gt 0) {
    Add-Check 'GPO' 'PATH setting(s)' 'INFO' "$($pathSettings.Count) non-destructive PATH setting(s) in $Source"
  }
  if ($otherCount -gt 0) {
    Write-Host "    ($otherCount other environment variable setting(s) in this file, not PATH)"
  }
}

function Get-GpoRootFromFileSysPath {
  param([string]$FileSysPath)
  $path = $FileSysPath.TrimEnd('\')
  if ($path -match '(?i)\\(Machine|User)$') {
    return $path.Substring(0, $path.Length - $Matches[1].Length - 1)
  }
  return $path
}

function Get-GpoRegistryEntries {
  $entries = New-Object System.Collections.Generic.List[object]
  if (-not $Script:OnWindows) { return $entries }

  $base = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy'
  $lists = @(@{ Scope = 'Computer'; Hive = 'HKLM'; Key = "$base\State\Machine\GPO-List"; Source = 'State'; Nested = $false })
  if ($Script:Ctx.UserSid) {
    $lists += @{ Scope = 'User'; Hive = 'HKLM'; Key = "$base\State\$($Script:Ctx.UserSid)\GPO-List"; Source = 'State'; Nested = $false }
  }
  $lists += @{ Scope = 'Computer'; Hive = 'HKLM'; Key = "$base\History"; Source = 'History'; Nested = $true }
  $lists += @{ Scope = 'User'; Hive = 'HKCU'; Key = "$base\History"; Source = 'History'; Nested = $true }

  foreach ($list in $lists) {
    $root = Open-RegistryKey $list.Hive $list.Key
    if ($null -eq $root) { continue }
    try {
      $keys = New-Object System.Collections.Generic.List[object]
      foreach ($name in (Get-RegistrySubKeyNames $root)) {
        $child = $null
        try { $child = $root.OpenSubKey($name, $false) } catch { }
        if ($null -eq $child) { continue }
        if ($list.Nested) {
          foreach ($inner in (Get-RegistrySubKeyNames $child)) {
            try { $k = $child.OpenSubKey($inner, $false); if ($k) { $keys.Add($k) } } catch { }
          }
        } else {
          $keys.Add($child)
        }
      }
      foreach ($k in $keys) {
        $fileSysPath = [string](Get-RegistryValueSafe $k 'FileSysPath')
        if (-not $fileSysPath) { continue }
        $displayName = [string](Get-RegistryValueSafe $k 'DisplayName')
        $gpoName = [string](Get-RegistryValueSafe $k 'GPOName')
        $entries.Add([PSCustomObject]@{
          Scope       = $list.Scope
          Name        = $(if ($displayName) { $displayName } else { $gpoName })
          Guid        = $gpoName
          FileSysPath = $fileSysPath
          Source      = $list.Source
        })
      }
    } finally {
      try { $root.Close() } catch { }
    }
  }
  return $entries
}

function Get-AppliedGpoList {
  $unique = @{}
  foreach ($gpo in @(Get-GpoRegistryEntries)) {
    $root = Get-GpoRootFromFileSysPath $gpo.FileSysPath
    $key = $root.ToLowerInvariant()
    if (-not $unique.ContainsKey($key)) {
      $unique[$key] = [PSCustomObject]@{ Name = $gpo.Name; Guid = $gpo.Guid; Root = $root; Scopes = @($gpo.Scope); Sources = @($gpo.Source) }
    } else {
      $entry = $unique[$key]
      if ($entry.Scopes -notcontains $gpo.Scope) { $entry.Scopes += $gpo.Scope }
      if ($entry.Sources -notcontains $gpo.Source) { $entry.Sources += $gpo.Source }
    }
  }
  return @($unique.Values | Sort-Object Name)
}

function Read-GppFile {
  param([string]$XmlPath, [string]$Label)
  try {
    $settings = @()
    if ([System.IO.Path]::GetFileName($XmlPath) -ieq 'Environment.xml') {
      $settings = @(Read-GppEnvironmentXml $XmlPath)
    } else {
      $settings = @(Read-GppRegistryXml $XmlPath)
    }
    if ($settings.Count -gt 0) {
      Write-Host "  $Label :: $XmlPath"
      Write-GppSettings -Settings $settings -Source $Label
    }
  } catch {
    Add-Check 'GPO' 'Parse GPP file' 'WARN' "$XmlPath : $($_.Exception.Message)"
  }
}

function Read-GpoFolder {
  param([string]$Root, [string]$Label, [string[]]$Scopes = @('Machine', 'User'))
  $foundAny = $false
  foreach ($scope in $Scopes) {
    foreach ($rel in @("$scope\Preferences\Environment\Environment.xml", "$scope\Preferences\Registry\Registry.xml")) {
      $xmlPath = Join-Path $Root $rel
      if (-not (Test-Path -LiteralPath $xmlPath -ErrorAction SilentlyContinue)) { continue }
      $foundAny = $true
      Read-GppFile -XmlPath $xmlPath -Label "$Label ($scope)"
    }
  }
  return $foundAny
}

function Read-GpoCacheFolder {
  param([string]$Root, [string]$Label)
  $allowed = @('machine', 'user')
  if ($Script:Ctx.UserSid) { $allowed += $Script:Ctx.UserSid.ToLowerInvariant() }
  $rootFull = (Get-Item -LiteralPath $Root -ErrorAction SilentlyContinue).FullName
  if (-not $rootFull) { return $false }
  $files = @()
  foreach ($name in @('Environment.xml', 'Registry.xml')) {
    $files += @(Get-ChildItem -LiteralPath $Root -Recurse -Depth 4 -File -Filter $name -ErrorAction SilentlyContinue | Where-Object {
        $relative = $_.FullName.Substring($rootFull.Length).TrimStart('\', '/')
        $first = ($relative -split '[\\/]')[0].ToLowerInvariant()
        $allowed -contains $first
      })
  }
  foreach ($file in $files) {
    Read-GppFile -XmlPath $file.FullName -Label $Label
  }
  return ($files.Count -gt 0)
}

function Resolve-RsopGpoName {
  param($Node, [hashtable]$GpoNames)
  $gpo = $Node.SelectSingleNode("*[local-name()='GPO']")
  if (-not $gpo) { return '' }
  $id = $gpo.SelectSingleNode("*[local-name()='Identifier']")
  if ($id) {
    $key = $id.InnerText.Trim().ToLowerInvariant()
    if ($GpoNames.ContainsKey($key)) { return $GpoNames[$key] }
    return $id.InnerText.Trim()
  }
  $name = $gpo.SelectSingleNode("*[local-name()='Name']")
  if ($name) { return $name.InnerText }
  return ''
}

function Invoke-GpResult {
  param([ValidateSet('user', 'computer')][string]$Scope)

  $xmlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("codemie-gpresult-{0}-{1}.xml" -f $Scope, [guid]::NewGuid().ToString('N'))
  $res = Invoke-External 'gpresult.exe' @('/scope', $Scope, '/x', $xmlPath, '/f') 180 -Oem
  try {
    if ($res.TimedOut) {
      Add-Check 'GPO' "gpresult ($Scope)" 'WARN' 'timed out'
      return
    }
    if (-not (Test-Path -LiteralPath $xmlPath)) {
      Add-Check 'GPO' "gpresult ($Scope)" 'WARN' "no RSoP data: $(Get-FirstLine ($res.StdErr + $res.StdOut + $res.Error))"
      return
    }

    [xml]$doc = Get-Content -LiteralPath $xmlPath -Raw
    $resultNodeName = if ($Scope -eq 'computer') { 'ComputerResults' } else { 'UserResults' }
    $resultNode = $doc.SelectSingleNode("//*[local-name()='$resultNodeName']")
    if (-not $resultNode) {
      Add-Check 'GPO' "gpresult ($Scope)" 'WARN' 'no results section in RSoP XML'
      return
    }

    $gpos = @($resultNode.SelectNodes("*[local-name()='GPO']") | ForEach-Object {
        $name = $_.SelectSingleNode("*[local-name()='Name']").InnerText
        $filterAllowed = $_.SelectSingleNode("*[local-name()='FilterAllowed']")
        $accessDenied = $_.SelectSingleNode("*[local-name()='AccessDenied']")
        $applied = (-not $filterAllowed -or $filterAllowed.InnerText -eq 'true') -and (-not $accessDenied -or $accessDenied.InnerText -ne 'true')
        [PSCustomObject]@{ Name = $name; Applied = $applied }
      })
    $gpoNames = @{}
    foreach ($gpoNode in $resultNode.SelectNodes("*[local-name()='GPO']")) {
      $id = $gpoNode.SelectSingleNode("*[local-name()='Path']/*[local-name()='Identifier']")
      $nameNode = $gpoNode.SelectSingleNode("*[local-name()='Name']")
      if ($id -and $nameNode) { $gpoNames[$id.InnerText.Trim().ToLowerInvariant()] = $nameNode.InnerText }
    }
    $appliedNames = @($gpos | Where-Object { $_.Applied } | ForEach-Object { $_.Name })
    $deniedNames = @($gpos | Where-Object { -not $_.Applied } | ForEach-Object { $_.Name })
    Add-Check 'GPO' "gpresult ($Scope)" 'OK' "$($appliedNames.Count) applied GPO(s), $($deniedNames.Count) filtered/denied"
    $appliedNames | ForEach-Object { Write-Host "    + $_" }
    $deniedNames | ForEach-Object { Write-Host "    - $_ (filtered/denied)" }

    $settings = New-Object System.Collections.Generic.List[object]
    foreach ($props in $resultNode.SelectNodes(".//*[local-name()='Properties']")) {
      $parent = $props.ParentNode
      $parentName = $parent.LocalName
      $gpoName = Resolve-RsopGpoName $parent $gpoNames
      if ($parentName -in @('EnvironmentVariable', 'EnvironmentVar')) {
        $settings.Add([PSCustomObject]@{
          Kind = 'Environment'; Name = $props.GetAttribute('name'); Action = ConvertTo-GppAction $props.GetAttribute('action')
          Value = $props.GetAttribute('value'); Target = $(if ($props.GetAttribute('user') -eq '1') { 'User variable' } else { 'System variable' }) + $(if ($gpoName) { " (GPO: $gpoName)" } else { '' })
          Partial = $props.GetAttribute('partial') -eq '1'; Disabled = $false; Filtered = $false
        })
      } elseif ($parentName -eq 'Registry' -and (Test-EnvRegistryKey $props.GetAttribute('hive') $props.GetAttribute('key'))) {
        $settings.Add([PSCustomObject]@{
          Kind = 'Registry'; Name = $props.GetAttribute('name'); Action = ConvertTo-GppAction $props.GetAttribute('action')
          Value = $props.GetAttribute('value'); Target = "$($props.GetAttribute('hive'))\$($props.GetAttribute('key'))$(if ($gpoName) { " (GPO: $gpoName)" })"
          Partial = $false; Disabled = $false; Filtered = $false
        })
      }
    }
    foreach ($reg in $resultNode.SelectNodes(".//*[local-name()='RegistrySetting']")) {
      $keyPath = $reg.SelectSingleNode("*[local-name()='KeyPath']")
      if ($keyPath -and (Test-EnvRegistryKey $(if ($Scope -eq 'user') { 'HKCU' } else { 'HKLM' }) $keyPath.InnerText)) {
        $valueNode = $reg.SelectSingleNode("*[local-name()='Value']")
        $valueName = ''
        $valueData = ''
        if ($valueNode) {
          $nameNode = $valueNode.SelectSingleNode("*[local-name()='Name']")
          if ($nameNode) { $valueName = $nameNode.InnerText }
          $valueData = (@($valueNode.ChildNodes | Where-Object { $_.LocalName -ne 'Name' } | ForEach-Object { $_.InnerText }) -join ';')
        }
        $gpoName = Resolve-RsopGpoName $reg $gpoNames
        $settings.Add([PSCustomObject]@{
          Kind = 'Registry'; Name = $valueName; Action = 'Policy (Registry.pol)'
          Value = $valueData; Target = "$($keyPath.InnerText)$(if ($gpoName) { " (GPO: $gpoName)" })"
          Partial = $false; Disabled = $false; Filtered = $false
        })
      }
    }

    if ($settings.Count -gt 0) {
      Write-GppSettings -Settings $settings -Source "RSoP ($Scope)"
    } else {
      Add-Check 'GPO' "RSoP PATH settings ($Scope)" 'INFO' 'no applied PATH-related settings'
    }
  } catch {
    Add-Check 'GPO' "gpresult ($Scope)" 'WARN' "failed to parse: $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-GpoPathCheck {
  Write-SectionHeader '4. Group Policy Settings for PATH'

  if (-not $Script:OnWindows) {
    Add-Check 'GPO' 'Group Policy' 'INFO' 'not applicable on this platform'
    return
  }

  if ($Script:Ctx.EntraJoined -and -not $Script:Ctx.PartOfDomain) {
    $mdm = if ($Script:Ctx.MdmEnrolled) { 'enrolled in MDM (Intune)' } else { 'not MDM-enrolled' }
    Add-Check 'GPO' 'Policy source' 'INFO' "Entra ID joined device, $mdm, no AD domain: there are no domain GPOs or SYSVOL. Only Local Group Policy applies; Intune cannot set PATH through a policy, so any PATH change from Intune comes from scripts/remediations and is not visible here"
  }

  Write-SubHeader '4.1 Applied values (RSoP via gpresult)'
  Invoke-Section 'gpresult (user)' { Invoke-GpResult -Scope 'user' }
  if ($Script:Ctx.IsAdmin) {
    Invoke-Section 'gpresult (computer)' { Invoke-GpResult -Scope 'computer' }
  } else {
    Add-Check 'GPO' 'gpresult (computer)' 'INFO' 'requires elevation; computer-scope PATH is still read from the local cache and SYSVOL below'
  }

  $applied = @()
  $script:AppliedGpos = @()
  Invoke-Section 'Applied GPO list' { $script:AppliedGpos = @(Get-AppliedGpoList) }
  if ($script:AppliedGpos) { $applied = @($script:AppliedGpos) }
  Write-SubHeader '4.2 Applied GPO list (registry State + History)'
  if ($applied.Count -eq 0) {
    Add-Check 'GPO' 'Applied GPO list' 'INFO' 'no applied GPOs recorded'
  } else {
    Add-Check 'GPO' 'Applied GPO list' 'OK' "$($applied.Count) GPO(s)"
    foreach ($gpo in $applied) {
      Write-Host "    - $($gpo.Name) [$($gpo.Scopes -join '/')] $($gpo.Root)"
    }
  }

  Write-SubHeader '4.3 Local Group Policy Preferences cache'
  $guidToName = @{}
  foreach ($gpo in $applied) { if ($gpo.Guid) { $guidToName[$gpo.Guid.ToLowerInvariant()] = $gpo.Name } }
  $cacheRoots = @(
    (Join-PathSafe $env:ProgramData 'Microsoft\Group Policy\History'),
    (Join-PathSafe $env:LOCALAPPDATA 'Microsoft\Group Policy\History')
  )
  $cacheFound = $false
  foreach ($cacheRoot in $cacheRoots) {
    if (-not $cacheRoot -or -not (Test-Path -LiteralPath $cacheRoot -ErrorAction SilentlyContinue)) { continue }
    Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $name = if ($guidToName.ContainsKey($_.Name.ToLowerInvariant())) { $guidToName[$_.Name.ToLowerInvariant()] } else { $_.Name }
      if (Read-GpoCacheFolder -Root $_.FullName -Label "cache: $name") { $cacheFound = $true }
    }
  }
  if (-not $cacheFound) {
    Add-Check 'GPO' 'Local GPP cache' 'INFO' 'no cached Environment/Registry preference files'
  }

  Write-SubHeader '4.4 SYSVOL (applied GPOs)'
  if (-not $Script:Ctx.PartOfDomain) {
    Add-Check 'GPO' 'SYSVOL' 'INFO' 'machine is not domain-joined; SYSVOL not applicable'
    return
  }

  $domain = if ($env:USERDNSDOMAIN) { $env:USERDNSDOMAIN } else { $Script:Ctx.Domain }
  $sysvolRoot = "\\$domain\SYSVOL\$domain\Policies"
  if (Test-Path -LiteralPath $sysvolRoot -ErrorAction SilentlyContinue) {
    Add-Check 'GPO' 'SYSVOL reachable' 'OK' $sysvolRoot
  } else {
    Add-Check 'GPO' 'SYSVOL reachable' 'WARN' "$sysvolRoot is not reachable (VPN/network/DC unavailable); SYSVOL results below may be empty"
  }

  $sysvolFound = $false
  foreach ($gpo in $applied) {
    if ($gpo.Root -notlike '\\*') { continue }
    if (-not (Test-Path -LiteralPath $gpo.Root -ErrorAction SilentlyContinue)) {
      Add-Check 'GPO' "SYSVOL: $($gpo.Name)" 'WARN' "not reachable: $($gpo.Root)"
      continue
    }
    $gpoScopes = @($gpo.Scopes | ForEach-Object { if ($_ -eq 'Computer') { 'Machine' } else { 'User' } })
    if (Read-GpoFolder -Root $gpo.Root -Label "SYSVOL: $($gpo.Name)" -Scopes $gpoScopes) { $sysvolFound = $true }
  }
  if (-not $sysvolFound) {
    Add-Check 'GPO' 'SYSVOL preference files' 'INFO' 'no Environment/Registry preference files in reachable applied GPOs'
  }

  if (-not $ScanAllSysvolGpos) { return }

  Write-SubHeader '4.5 SYSVOL (all GPOs in the domain, -ScanAllSysvolGpos)'
  if (-not (Test-Path -LiteralPath $sysvolRoot -ErrorAction SilentlyContinue)) { return }
  $appliedRoots = @($applied | ForEach-Object { $_.Root.ToLowerInvariant() })
  $scanned = 0
  Get-ChildItem -LiteralPath $sysvolRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\{[0-9A-Fa-f-]+\}$' } | ForEach-Object {
    $scanned++
    $isApplied = $appliedRoots -contains $_.FullName.ToLowerInvariant()
    Read-GpoFolder -Root $_.FullName -Label "SYSVOL $($_.Name)$(if ($isApplied) { ' (applied)' } else { ' (NOT applied to this user/computer)' })" | Out-Null
  }
  Add-Check 'GPO' 'SYSVOL full scan' 'INFO' "$scanned GPO folder(s) scanned"
}

# ============================================================================
# Main
# ============================================================================

if ($ReportPath) {
  try {
    Start-Transcript -Path $ReportPath -Force | Out-Null
  } catch {
    Write-Host "WARNING: could not start transcript at $ReportPath : $($_.Exception.Message)" -ForegroundColor Yellow
    $ReportPath = ''
  }
}

try {
  Write-Host 'CodeMie CLI Windows Diagnostics' -ForegroundColor White
  $scriptHash = 'n/a (not run from a file)'
  if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
    try { $scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.Substring(0, 16) } catch { }
  }
  Write-Host "Script: clidiag.ps1 version $ScriptVersion, SHA256 $scriptHash, file $(if ($PSCommandPath) { $PSCommandPath } else { 'n/a' })"
  Write-Host "Run at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')  Computer: $env:COMPUTERNAME  Working dir: $((Get-Location).Path)"

  Invoke-Section 'Node/npm resolution' { Resolve-NodeAndNpm }
  Invoke-Section '1. System Requirements' { Invoke-SystemRequirementsCheck }
  Invoke-Section '2. Current User Rights' { Invoke-UserRightsCheck }
  Invoke-Section '3. Installation State' { Invoke-InstallationStateCheck }

  if ($RunGpoCheck) {
    Invoke-Section '4. Group Policy' { Invoke-GpoPathCheck }
  } else {
    Write-SectionHeader '4. Group Policy Settings for PATH'
    Add-Check 'GPO' 'GPO check' 'INFO' 'skipped by default (use -RunGpoCheck to run it)'
  }

  Write-SectionHeader 'Summary'
  foreach ($status in @('OK', 'WARN', 'FAIL')) {
    Write-Host ('  {0,-6} {1}' -f "${status}:", @($Script:Results | Where-Object { $_.Status -eq $status }).Count)
  }
  foreach ($status in @('FAIL', 'WARN')) {
    $items = @($Script:Results | Where-Object { $_.Status -eq $status })
    if ($items.Count -eq 0) { continue }
    $color = if ($status -eq 'FAIL') { 'Red' } else { 'Yellow' }
    Write-Host ''
    Write-Host "$status checks:" -ForegroundColor $color
    $items | ForEach-Object { Write-Host "  - [$($_.Category)] $($_.Check): $($_.Detail)" -ForegroundColor $color }
  }
} finally {
  if ($ReportPath) {
    try { Stop-Transcript | Out-Null } catch { }
    Write-Host ''
    Write-Host "Full report saved to: $ReportPath" -ForegroundColor White
  }
}
