#requires -Version 5.1
<#
    Create or promote the first Super Admin without needing PHP on PATH.

    The password is typed at a hidden prompt and hashed by the application.
    It is never printed, logged or written by this script.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$backend = Join-Path $projectRoot 'backend'
$artisan = Join-Path $backend 'artisan'

function Stop-Helper {
    param([string]$Message)

    Write-Host ''
    Write-Host "  [error] $Message" -ForegroundColor Red
    Write-Host ''
    Read-Host 'Press Enter to close this window' | Out-Null
    exit 1
}

if (-not (Test-Path -LiteralPath $artisan)) {
    Stop-Helper 'The backend folder is missing next to this script.'
}

$php = $null
$phpCommand = Get-Command php.exe -ErrorAction SilentlyContinue

if ($phpCommand) {
    $php = $phpCommand.Source
}

$phpCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Application\tools\php\php.exe'),
    (Join-Path $projectRoot 'tools\php\php.exe'),
    (Join-Path $env:ProgramFiles 'php\php.exe'),
    'C:\php\php.exe'
)

if (-not $php) {
    foreach ($candidate in $phpCandidates) {
        if (Test-Path -LiteralPath $candidate) {
            $php = $candidate
            break
        }
    }
}

if (-not $php) {
    Stop-Helper ('PHP was not found. Expected at: ' + $phpCandidates[0])
}

Write-Host ''
Write-Host '  ==========================================' -ForegroundColor DarkCyan
Write-Host '   Application - create a Super Admin' -ForegroundColor Cyan
Write-Host '  ==========================================' -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  The password is typed hidden and stored only as a hash.' -ForegroundColor DarkGray
Write-Host ''

Push-Location -LiteralPath $backend

try {
    & $php $artisan app:create-super-admin
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    Write-Host ''
    Read-Host 'The account was not created. Press Enter to close' | Out-Null
    exit 1
}

Write-Host ''
Read-Host 'Press Enter to close this window' | Out-Null
