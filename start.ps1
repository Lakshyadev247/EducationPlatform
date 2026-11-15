#requires -Version 5.1
<#
    One-click local start for Education Platform.

    Double-click Start-App.bat, or run:
        powershell -ExecutionPolicy Bypass -File start.ps1

    On a PC without PHP, Composer or MySQL this script downloads portable copies
    (about 350 MB) into %LOCALAPPDATA%\AppRuntime, creates the database and
    backend\.env, installs the PHP dependencies, prepares the schema and serves
    the application. Later runs reuse everything and only apply new migrations.

    The download and database code lives in bootstrap.ps1, which is
    kept next to this file.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$SkipDatabaseUpdate,
    [switch]$SetupOnly,
    [switch]$PauseOnError
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = $PSScriptRoot
$backend = Join-Path $projectRoot 'backend'
$envPath = Join-Path $backend '.env'
$artisan = Join-Path $backend 'artisan'

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "  $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [ok]   $Text" -ForegroundColor Green
}

function Write-Note {
    param([string]$Text)
    Write-Host "         $Text" -ForegroundColor DarkGray
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [warn] $Text" -ForegroundColor Yellow
}

function Stop-Script {
    param([string]$Message, [string[]]$Hints = @())

    Write-Host ''
    Write-Host "  [error] $Message" -ForegroundColor Red
    foreach ($hint in $Hints) {
        Write-Host "          $hint" -ForegroundColor Yellow
    }
    Write-Host ''

    if ($PauseOnError -and $Host.Name -eq 'ConsoleHost') {
        Read-Host 'Press Enter to close this window' | Out-Null
    }

    exit 1
}

function Get-EnvValue {
    param([string]$Path, [string]$Key, [string]$Default = '')

    if (-not (Test-Path -LiteralPath $Path)) {
        return $Default
    }

    $line = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ('^\s*' + [regex]::Escape($Key) + '\s*=') } |
        Select-Object -Last 1

    if (-not $line) {
        return $Default
    }

    $value = ($line -split '=', 2)[1].Trim()

    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    return $value
}

function Format-EnvValue {
    param([string]$Value)

    if ($Value -eq '') {
        return ''
    }

    if ($Value -match '^[A-Za-z0-9_\.\-/]*$') {
        return $Value
    }

    return '"' + ($Value -replace '\\', '\\\\' -replace '"', '\"') + '"'
}

function Set-EnvValues {
    param([string]$Path, [hashtable]$Values)

    $lines = @(Get-Content -LiteralPath $Path)
    $written = @{}
    $result = New-Object 'System.Collections.Generic.List[string]'

    foreach ($line in $lines) {
        $replaced = $false

        foreach ($key in $Values.Keys) {
            if ($line -match ('^\s*' + [regex]::Escape($key) + '\s*=')) {
                $result.Add($key + '=' + $Values[$key])
                $written[$key] = $true
                $replaced = $true
                break
            }
        }

        if (-not $replaced) {
            $result.Add($line)
        }
    }

    foreach ($key in $Values.Keys) {
        if (-not $written.ContainsKey($key)) {
            $result.Add($key + '=' + $Values[$key])
        }
    }

    [System.IO.File]::WriteAllLines($Path, $result, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-PlainPassword {
    param([string]$Prompt)

    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Test-TcpPort {
    param([string]$HostName = '127.0.0.1', [int]$PortNumber, [int]$TimeoutMs = 800)

    $client = New-Object System.Net.Sockets.TcpClient

    try {
        $task = $client.ConnectAsync($HostName, $PortNumber)

        if (-not $task.Wait($TimeoutMs)) {
            return $false
        }

        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-ListenerProcess {
    param([int]$PortNumber)

    try {
        $connection = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1

        if (-not $connection) {
            return $null
        }

        return Get-CimInstance Win32_Process -Filter ("ProcessId=" + $connection.OwningProcess) -ErrorAction SilentlyContinue
    } catch {
        return $null
    }
}

function Test-OurServer {
    param([int]$PortNumber)

    $listener = Get-ListenerProcess -PortNumber $PortNumber

    if (-not $listener) {
        return $false
    }

    $commandLine = [string]$listener.CommandLine
    $parentCommandLine = ''

    try {
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.ParentProcessId) -ErrorAction SilentlyContinue
        $parentCommandLine = [string]$parent.CommandLine
    } catch {
        $parentCommandLine = ''
    }

    $combined = $commandLine + ' ' + $parentCommandLine
    $isThisProject = $combined -match [regex]::Escape($backend)
    $isPhpServer = $combined -match 'artisan\s+serve' -or $combined -match 'server\.php'
    $usesAlternateEnv = $combined -match '--env(=|\s)'

    return ($isThisProject -and $isPhpServer -and -not $usesAlternateEnv)
}

function Invoke-Artisan {
    param([string[]]$Arguments)

    Push-Location -LiteralPath $backend

    try {
        return Invoke-StreamedNative -FilePath $php -Arguments (@($artisan) + $Arguments)
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Banner and project checks
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  ==========================================' -ForegroundColor DarkCyan
Write-Host '   Education Platform - local start' -ForegroundColor Cyan
Write-Host '  ==========================================' -ForegroundColor DarkCyan

if (-not (Test-Path -LiteralPath $artisan)) {
    Stop-Script 'The backend folder is missing next to this script.' @(
        'Keep the scripts folder and the backend folder together.',
        'Expected: ' + $artisan
    )
}

$bootstrapScript = Join-Path $projectRoot 'bootstrap.ps1'

if (-not (Test-Path -LiteralPath $bootstrapScript)) {
    Stop-Script 'bootstrap.ps1 is missing next to this script.' @(
        'Extract the complete Education Platform folder again.',
        'Expected: ' + $bootstrapScript
    )
}

Write-Ok 'Project files found.'

$preferredPort = if ($Port -gt 0) { $Port } else { 8000 }

if ((Test-TcpPort -HostName '127.0.0.1' -PortNumber $preferredPort) -and (Test-OurServer -PortNumber $preferredPort)) {
    $url = 'http://127.0.0.1:' + $preferredPort + '/'
    Write-Section 'Education Platform is already running'
    Write-Host ('  ' + $url) -ForegroundColor Green
    Write-Note 'Close the existing server window (or press Ctrl+C in it) to stop it.'

    if (-not $NoBrowser) {
        Start-Process $url
    }

    exit 0
}

# The bootstrap defines the download, MySQL and environment helpers used below.
. $bootstrapScript

# ---------------------------------------------------------------------------
# PHP, Composer, MySQL and backend\.env
# ---------------------------------------------------------------------------

Write-Section 'Checking this PC'

$runtime = Initialize-AppRuntime -ProjectRoot $projectRoot -Backend $backend
$php = $runtime.Php
$phpVersion = $runtime.PhpVersion

# Composer and the $HOME/.composer helpers need PHP on PATH for this process.
$env:Path = (Split-Path -Parent $php) + ';' + $env:Path

# ---------------------------------------------------------------------------
# Composer dependencies
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath (Join-Path $backend 'vendor\autoload.php'))) {
    Write-Section 'Installing PHP dependencies (first run)'
    Write-Note 'This downloads the libraries the application uses; it can take a few minutes.'

    $env:COMPOSER_HOME = Join-Path $runtime.Home 'composer'

    if (-not (Test-Path -LiteralPath $env:COMPOSER_HOME)) {
        New-Item -ItemType Directory -Path $env:COMPOSER_HOME -Force | Out-Null
    }

    $composerVerb = if (Test-Path -LiteralPath (Join-Path $backend 'composer.lock')) { 'install' } else { 'update' }

    Push-Location -LiteralPath $backend

    try {
        $composerExit = Invoke-StreamedNative -FilePath $php -Arguments (@(
            $runtime.ComposerPhar,
            $composerVerb,
            '--no-dev',
            '--no-interaction',
            '--prefer-dist',
            '--no-progress',
            '--no-ansi'
        ))
    } finally {
        Pop-Location
    }

    if ($composerExit -ne 0) {
        Stop-Script 'Composer could not install the backend dependencies.' @(
            'Check the internet connection and run this file again.',
            'The full error is printed above.'
        )
    }

    Write-Ok 'PHP dependencies installed.'
} else {
    Write-Ok 'PHP dependencies found.'
}

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $envPath)) {
    Stop-Script 'backend\.env was not created.' @(
        'The first-time setup did not finish. Run Start-App.bat again.',
        'If the problem continues, delete this folder and retry:',
        $runtime.Home
    )
}

$databasePassword = Get-EnvValue -Path $envPath -Key 'DB_PASSWORD'

if ($databasePassword -eq 'replace-with-a-local-database-password') {
    Write-Warn 'backend\.env still contains the example database password.'

    if ($runtime.FirstRun) {
        Stop-Script 'The generated database password was not written to backend\.env.' @(
            'Delete backend\.env and run Start-App.bat again.'
        )
    }

    $databaseUser = Get-EnvValue -Path $envPath -Key 'DB_USERNAME' -Default 'app'
    $databasePassword = Read-PlainPassword ("  Database password for '" + $databaseUser + "' (press Enter for none)")
    Set-EnvValues -Path $envPath -Values @{ DB_PASSWORD = (Format-EnvValue $databasePassword) }
    Write-Ok 'Database password updated in backend\.env.'
}

if ([string]::IsNullOrWhiteSpace((Get-EnvValue -Path $envPath -Key 'APP_KEY'))) {
    $keyExit = Invoke-Artisan -Arguments @('key:generate', '--force', '--no-ansi')

    if ($keyExit -ne 0) {
        Stop-Script 'The application key could not be generated.' @(
            'Make sure backend\.env is writable, then run this file again.'
        )
    }

    Write-Ok 'Application key generated.'
} else {
    Write-Ok 'Application key found.'
}

# ---------------------------------------------------------------------------
# Database schema, reference data and storage link
# ---------------------------------------------------------------------------

# Cached configuration and routes can point at old paths after an upgrade.
# These files are removed directly: on a first run the database cache table
# does not exist yet, so "optimize:clear" would fail before the migrations.
foreach ($cacheDirectory in @(
    (Join-Path $backend 'bootstrap\cache'),
    (Join-Path $backend 'storage\framework\views')
)) {
    Get-ChildItem -LiteralPath $cacheDirectory -Filter '*.php' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

if (-not $SkipDatabaseUpdate) {
    Write-Section 'Preparing the database'

    $installExit = Invoke-Artisan -Arguments @('app:install', '--no-ansi')

    if ($installExit -ne 0) {
        Stop-Script 'The database could not be prepared.' @(
            'The exact error is printed above.',
            'Check DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME and DB_PASSWORD in backend\.env.',
            'The database user needs permission to create tables in that schema.'
        )
    }

    Write-Ok 'Database ready.'

    $null = Invoke-Artisan -Arguments @('optimize:clear', '--no-ansi')
    Write-Ok 'Caches cleared.'

    if (-not $NoBrowser -and -not $SetupOnly) {
        $userCount = (Invoke-CapturedNative -FilePath $php -Arguments @(
            $artisan,
            'tinker',
            '--execute',
            'echo \App\Models\User::count();'
        )).Output.Trim()

        if ($userCount -eq '0') {
            Write-Section 'No accounts exist yet'
            Write-Note 'The handover database is intentionally empty.'
            $answer = Read-Host '  Create the owner (Super Admin) account now? [Y/n]'

            if ($answer -notmatch '^(n|no)$') {
                $adminExit = Invoke-Artisan -Arguments @('app:create-super-admin')

                if ($adminExit -ne 0) {
                    Write-Warn 'The account was not created. Run Create-Super-Admin.bat later.'
                }
            } else {
                Write-Note 'Create it later with Create-Super-Admin.bat.'
            }
        }
    }
} else {
    Write-Warn 'Database update skipped (-SkipDatabaseUpdate).'
}

if ($SetupOnly) {
    Write-Section 'Setup complete'
    Write-Ok 'Education Platform is ready to run.'
    Write-Note 'Start it with Start-App.bat.'
    exit 0
}

# ---------------------------------------------------------------------------
# Choose a local address
# ---------------------------------------------------------------------------

$chosenPort = $null

for ($candidate = $preferredPort; $candidate -lt ($preferredPort + 20); $candidate++) {
    if (-not (Test-TcpPort -HostName '127.0.0.1' -PortNumber $candidate)) {
        $chosenPort = $candidate
        break
    }
}

if (-not $chosenPort) {
    Stop-Script ('No free local port between ' + $preferredPort + ' and ' + ($preferredPort + 19) + '.') @(
        'Close the program using those ports, then run this file again.',
        'Or start with a specific port: start.ps1 -Port 9000'
    )
}

if ($chosenPort -ne $preferredPort) {
    Write-Warn ('Port ' + $preferredPort + ' is already used by another program; using ' + $chosenPort + ' instead.')
}

# Process-level overrides keep login and cookies working when the port is not
# 8000. No project file is changed for this.
$env:APP_URL = 'http://127.0.0.1:' + $chosenPort
$env:SANCTUM_STATEFUL_DOMAINS = 'localhost,localhost:' + $chosenPort + ',127.0.0.1,127.0.0.1:' + $chosenPort + ',::1'

$url = 'http://127.0.0.1:' + $chosenPort + '/'

# ---------------------------------------------------------------------------
# Serve
# ---------------------------------------------------------------------------

Write-Section 'Starting Education Platform'
Write-Host ('  Open: ' + $url) -ForegroundColor Green
Write-Host '  Keep this window open while you use the application.' -ForegroundColor Yellow
Write-Host '  Press Ctrl+C to stop the server.' -ForegroundColor Yellow
Write-Host ''

$browserJob = $null

if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
        param([string]$HealthUrl, [string]$TargetUrl)

        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2

                if ($response.StatusCode -eq 200) {
                    Start-Process $TargetUrl
                    return
                }
            } catch {
                # The server is still starting.
            }

            Start-Sleep -Milliseconds 250
        }
    } -ArgumentList ('http://127.0.0.1:' + $chosenPort + '/api/v1/health'), $url
}

Push-Location -LiteralPath $backend

try {
    # --no-reload passes the APP_URL and SANCTUM_STATEFUL_DOMAINS overrides
    # above to the php -S child. Without it Laravel strips them and login only
    # works on the default port.
    & $php $artisan serve --host=127.0.0.1 --port=$chosenPort --no-reload
} finally {
    Pop-Location

    if ($browserJob) {
        Stop-Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '  Education Platform server stopped.' -ForegroundColor DarkGray
