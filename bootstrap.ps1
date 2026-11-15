#requires -Version 5.1
<#
    First-run bootstrap for Education Platform.

    This file is dot-sourced by start.ps1. It downloads and prepares
    the runtime the application needs on a PC that has no PHP, Composer or
    MySQL installed:

      * PHP 8.4 (NTS, x64) with the required extensions and a CA bundle
      * Composer
      * MySQL 8.4 (portable, local only) on a free port
      * a generated database, database user and backend\.env
      * the public storage link

    Everything is stored outside the repository in
    %LOCALAPPDATA%\AppRuntime (or APP_RUNTIME_HOME when set). Nothing in this
    file writes a secret into the project folder except backend\.env, which is
    ignored by git.

    The caller must define Write-Section, Write-Ok, Write-Note, Write-Warn,
    Stop-Script, Get-EnvValue, Format-EnvValue, Set-EnvValues and Test-TcpPort
    before calling Initialize-AppRuntime.
#>

$script:RequiredPhpModules = @(
    'pdo_mysql',
    'mbstring',
    'openssl',
    'fileinfo',
    'curl',
    'intl',
    'gd',
    'bcmath',
    'ctype',
    'tokenizer',
    'xml',
    'session'
)

function Get-AppRuntimeHome {
    $configured = [string]$env:APP_RUNTIME_HOME

    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        if ([IO.Path]::IsPathRooted($configured)) {
            return [IO.Path]::GetFullPath($configured)
        }

        return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $configured))
    }

    return (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EduPlatform')
}

function New-DirectoryIfMissing {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Assert-AppPlatform {
    if (-not [Environment]::Is64BitOperatingSystem) {
        Stop-Script 'Education Platform needs 64-bit Windows 10 or 11.' @(
            'The automatic installer uses the 64-bit PHP and MySQL builds.',
            'Install them manually on this PC, then set backend\.env yourself.'
        )
    }

    if ([Environment]::OSVersion.Version.Major -lt 10) {
        Stop-Script 'Education Platform needs Windows 10 or newer.' @(
            'This PC reports an older version of Windows.'
        )
    }
}

function Invoke-CapturedNative {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    try {
        $output = (& $FilePath @Arguments 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $output
    }
}

function Invoke-StreamedNative {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            if ($null -ne $_) {
                Write-Host ([string]$_)
            }
        }

        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Test-ZipArchive {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $archive = [IO.Compression.ZipFile]::OpenRead($Path)

        try {
            $null = $archive.Entries.Count
        } finally {
            $archive.Dispose()
        }

        return $true
    } catch {
        return $false
    }
}

function Invoke-FileDownload {
    param(
        [string]$Url,
        [string]$Destination,
        [string]$Label,
        [long]$MinimumBytes = 1024
    )

    if ((Test-Path -LiteralPath $Destination) -and ((Get-Item -LiteralPath $Destination).Length -ge $MinimumBytes)) {
        Write-Ok ($Label + ' already downloaded.')
        return
    }

    New-DirectoryIfMissing (Split-Path -Parent $Destination)

    $temporary = $Destination + '.part'
    $lastError = $null

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue

        try {
            Write-Note ('Downloading ' + $Label + ' (attempt ' + $attempt + ' of 3)...')

            # curl.exe ships with Windows 10/11 and copes with the redirects and
            # CDNs used by php.net, getcomposer.org and dev.mysql.com. The
            # PowerShell fallback is kept for stripped-down Windows installs.
            $curlCommand = Get-Command curl.exe -ErrorAction SilentlyContinue

            if ($curlCommand) {
                $download = Invoke-CapturedNative -FilePath $curlCommand.Source -Arguments @(
                    '-fsSL',
                    '--retry', '3',
                    '--retry-delay', '2',
                    '--connect-timeout', '30',
                    '-o', $temporary,
                    $Url
                )

                if ($download.ExitCode -ne 0) {
                    throw ('The download command failed: ' + $download.Output.Trim())
                }
            } else {
                $previousProgress = $ProgressPreference
                $ProgressPreference = 'SilentlyContinue'

                try {
                    Invoke-WebRequest -Uri $Url -OutFile $temporary -UseBasicParsing -TimeoutSec 1800 `
                        -Headers @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                } finally {
                    $ProgressPreference = $previousProgress
                }
            }

            if (-not (Test-Path -LiteralPath $temporary)) {
                throw 'The download did not produce a file.'
            }

            $length = (Get-Item -LiteralPath $temporary).Length

            if ($length -lt $MinimumBytes) {
                throw ('The downloaded file is too small (' + $length + ' bytes).')
            }

            if ($Destination -like '*.zip' -and -not (Test-ZipArchive -Path $temporary)) {
                throw 'The downloaded archive is damaged.'
            }

            Move-Item -LiteralPath $temporary -Destination $Destination -Force
            Write-Ok ($Label + ' downloaded (' + [math]::Round($length / 1MB, 1) + ' MB).')
            return
        } catch {
            $lastError = $_.Exception.Message
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }

    Stop-Script ('Could not download ' + $Label + '.') @(
        $lastError,
        'Check the internet connection, then run Start-App.bat again.',
        'If a proxy or antivirus blocks the download, download the file manually and place it in:',
        (Split-Path -Parent $Destination)
    )
}

function Expand-ZipToFolder {
    param(
        [string]$ZipPath,
        [string]$Destination,
        [string]$Label
    )

    if (-not (Test-ZipArchive -Path $ZipPath)) {
        Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
        Stop-Script ('The downloaded ' + $Label + ' archive is damaged.') @(
            'Run Start-App.bat again to download it once more.',
            'Archive: ' + $ZipPath
        )
    }

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-DirectoryIfMissing $Destination
    Write-Note ('Extracting ' + $Label + '...')

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
    } catch {
        Stop-Script ('The ' + $Label + ' archive could not be extracted.') @(
            $_.Exception.Message,
            'Check that there is enough free disk space and run this file again.'
        )
    }

    Write-Ok ($Label + ' extracted.')
}

function Get-CaBundle {
    param([string]$HomeDir)

    $bundle = Join-Path $HomeDir 'downloads\cacert.pem'
    Invoke-FileDownload -Url 'https://curl.se/ca/cacert.pem' -Destination $bundle `
        -Label 'certificate bundle' -MinimumBytes 50000

    return $bundle
}

function Write-BootstrapPhpIni {
    param(
        [string]$PhpDir,
        [string]$CaBundle
    )

    $extensionDir = (Join-Path $PhpDir 'ext') -replace '\\', '/'
    $caPath = $CaBundle -replace '\\', '/'
    $errorLog = (Join-Path $PhpDir 'php-error.log') -replace '\\', '/'
    $iniPath = Join-Path $PhpDir 'php.ini'

    $content = @"
[PHP]
engine = On
short_open_tag = Off
precision = 14
output_buffering = 4096
zlib.output_compression = Off
implicit_flush = Off
serialize_precision = -1
expose_php = Off
max_execution_time = 120
max_input_time = 120
memory_limit = 512M
error_reporting = E_ALL
display_errors = Off
display_startup_errors = Off
log_errors = On
error_log = "$errorLog"
post_max_size = 24M
upload_max_filesize = 20M
max_file_uploads = 20

[Date]
date.timezone = Asia/Kolkata

[Session]
session.save_handler = files
session.use_strict_mode = 1
session.use_cookies = 1
session.cookie_httponly = 1
session.cookie_samesite = Lax
session.gc_maxlifetime = 7200

[opcache]
opcache.enable = 1
opcache.enable_cli = 0
opcache.validate_timestamps = 1
opcache.revalidate_freq = 2

[curl]
curl.cainfo = "$caPath"

[openssl]
openssl.cafile = "$caPath"

[ExtensionList]
extension_dir = "$extensionDir"
extension=curl
extension=fileinfo
extension=gd
extension=intl
extension=mbstring
extension=openssl
extension=pdo_mysql
extension=zip
"@

    [System.IO.File]::WriteAllText($iniPath, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-PhpInstallation {
    param([string]$PhpPath)

    if ([string]::IsNullOrWhiteSpace($PhpPath) -or -not (Test-Path -LiteralPath $PhpPath)) {
        return $false
    }

    try {
        $versionResult = Invoke-CapturedNative -FilePath $PhpPath -Arguments @('-r', 'echo PHP_VERSION;')

        if ($versionResult.ExitCode -ne 0) {
            return $false
        }

        $versionText = $versionResult.Output.Trim()

        if ([string]::IsNullOrWhiteSpace($versionText)) {
            return $false
        }

        $version = [version]($versionText.Split('-')[0])

        if ($version -lt [version]'8.3.0') {
            return $false
        }

        $moduleResult = Invoke-CapturedNative -FilePath $PhpPath -Arguments @('-m')

        if ($moduleResult.ExitCode -ne 0) {
            return $false
        }

        $modules = @($moduleResult.Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

        foreach ($required in $script:RequiredPhpModules) {
            if ($modules -notcontains $required) {
                return $false
            }
        }

        return $true
    } catch {
        return $false
    }
}

function Get-PhpRuntime {
    param(
        [string]$HomeDir,
        [string]$ProjectRoot
    )

    $portablePhp = Join-Path $HomeDir 'tools\php\php.exe'
    $projectPhp = Join-Path $ProjectRoot 'tools\php\php.exe'

    foreach ($candidate in @($portablePhp, $projectPhp)) {
        if (-not (Test-Path -LiteralPath $candidate)) {
            continue
        }

        if (Test-PhpInstallation -PhpPath $candidate) {
            return $candidate
        }

        # A portable copy without a usable php.ini is the most common cause.
        $phpDir = Split-Path -Parent $candidate
        $bundle = Get-CaBundle -HomeDir $HomeDir
        Write-BootstrapPhpIni -PhpDir $phpDir -CaBundle $bundle

        if (Test-PhpInstallation -PhpPath $candidate) {
            Write-Ok 'Configured the portable PHP installation.'
            return $candidate
        }
    }

    $pathPhp = Get-Command php.exe -ErrorAction SilentlyContinue

    if ($pathPhp -and (Test-PhpInstallation -PhpPath $pathPhp.Source)) {
        return $pathPhp.Source
    }

    Write-Section 'Installing PHP 8.4'
    Write-Note 'PHP is not installed on this PC, so a portable copy is downloaded now.'

    $phpDir = Join-Path $HomeDir 'tools\php'
    $zip = Join-Path $HomeDir 'downloads\php-8.4-nts-Win32-vs17-x64.zip'

    Invoke-FileDownload -Url 'https://windows.php.net/downloads/releases/latest/php-8.4-nts-Win32-vs17-x64-latest.zip' `
        -Destination $zip -Label 'PHP 8.4' -MinimumBytes 10000000

    Expand-ZipToFolder -ZipPath $zip -Destination $phpDir -Label 'PHP 8.4'

    $bundle = Get-CaBundle -HomeDir $HomeDir
    Write-BootstrapPhpIni -PhpDir $phpDir -CaBundle $bundle

    if (Test-PhpInstallation -PhpPath $portablePhp) {
        return $portablePhp
    }

    # PHP needs the Visual C++ runtime. If it refused to start, install the
    # runtime once and try again before giving up.
    $probe = (Invoke-CapturedNative -FilePath $portablePhp -Arguments @('-v')).Output
    Install-VcRuntime -HomeDir $HomeDir
    Write-BootstrapPhpIni -PhpDir $phpDir -CaBundle $bundle

    if (Test-PhpInstallation -PhpPath $portablePhp) {
        return $portablePhp
    }

    Stop-Script 'The downloaded PHP could not start.' @(
        (($probe -split "`r?`n" | Select-Object -First 6) -join ' '),
        'Install the Microsoft Visual C++ 2015-2022 Redistributable (x64), then run this file again.'
    )
}

function Install-VcRuntime {
    param([string]$HomeDir)

    $system32 = Join-Path $env:SystemRoot 'System32'
    $required = @('vcruntime140.dll', 'msvcp140.dll')
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $system32 $_)) })

    if ($missing.Count -eq 0) {
        return
    }

    Write-Warn ('The Microsoft Visual C++ runtime is missing: ' + ($missing -join ', '))
    $installer = Join-Path $HomeDir 'downloads\vc_redist.x64.exe'

    Invoke-FileDownload -Url 'https://aka.ms/vs/17/release/vc_redist.x64.exe' `
        -Destination $installer -Label 'Microsoft Visual C++ runtime' -MinimumBytes 5000000

    Write-Note 'Installing the Microsoft Visual C++ runtime (Windows may ask for permission)...'

    try {
        $process = Start-Process -FilePath $installer -ArgumentList @('/install', '/quiet', '/norestart') `
            -Wait -PassThru -ErrorAction Stop

        if (@(0, 1638, 3010) -notcontains $process.ExitCode) {
            throw ('Setup exited with code ' + $process.ExitCode + '.')
        }
    } catch {
        Stop-Script 'The Microsoft Visual C++ runtime could not be installed.' @(
            $_.Exception.Message,
            'Install it manually from https://aka.ms/vs/17/release/vc_redist.x64.exe and run this file again.'
        )
    }

    Write-Ok 'Microsoft Visual C++ runtime installed.'
}

function Get-ComposerPhar {
    param(
        [string]$HomeDir,
        [string]$Php
    )

    $phar = Join-Path $HomeDir 'tools\downloads\composer.phar'

    if (Test-Path -LiteralPath $phar) {
        $versionResult = Invoke-CapturedNative -FilePath $Php -Arguments @($phar, '--version')

        if ($versionResult.ExitCode -eq 0 -and $versionResult.Output -match 'Composer\s+version') {
            return $phar
        }

        Write-Warn 'The saved Composer copy is not usable; downloading it again.'
        Remove-Item -LiteralPath $phar -Force -ErrorAction SilentlyContinue
    }

    Write-Section 'Installing Composer'
    Invoke-FileDownload -Url 'https://getcomposer.org/download/latest-stable/composer.phar' `
        -Destination $phar -Label 'Composer' -MinimumBytes 1000000

    $versionResult = Invoke-CapturedNative -FilePath $Php -Arguments @($phar, '--version')

    if ($versionResult.ExitCode -ne 0 -or $versionResult.Output -notmatch 'Composer\s+version') {
        Remove-Item -LiteralPath $phar -Force -ErrorAction SilentlyContinue
        Stop-Script 'Composer was downloaded but could not run.' @(
            'Check the internet connection and that PHP can use the openssl extension.'
        )
    }

    return $phar
}

function Get-IniValue {
    param(
        [string]$Path,
        [string]$Section,
        [string]$Key,
        [string]$Default = ''
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $Default
    }

    $currentSection = ''

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()

        if ($trimmed -match '^\[(.+)\]$') {
            $currentSection = $matches[1]
            continue
        }

        if ($currentSection -ne $Section) {
            continue
        }

        if ($trimmed -match ('^' + [regex]::Escape($Key) + '\s*=\s*(.*)$')) {
            return $matches[1].Trim()
        }
    }

    return $Default
}

function Set-MySqlIniPort {
    param(
        [string]$Path,
        [int]$Port
    )

    $lines = @(Get-Content -LiteralPath $Path)
    $result = New-Object 'System.Collections.Generic.List[string]'

    foreach ($line in $lines) {
        if ($line -match '^\s*port\s*=') {
            $result.Add('port=' + $Port)
        } else {
            $result.Add($line)
        }
    }

    [System.IO.File]::WriteAllLines($Path, $result, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-FreeTcpPort {
    param(
        [int]$StartPort,
        [int]$Attempts = 40
    )

    for ($port = $StartPort; $port -lt ($StartPort + $Attempts); $port++) {
        if (-not (Test-TcpPort -HostName '127.0.0.1' -PortNumber $port)) {
            return $port
        }
    }

    Stop-Script ('No free local port between ' + $StartPort + ' and ' + ($StartPort + $Attempts - 1) + '.') @(
        'Close the program that is using those ports, then run this file again.'
    )
}

function Test-MySqlProcessForIni {
    param([string]$MyIni)

    $normalizedIni = ($MyIni -replace '/', '\').ToLowerInvariant()

    foreach ($process in Get-CimInstance Win32_Process -Filter "Name='mysqld.exe'" -ErrorAction SilentlyContinue) {
        $commandLine = ([string]$process.CommandLine -replace '/', '\').ToLowerInvariant()

        if ($commandLine.Contains($normalizedIni)) {
            return $true
        }
    }

    return $false
}

function New-MySqlConfiguration {
    param(
        [string]$HomeDir,
        [string]$BaseDir,
        [int]$Port
    )

    $dataDir = Join-Path $HomeDir 'mysql-data'
    $tmpDir = Join-Path $HomeDir 'tmp'
    $logFile = Join-Path $HomeDir 'mysql-error.log'
    $pidFile = Join-Path $HomeDir 'mysql.pid'

    New-DirectoryIfMissing $dataDir
    New-DirectoryIfMissing $tmpDir

    $content = @"
[mysqld]
basedir=$($BaseDir -replace '\\', '/')
datadir=$($dataDir -replace '\\', '/')
port=$Port
bind-address=127.0.0.1
mysqlx=0
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
default-time-zone=+05:30
max_connections=100
innodb_buffer_pool_size=256M
log-error=$($logFile -replace '\\', '/')
pid-file=$($pidFile -replace '\\', '/')
tmpdir=$($tmpDir -replace '\\', '/')

[client]
port=$Port
host=127.0.0.1
"@

    [System.IO.File]::WriteAllText((Join-Path $HomeDir 'my.ini'), $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-MySqlRuntime {
    param([string]$HomeDir)

    $myIni = Join-Path $HomeDir 'my.ini'
    $mysqld = $null

    if (Test-Path -LiteralPath $myIni) {
        $configuredBase = Get-IniValue -Path $myIni -Section 'mysqld' -Key 'basedir'

        if (-not [string]::IsNullOrWhiteSpace($configuredBase)) {
            $candidate = Join-Path ($configuredBase -replace '/', '\') 'bin\mysqld.exe'

            if (Test-Path -LiteralPath $candidate) {
                $mysqld = $candidate
            }
        }
    }

    if (-not $mysqld) {
        foreach ($root in @(
            (Join-Path $HomeDir 'tools\mysql'),
            (Join-Path $HomeDir 'tools\mysql-8.4.9'),
            (Join-Path $HomeDir 'tools\mysql-extract'),
            (Join-Path $HomeDir 'tools')
        )) {
            if (-not (Test-Path -LiteralPath $root)) {
                continue
            }

            $found = Get-ChildItem -LiteralPath $root -Filter 'mysqld.exe' -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1

            if ($found) {
                $mysqld = $found.FullName
                break
            }
        }
    }

    if (-not $mysqld) {
        Write-Section 'Installing MySQL 8.4'
        Write-Note 'MySQL is not installed on this PC, so a portable copy is downloaded now.'
        Write-Note 'This is the largest download (about 280 MB) and runs only once.'

        $zip = Join-Path $HomeDir 'downloads\mysql-8.4.9-winx64.zip'
        $extractDir = Join-Path $HomeDir 'tools\mysql-8.4.9'

        Invoke-FileDownload -Url 'https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-8.4.9-winx64.zip' `
            -Destination $zip -Label 'MySQL 8.4.9' -MinimumBytes 100000000

        Expand-ZipToFolder -ZipPath $zip -Destination $extractDir -Label 'MySQL 8.4.9'

        $found = Get-ChildItem -LiteralPath $extractDir -Filter 'mysqld.exe' -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1

        if (-not $found) {
            Stop-Script 'The MySQL archive did not contain mysqld.exe.' @(
                'Delete this folder and run Start-App.bat again:',
                $extractDir
            )
        }

        $mysqld = $found.FullName
    }

    $baseDir = Split-Path -Parent (Split-Path -Parent $mysqld)
    $mysql = Join-Path $baseDir 'bin\mysql.exe'

    if (-not (Test-Path -LiteralPath $mysql)) {
        Stop-Script 'The MySQL client (mysql.exe) is missing.' @(
            'Delete the portable MySQL folder and run Start-App.bat again.',
            'Folder: ' + $baseDir
        )
    }

    return [pscustomobject]@{
        Mysqld    = $mysqld
        Mysql     = $mysql
        BaseDir   = $baseDir
        MyIni     = $myIni
        HomeDir   = $HomeDir
        DataDir   = (Join-Path $HomeDir 'mysql-data')
        ErrorLog  = (Join-Path $HomeDir 'mysql-error.log')
        Port      = 3306
    }
}

function Start-PortableMySql {
    param(
        [string]$Mysqld,
        [string]$MyIni,
        [string]$ErrorLog,
        [int]$Port
    )

    if (Test-TcpPort -HostName '127.0.0.1' -PortNumber $Port) {
        return
    }

    Write-Note 'Starting the local MySQL server...'

    $process = Start-Process -FilePath $Mysqld -ArgumentList @("--defaults-file=$MyIni") `
        -WindowStyle Hidden -PassThru

    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if (Test-TcpPort -HostName '127.0.0.1' -PortNumber $Port) {
            Write-Ok ('MySQL is running on 127.0.0.1:' + $Port + '.')
            return
        }

        if ($process.HasExited) {
            break
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    $details = @()

    if (Test-Path -LiteralPath $ErrorLog) {
        $details = @(Get-Content -LiteralPath $ErrorLog -Tail 15 -ErrorAction SilentlyContinue)
    }

    Stop-Script 'The local MySQL server did not start.' @(
        $details,
        'The full log is: ' + $ErrorLog
    )
}

function Initialize-MySqlDataDirectory {
    param(
        [string]$Mysqld,
        [string]$MyIni,
        [string]$DataDir,
        [string]$ErrorLog
    )

    if (Test-Path -LiteralPath (Join-Path $DataDir 'mysql')) {
        return
    }

    if (Test-Path -LiteralPath $DataDir) {
        $existing = @(Get-ChildItem -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue)

        if ($existing.Count -gt 0) {
            $broken = $DataDir + '.broken-' + (Get-Date).ToString('yyyyMMddHHmmss')
            Write-Warn 'A partial database folder was found; moving it aside.'
            Move-Item -LiteralPath $DataDir -Destination $broken -Force
        }
    }

    New-DirectoryIfMissing $DataDir
    Write-Note 'Initializing the local database (one time; this can take a minute)...'

    $initResult = Invoke-CapturedNative -FilePath $Mysqld `
        -Arguments @("--defaults-file=$MyIni", '--initialize-insecure', '--console')
    $output = $initResult.Output
    $exitCode = $initResult.ExitCode

    if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $DataDir 'mysql'))) {
        $details = @()

        if (Test-Path -LiteralPath $ErrorLog) {
            $details = @(Get-Content -LiteralPath $ErrorLog -Tail 15 -ErrorAction SilentlyContinue)
        }

        if ($details.Count -eq 0) {
            $details = @(($output -split "`r?`n" | Select-Object -First 15))
        }

        Stop-Script 'The local MySQL database could not be initialized.' @(
            $details,
            'Make sure the disk has free space, then run Start-App.bat again.'
        )
    }

    Write-Ok 'Local database initialized.'
}

function Invoke-MySqlClient {
    param(
        [string]$MySqlExe,
        [string[]]$ClientArguments = @(),
        [string]$Sql = ''
    )

    $arguments = @($ClientArguments)

    if (-not [string]::IsNullOrWhiteSpace($Sql)) {
        $arguments += @('-e', $Sql)
    }

    $output = Invoke-CapturedNative -FilePath $MySqlExe -Arguments $arguments

    return $output
}

function Test-MySqlClient {
    param(
        [string]$MySqlExe,
        [string[]]$ClientArguments = @()
    )

    $result = Invoke-MySqlClient -MySqlExe $MySqlExe -ClientArguments $ClientArguments -Sql 'SELECT 1;'

    return ($result.ExitCode -eq 0)
}

function Write-MySqlOptionFile {
    param(
        [string]$Path,
        [string]$User,
        [string]$Password,
        [int]$Port
    )

    $content = @"
[client]
user=$User
password=$Password
host=127.0.0.1
port=$Port
default-character-set=utf8mb4
"@

    [System.IO.File]::WriteAllText($Path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-OrCreateFileSecret {
    param(
        [string]$Path,
        [int]$Length = 32
    )

    if (Test-Path -LiteralPath $Path) {
        $saved = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)

        if ($saved) {
            $saved = $saved.Trim()

            if ($saved.Length -ge 16) {
                return $saved
            }
        }
    }

    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] $Length
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()

    try {
        $random.GetBytes($bytes)
    } finally {
        $random.Dispose()
    }

    $builder = New-Object System.Text.StringBuilder

    foreach ($byte in $bytes) {
        [void]$builder.Append($alphabet[$byte % $alphabet.Length])
    }

    $secret = $builder.ToString()
    [System.IO.File]::WriteAllText($Path, $secret, (New-Object System.Text.UTF8Encoding($false)))

    return $secret
}

function Initialize-MySqlCredentials {
    param(
        [pscustomobject]$MySqlRuntime,
        [string]$HomeDir
    )

    $database = 'app'
    $databaseUser = 'app'
    $appPassword = Get-OrCreateFileSecret -Path (Join-Path $HomeDir 'db-password.txt')
    $rootPassword = Get-OrCreateFileSecret -Path (Join-Path $HomeDir 'mysql-root-password.txt')

    $rootOptionFile = Join-Path $HomeDir 'mysql-root.cnf'
    $appOptionFile = Join-Path $HomeDir 'mysql-app.cnf'
    $baseArguments = @(
        '--protocol=TCP',
        '--host=127.0.0.1',
        ('--port=' + $MySqlRuntime.Port)
    )

    $hasRootAccess = $false

    if (Test-Path -LiteralPath $rootOptionFile) {
        $hasRootAccess = Test-MySqlClient -MySqlExe $MySqlRuntime.Mysql `
            -ClientArguments (@("--defaults-extra-file=$rootOptionFile") + $baseArguments)
    }

    if (-not $hasRootAccess) {
        $emptyRootArguments = @('--user=root', '--skip-password') + $baseArguments

        if (Test-MySqlClient -MySqlExe $MySqlRuntime.Mysql -ClientArguments $emptyRootArguments) {
            $sql = "ALTER USER 'root'@'localhost' IDENTIFIED BY '$rootPassword'; FLUSH PRIVILEGES;"
            $result = Invoke-MySqlClient -MySqlExe $MySqlRuntime.Mysql `
                -ClientArguments $emptyRootArguments -Sql $sql

            if ($result.ExitCode -ne 0) {
                Stop-Script 'The local MySQL root password could not be set.' @(
                    ($result.Output -split "`r?`n" | Select-Object -First 5)
                )
            }

            Write-MySqlOptionFile -Path $rootOptionFile -User 'root' -Password $rootPassword -Port $MySqlRuntime.Port

            $hasRootAccess = Test-MySqlClient -MySqlExe $MySqlRuntime.Mysql `
                -ClientArguments (@("--defaults-extra-file=$rootOptionFile") + $baseArguments)
        }
    }

    if (-not $hasRootAccess) {
        Stop-Script 'The local MySQL root account could not be opened.' @(
            'The saved MySQL root password does not match this database.',
            'If this is a fresh install, delete the folder below and run Start-App.bat again:',
            (Join-Path $HomeDir 'mysql-data')
        )
    }

    $sql = @"
CREATE DATABASE IF NOT EXISTS ``$database`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$databaseUser'@'localhost' IDENTIFIED BY '$appPassword';
ALTER USER '$databaseUser'@'localhost' IDENTIFIED BY '$appPassword';
CREATE USER IF NOT EXISTS '$databaseUser'@'127.0.0.1' IDENTIFIED BY '$appPassword';
ALTER USER '$databaseUser'@'127.0.0.1' IDENTIFIED BY '$appPassword';
GRANT ALL PRIVILEGES ON ``$database``.* TO '$databaseUser'@'localhost';
GRANT ALL PRIVILEGES ON ``$database``.* TO '$databaseUser'@'127.0.0.1';
FLUSH PRIVILEGES;
"@

    $result = Invoke-MySqlClient -MySqlExe $MySqlRuntime.Mysql `
        -ClientArguments (@("--defaults-extra-file=$rootOptionFile") + $baseArguments) -Sql $sql

    if ($result.ExitCode -ne 0) {
        Stop-Script 'The application database and user could not be created.' @(
            ($result.Output -split "`r?`n" | Select-Object -First 8)
        )
    }

    Write-MySqlOptionFile -Path $appOptionFile -User $databaseUser -Password $appPassword -Port $MySqlRuntime.Port

    if (-not (Test-MySqlClient -MySqlExe $MySqlRuntime.Mysql `
        -ClientArguments (@("--defaults-extra-file=$appOptionFile") + $baseArguments))) {
        Stop-Script 'The application database user was created but cannot sign in.' @(
            'Delete the folder below and run Start-App.bat again:',
            (Join-Path $HomeDir 'mysql-data')
        )
    }

    Write-Ok 'Database and application user are ready.'

    return [pscustomobject]@{
        Database = $database
        User     = $databaseUser
        Password = $appPassword
    }
}

function Initialize-PortableMySql {
    param([string]$HomeDir)

    $runtime = Get-MySqlRuntime -HomeDir $HomeDir

    if (-not (Test-Path -LiteralPath $runtime.MyIni)) {
        $port = Get-FreeTcpPort -StartPort 3306
        New-MySqlConfiguration -HomeDir $HomeDir -BaseDir $runtime.BaseDir -Port $port
        $runtime.Port = $port
    } else {
        $runtime.Port = [int](Get-IniValue -Path $runtime.MyIni -Section 'mysqld' -Key 'port' -Default '3306')
        $runtime.DataDir = Get-IniValue -Path $runtime.MyIni -Section 'mysqld' -Key 'datadir' -Default $runtime.DataDir
        $runtime.DataDir = $runtime.DataDir -replace '/', '\'
        $runtime.ErrorLog = Get-IniValue -Path $runtime.MyIni -Section 'mysqld' -Key 'log-error' -Default $runtime.ErrorLog
        $runtime.ErrorLog = $runtime.ErrorLog -replace '/', '\'
    }

    if (Test-TcpPort -HostName '127.0.0.1' -PortNumber $runtime.Port) {
        if (-not (Test-MySqlProcessForIni -MyIni $runtime.MyIni)) {
            $port = Get-FreeTcpPort -StartPort ($runtime.Port + 1)
            Write-Warn ('Port ' + $runtime.Port + ' is used by another program; MySQL will use ' + $port + '.')
            Set-MySqlIniPort -Path $runtime.MyIni -Port $port
            $runtime.Port = $port
        }
    }

    Initialize-MySqlDataDirectory -Mysqld $runtime.Mysqld -MyIni $runtime.MyIni `
        -DataDir $runtime.DataDir -ErrorLog $runtime.ErrorLog

    Start-PortableMySql -Mysqld $runtime.Mysqld -MyIni $runtime.MyIni `
        -ErrorLog $runtime.ErrorLog -Port $runtime.Port

    return $runtime
}

function Read-EnvironmentDatabase {
    param([string]$Path)

    $connection = Get-EnvValue -Path $Path -Key 'DB_CONNECTION' -Default 'mysql'
    $hostName = Get-EnvValue -Path $Path -Key 'DB_HOST' -Default '127.0.0.1'
    $portValue = Get-EnvValue -Path $Path -Key 'DB_PORT' -Default '3306'

    return [pscustomobject]@{
        Connection = $connection
        Host       = $hostName
        Port       = [int]$portValue
    }
}

function Start-DatabaseForEnvironment {
    param(
        [pscustomobject]$Database,
        [string]$HomeDir
    )

    if ($Database.Connection -ne 'mysql') {
        return
    }

    if (Test-TcpPort -HostName $Database.Host -PortNumber $Database.Port) {
        Write-Ok ('MySQL is running on ' + $Database.Host + ':' + $Database.Port + '.')
        return
    }

    if (@('127.0.0.1', 'localhost', '::1') -notcontains $Database.Host) {
        Stop-Script ('MySQL is not reachable at ' + $Database.Host + ':' + $Database.Port + '.') @(
            'Start that database server, then run this file again.',
            'Or update DB_HOST and DB_PORT in backend\.env.'
        )
    }

    $myIni = Join-Path $HomeDir 'my.ini'

    if (Test-Path -LiteralPath $myIni) {
        $baseDir = Get-IniValue -Path $myIni -Section 'mysqld' -Key 'basedir'
        $mysqld = Join-Path ($baseDir -replace '/', '\') 'bin\mysqld.exe'

        if (Test-Path -LiteralPath $mysqld) {
            $configuredPort = [int](Get-IniValue -Path $myIni -Section 'mysqld' -Key 'port' -Default '3306')

            if ($configuredPort -ne $Database.Port -and -not (Test-MySqlProcessForIni -MyIni $myIni)) {
                Set-MySqlIniPort -Path $myIni -Port $Database.Port
                $configuredPort = $Database.Port
            }

            $errorLog = Get-IniValue -Path $myIni -Section 'mysqld' -Key 'log-error' -Default (Join-Path $HomeDir 'mysql-error.log')
            $errorLog = $errorLog -replace '/', '\'

            Start-PortableMySql -Mysqld $mysqld -MyIni $myIni -ErrorLog $errorLog -Port $configuredPort

            if (Test-TcpPort -HostName $Database.Host -PortNumber $Database.Port) {
                return
            }
        }
    }

    $service = Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Stopped' } |
        Select-Object -First 1

    if ($service) {
        Write-Note ('Starting the ' + $service.Name + ' service...')

        try {
            Start-Service -Name $service.Name -ErrorAction Stop
        } catch {
            Write-Warn ('Windows could not start ' + $service.Name + '.')
        }

        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (Test-TcpPort -HostName $Database.Host -PortNumber $Database.Port) {
                Write-Ok 'MySQL started.'
                return
            }

            Start-Sleep -Milliseconds 500
        }
    }

    Stop-Script ('MySQL is not running at ' + $Database.Host + ':' + $Database.Port + '.') @(
        'Run Start-App.bat once without changing anything; it can start the portable MySQL copy.',
        'If the database runs somewhere else, update DB_HOST and DB_PORT in backend\.env.'
    )
}

function New-EnvironmentFile {
    param(
        [string]$Backend,
        [int]$DbPort,
        [string]$DbName,
        [string]$DbUser,
        [string]$DbPassword
    )

    $environmentPath = Join-Path $Backend '.env'
    Copy-Item -LiteralPath (Join-Path $Backend '.env.example') -Destination $environmentPath

    Set-EnvValues -Path $environmentPath -Values @{
        APP_NAME     = 'EduPlatform'
        APP_ENV      = 'local'
        APP_DEBUG    = 'false'
        APP_URL      = 'http://127.0.0.1:8000'
        DB_CONNECTION = 'mysql'
        DB_HOST      = '127.0.0.1'
        DB_PORT      = [string]$DbPort
        DB_DATABASE  = (Format-EnvValue $DbName)
        DB_USERNAME  = (Format-EnvValue $DbUser)
        DB_PASSWORD  = (Format-EnvValue $DbPassword)
        LOG_LEVEL    = 'debug'
    }
}

function Ensure-ApplicationDirectories {
    param([string]$Backend)

    $directories = @(
        'storage\app\public',
        'storage\framework\cache\data',
        'storage\framework\sessions',
        'storage\framework\views',
        'storage\logs',
        'bootstrap\cache'
    )

    foreach ($directory in $directories) {
        New-DirectoryIfMissing (Join-Path $Backend $directory)
    }
}

function Ensure-PublicStorageLink {
    param([string]$Backend)

    $link = Join-Path $Backend 'public\storage'
    $target = Join-Path $Backend 'storage\app\public'

    New-DirectoryIfMissing $target

    $existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue

    if ($existing) {
        if (Test-Path -LiteralPath $link) {
            return
        }

        # A broken junction (for example after moving the project folder) can
        # be replaced. A real directory is left alone because it may hold files.
        if ($existing.LinkType) {
            $null = Invoke-CapturedNative -FilePath 'cmd.exe' -Arguments @('/c', ('rmdir "' + $link + '"'))
        } else {
            return
        }
    }

    try {
        New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null
        Write-Ok 'Linked backend\public\storage.'
        return
    } catch {
        # Fall through to the command-line equivalent.
    }

    $linkResult = Invoke-CapturedNative -FilePath 'cmd.exe' `
        -Arguments @('/c', ('mklink /J "' + $link + '" "' + $target + '"'))
    $output = $linkResult.Output

    if (Test-Path -LiteralPath $link) {
        Write-Ok 'Linked backend\public\storage.'
        return
    }

    Write-Warn 'The public storage link could not be created.'
    Write-Note 'Uploaded photos will still save, but may not display until the folder is linked.'
    Write-Note ($output.Trim())
}

function Initialize-AppRuntime {
    param(
        [string]$ProjectRoot,
        [string]$Backend
    )

    Assert-AppPlatform

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $homeDir = Get-AppRuntimeHome

    foreach ($directory in @(
        $homeDir,
        (Join-Path $homeDir 'downloads'),
        (Join-Path $homeDir 'tools'),
        (Join-Path $homeDir 'tools\downloads'),
        (Join-Path $homeDir 'tmp')
    )) {
        New-DirectoryIfMissing $directory
    }

    Install-VcRuntime -HomeDir $homeDir

    $php = Get-PhpRuntime -HomeDir $homeDir -ProjectRoot $ProjectRoot
    $phpVersion = (Invoke-CapturedNative -FilePath $php -Arguments @('-r', 'echo PHP_VERSION;')).Output.Trim()
    Write-Ok ('PHP ' + $phpVersion + ' is ready.')

    $composerPhar = Get-ComposerPhar -HomeDir $homeDir -Php $php
    Write-Ok 'Composer is ready.'

    $environmentPath = Join-Path $Backend '.env'
    $firstRun = -not (Test-Path -LiteralPath $environmentPath)
    $database = $null

    if ($firstRun) {
        Write-Section 'First-time setup'
        Write-Note 'This PC has no configured database yet. Everything needed is prepared automatically.'

        $mysql = Initialize-PortableMySql -HomeDir $homeDir
        $credentials = Initialize-MySqlCredentials -MySqlRuntime $mysql -HomeDir $homeDir

        New-EnvironmentFile -Backend $Backend -DbPort $mysql.Port -DbName $credentials.Database `
            -DbUser $credentials.User -DbPassword $credentials.Password

        Write-Ok 'Created backend\.env with generated database credentials.'

        $database = [pscustomobject]@{
            Connection = 'mysql'
            Host       = '127.0.0.1'
            Port       = $mysql.Port
        }
    } else {
        $database = Read-EnvironmentDatabase -Path $environmentPath
        Start-DatabaseForEnvironment -Database $database -HomeDir $homeDir
    }

    Ensure-ApplicationDirectories -Backend $Backend
    Ensure-PublicStorageLink -Backend $Backend

    return [pscustomobject]@{
        Php          = $php
        PhpVersion   = $phpVersion
        ComposerPhar = $composerPhar
        Home         = $homeDir
        FirstRun     = $firstRun
        DbHost       = $database.Host
        DbPort       = $database.Port
    }
}
