# play-random-sound.ps1
# Plays a random WAV or MP3 file from the specified directory (Windows)
# Usage: .\play-random-sound.ps1 <directory>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Directory
)

# Set error action preference to stop on errors
$ErrorActionPreference = "Stop"

# Expand environment variables in the path (e.g., %USERPROFILE%)
$SoundDir = [System.Environment]::ExpandEnvironmentVariables($Directory)

# Check if directory exists
if (-not (Test-Path -Path $SoundDir -PathType Container)) {
    Write-Error "Error: Directory not found: $SoundDir"
    exit 1
}

# Find all audio files (WAV and MP3)
$AudioFiles = Get-ChildItem -Path $SoundDir -File -Include *.wav,*.mp3 -ErrorAction SilentlyContinue

# Check if any audio files were found
if ($AudioFiles.Count -eq 0) {
    Write-Error "Error: No WAV or MP3 files found in $SoundDir"
    exit 1
}

# Select a random file
$SelectedFile = $AudioFiles | Get-Random

# Function to play audio using mpg123 (if available)
function Play-WithMpg123 {
    param([string]$FilePath)

    try {
        $mpg123 = Get-Command mpg123 -ErrorAction Stop
        Start-Process -FilePath $mpg123.Source -ArgumentList "-q", "`"$FilePath`"" -NoNewWindow -Wait:$false
        return $true
    } catch {
        return $false
    }
}

# Function to play audio using Windows Media Player COM
function Play-WithWMP {
    param([string]$FilePath)

    try {
        $wmp = New-Object -ComObject WMPlayer.OCX
        $wmp.URL = $FilePath
        $wmp.controls.play()

        # Start playback in background (don't wait for completion)
        Start-Sleep -Milliseconds 500
        return $true
    } catch {
        return $false
    }
}

# Function to play audio using .NET SoundPlayer (WAV only)
function Play-WithSoundPlayer {
    param([string]$FilePath)

    # SoundPlayer only supports WAV files
    if ($FilePath -notmatch '\.wav$') {
        return $false
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $player = New-Object System.Media.SoundPlayer
        $player.SoundLocation = $FilePath
        $player.PlaySync() # Play asynchronously

        # Start in background job to avoid blocking
        Start-Job -ScriptBlock {
            param($path)
            Add-Type -AssemblyName System.Windows.Forms
            $p = New-Object System.Media.SoundPlayer
            $p.SoundLocation = $path
            $p.PlaySync()
        } -ArgumentList $FilePath | Out-Null

        return $true
    } catch {
        return $false
    }
}

# Try audio players in order of preference
$played = $false

# 1. Try mpg123 (best option, cross-platform)
if (Play-WithMpg123 -FilePath $SelectedFile.FullName) {
    $played = $true
}
# 2. Try Windows Media Player COM
elseif (Play-WithWMP -FilePath $SelectedFile.FullName) {
    $played = $true
}
# 3. Try .NET SoundPlayer (WAV only)
elseif (Play-WithSoundPlayer -FilePath $SelectedFile.FullName) {
    $played = $true
}

if (-not $played) {
    Write-Error "Error: No audio player found. Install mpg123 via Chocolatey: choco install mpg123"
    exit 1
}

exit 0
