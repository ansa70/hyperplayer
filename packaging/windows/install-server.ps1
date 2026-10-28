# Installs or updates the HyperPlayer server on Windows, as the installer's Server component
# does: the "HyperPlayer" service (hyperplayer-service.exe) with its own Node.js, sharp and
# ffmpeg, settings in %ProgramData%\HyperPlayer\server.env and its data next to them.
#
# In an administrator PowerShell (right-click Start, Terminal (Admin)):
#
#   irm https://github.com/ansa70/hyperplayer/releases/download/v<version>/install-server.ps1 | iex
#
# It asks for the settings, as the installer's pages do. Unattended, pass them instead
# (-Library, or -KeepSettings for an update, and nothing is asked):
#
#   & ([scriptblock]::Create((irm <url>))) -Library 'D:\Music;\\nas\Music' -Tls off
#   & ([scriptblock]::Create((irm <url>))) -KeepSettings
#   & ([scriptblock]::Create((irm <url>))) -Uninstall
#
# Started this way, the server's files aren't downloaded by a browser, so SmartScreen doesn't
# stop them. packaging/windows/build.sh fills in @VERSION@; -ZipPath installs a local
# hyperplayer-<version>-windows-x64-server.zip instead (for testing a build).
#
# Windows PowerShell 5.1 runs it: no PowerShell 7 syntax, ASCII only, and never exit (with
# irm | iex, that would close the window).
param(
    [string]$Library,
    [string]$SmbUser,
    [string]$SmbPassword,
    [int]$Port = 4533,
    [ValidateSet('self', 'files', 'off')][string]$Tls = 'self',
    [string]$TlsNames = $env:COMPUTERNAME,
    [string]$TlsCert,
    [string]$TlsKey,
    [switch]$NoEnrich,
    [string]$LastfmKey,
    [string]$LastfmSecret,
    [switch]$KeepSettings,
    [switch]$Uninstall,
    [string]$ZipPath
)

# In a scope of its own: with irm | iex, the script runs in the caller's.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $Version = '@VERSION@'
    $Release = "https://github.com/ansa70/hyperplayer/releases/download/v$Version"
    $Zip = "hyperplayer-$Version-windows-x64-server.zip"
    $App = 'HyperPlayer'
    $ServerHome = Join-Path $env:ProgramData $App
    $SettingsFile = Join-Path $ServerHome 'server.env'
    $InstallDir = Join-Path $env:ProgramFiles $App
    # Where the installer put HyperPlayer, if it did.
    $installed = Get-ItemProperty "HKLM:\Software\$App" -Name InstallDir -ErrorAction SilentlyContinue
    if ($installed) { $InstallDir = $installed.InstallDir }
    $ServerDir = Join-Path $InstallDir 'server'
    $Service = Join-Path $ServerDir 'hyperplayer-service.exe'

    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
        IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        throw 'Run this in an administrator PowerShell: right-click Start, choose Terminal (Admin), and run the command again.'
    }

    if ($Uninstall) {
        $script = Join-Path $ServerDir 'uninstall-server.ps1'
        if (-not (Test-Path $script)) { throw "The HyperPlayer server isn't installed here (no $script)." }
        & $script
        return
    }
    if ($Version.StartsWith('@') -and -not $ZipPath) {
        throw 'This copy of the script has no version: use the one from a release, or pass -ZipPath.'
    }

    function Ask([string]$question, [string]$default) {
        $hint = if ($default) { " [$default]" } else { '' }
        $answer = (Read-Host "$question$hint").Trim()
        if ($answer) { $answer } else { $default }
    }

    function AskYes([string]$question, [bool]$default) {
        $hint = if ($default) { 'Y/n' } else { 'y/N' }
        while ($true) {
            $answer = (Read-Host "$question [$hint]").Trim().ToLower()
            if (-not $answer) { return $default }
            if ($answer -in 'y', 'yes') { return $true }
            if ($answer -in 'n', 'no') { return $false }
        }
    }

    function AskSecret([string]$question) {
        $secure = Read-Host $question -AsSecureString
        [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }

    # A program that must succeed.
    function Run([string]$exe) {
        & $exe @args
        if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $exe) $args failed ($LASTEXITCODE)" }
    }

    Write-Host "HyperPlayer server $Version" -ForegroundColor Cyan
    $keep = [bool]$KeepSettings
    $interactive = -not $Library -and -not $keep
    $enrich = -not $NoEnrich

    if ($interactive -and (Test-Path $SettingsFile)) {
        $keep = AskYes 'A HyperPlayer server is already set up on this PC. Keep its settings?' $true
    }
    if ($keep -and -not (Test-Path $SettingsFile)) {
        throw "There are no settings to keep ($SettingsFile)."
    }

    if ($interactive -and -not $keep) {
        Write-Host ''
        Write-Host 'Music folders, separated by ; (for example D:\Music;\\nas\Music). The server only reads them,'
        Write-Host 'and notices new music by itself.'
        while (-not $Library) { $Library = Ask 'Music folders' '' }
        Write-Host 'Folders on a network share (\\server\share\...) are reached with this account. Leave it empty'
        Write-Host 'if the shares need none.'
        $SmbUser = Ask 'Username' ''
        if ($SmbUser) { $SmbPassword = AskSecret 'Password' }

        Write-Host ''
        while ($true) {
            $answer = Ask 'Port' "$Port"
            if ($answer -match '^\d{1,5}$' -and [int]$answer -ge 1 -and [int]$answer -le 65535) { break }
            Write-Host 'The port is a number from 1 to 65535.'
        }
        $Port = [int]$answer
        Write-Host 'HTTPS:'
        Write-Host '  1. Self-signed certificate (made by the server; players ask to trust it once)'
        Write-Host '  2. My own certificate files (PEM, e.g. from Let''s Encrypt)'
        Write-Host '  3. Off: a reverse proxy in front does HTTPS'
        do { $choice = Ask 'Choose 1-3' '1' } until ($choice -in '1', '2', '3')
        $Tls = @{ '1' = 'self'; '2' = 'files'; '3' = 'off' }[$choice]
        if ($Tls -eq 'self') { $TlsNames = Ask 'Names players use (comma-separated)' $TlsNames }
        if ($Tls -eq 'files') {
            do { $TlsCert = Ask 'Certificate (fullchain.pem)' '' } until ($TlsCert -and (Test-Path $TlsCert))
            do { $TlsKey = Ask 'Private key (privkey.pem)' '' } until ($TlsKey -and (Test-Path $TlsKey))
        }
    }

    # Shown whenever it asks, also when it keeps the settings.
    if ($interactive) {
        Write-Host ''
        Write-Host 'Privacy: HyperPlayer sends nothing about you or what you listen to anywhere you haven''t chosen.'
        Write-Host 'The player only talks to your server.'
        Write-Host 'To show credits, artist biographies and photos, cover art and lyrics, the server looks up the'
        Write-Host 'artists, albums and tracks in your library at MusicBrainz, the Cover Art Archive, Wikidata,'
        Write-Host 'Wikipedia, Wikimedia Commons and LRCLIB (and fanart.tv, if you give it a key). These lookups'
        Write-Host 'send artist names, album and track titles, track lengths and MusicBrainz ids, and the server''s'
        Write-Host 'internet address, as any web request does. They never include accounts or listening history.'
        Write-Host 'Scrobbling sends a user''s listens to ListenBrainz or Last.fm only after that user turns it on.'
        Write-Host 'The full privacy policy: https://github.com/ansa70/hyperplayer/blob/main/PRIVACY.md'
        if ($keep) {
            Write-Host "To turn the lookups off or on, set HP_ENRICH to false or true in $SettingsFile."
        } else {
            $enrich = AskYes 'Look up artist info, artwork and lyrics online?' $true
        }
    }

    if ($interactive -and -not $keep) {
        Write-Host ''
        Write-Host 'Last.fm (optional): scrobbling to Last.fm needs an API account for this server'
        Write-Host '(https://www.last.fm/api/account/create). Leave it empty to skip it; ListenBrainz works without.'
        $LastfmKey = Ask 'API key' ''
        if ($LastfmKey) { while (-not $LastfmSecret) { $LastfmSecret = AskSecret 'Shared secret' } }
    }

    if (-not $keep) {
        if ($Port -lt 1 -or $Port -gt 65535) { throw 'The port is a number from 1 to 65535.' }
        if ($Tls -eq 'files' -and -not ($TlsCert -and $TlsKey -and (Test-Path $TlsCert) -and (Test-Path $TlsKey))) {
            throw 'Pass the certificate and key files (-TlsCert, -TlsKey).'
        }
        if ($LastfmKey -and -not $LastfmSecret) { throw 'Pass the Last.fm shared secret too (-LastfmSecret).' }
    }

    # ------------------------------------------------------------------- files

    $work = Join-Path ([IO.Path]::GetTempPath()) "hyperplayer-server-$([Guid]::NewGuid())"
    New-Item -ItemType Directory $work | Out-Null
    try {
        if ($ZipPath) {
            $zipFile = (Resolve-Path $ZipPath).Path
        } else {
            Write-Host "Downloading $Zip..."
            [Net.ServicePointManager]::SecurityProtocol =
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $zipFile = Join-Path $work $Zip
            Invoke-WebRequest -UseBasicParsing "$Release/$Zip" -OutFile $zipFile
            $sums = (Invoke-WebRequest -UseBasicParsing "$Release/SHA256SUMS").Content
            if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
            $line = $sums -split "`n" | Where-Object { $_.TrimEnd() -like "* $Zip" -or $_.TrimEnd() -like "*`*$Zip" } |
                Select-Object -First 1
            if (-not ($line -match '^([0-9a-fA-F]{64})\s')) { throw "SHA256SUMS has no checksum for $Zip." }
            if ((Get-FileHash -Algorithm SHA256 $zipFile).Hash -ne $Matches[1]) {
                throw "The download of $Zip is damaged (its checksum doesn't match): run the command again."
            }
        }
        $unpacked = Join-Path $work 'server'
        Expand-Archive $zipFile -DestinationPath $unpacked

        Write-Host 'Stopping the server (if it''s running)...'
        if (Test-Path $Service) { Run $Service stop }
        # The bundle's file names change between versions: start from a clean folder.
        if (Test-Path $ServerDir) { Remove-Item -Recurse -Force $ServerDir }
        New-Item -ItemType Directory -Force $InstallDir | Out-Null
        Copy-Item -Recurse $unpacked $ServerDir
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }

    # ---------------------------------------------------------------- settings

    New-Item -ItemType Directory -Force (Join-Path $ServerHome 'data'), (Join-Path $ServerHome 'logs') | Out-Null
    # Administrators and the service's account only: the settings hold passwords.
    # (S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-5-19 LocalService.)
    Run icacls $ServerHome /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' /T /Q |
        Out-Null
    if (-not $keep) {
        $lines = @('# HyperPlayer server settings, written by the installer. After editing, restart the HyperPlayer service.')
        $lines += "HP_LIBRARY='$Library'"
        $lines += "HP_PORT='$Port'"
        $lines += "HP_HOST='0.0.0.0'"
        if ($Tls -eq 'off') {
            $lines += "HP_TLS='off'"
            # Behind a proxy: client addresses (for sign-in limits) come from X-Forwarded-For.
            $lines += "HP_TRUST_PROXY='true'"
        } else {
            $lines += "HP_TLS='on'"
        }
        if ($Tls -eq 'self' -and $TlsNames) { $lines += "HP_TLS_NAMES='$TlsNames'" }
        if ($Tls -eq 'files') {
            $lines += "HP_TLS_CERT='$((Resolve-Path $TlsCert).Path)'"
            $lines += "HP_TLS_KEY='$((Resolve-Path $TlsKey).Path)'"
        }
        if ($SmbUser) {
            $lines += "HP_SMB_USER='$SmbUser'"
            $lines += "HP_SMB_PASSWORD='$SmbPassword'"
        }
        $lines += "HP_ENRICH='$(if ($enrich) { 'true' } else { 'false' })'"
        if ($LastfmKey) {
            $lines += "HP_LASTFM_API_KEY='$LastfmKey'"
            $lines += "HP_LASTFM_SECRET='$LastfmSecret'"
        }
        # UTF-16 with a byte order mark, as the installer writes it: keeps any folder name intact.
        Set-Content -Path $SettingsFile -Value $lines -Encoding Unicode
    }

    # ----------------------------------------------------------------- service

    Write-Host 'Registering the HyperPlayer service...'
    Run $Service install
    # Players on the network reach node.exe, whatever the port.
    $rule = 'HyperPlayer server'
    Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Program (Join-Path $ServerDir 'node.exe') `
        -Profile Private, Domain | Out-Null
    # Settings, Apps removes it with the uninstall script the bundle brings.
    $key = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$App server"
    New-Item -Force $key | Out-Null
    $entry = @{
        DisplayName     = "$App server"
        DisplayVersion  = $Version
        Publisher       = 'Enrico Ansaloni'
        InstallLocation = $ServerDir
        UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ServerDir\uninstall-server.ps1`""
    }
    foreach ($name in $entry.Keys) { Set-ItemProperty $key -Name $name -Value $entry[$name] }
    Set-ItemProperty $key -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty $key -Name NoRepair -Value 1 -Type DWord
    Run $Service start

    Write-Host 'Waiting for the server to answer...'
    $status = & (Join-Path $ServerDir 'node.exe') (Join-Path $ServerDir 'server-status.mjs')
    Write-Host ''
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'The server is running. Connect players to:' -ForegroundColor Green
        $status | ForEach-Object { Write-Host "  $_" }
        Write-Host '(With a self-signed certificate, players show the second line, its fingerprint, and ask to trust it once.)'
        Write-Host 'First sign-in: username admin, password hyperplayer; you choose your own right away.'
        Write-Host 'Other computers reach it when this PC''s network is set to Private in Windows.'
    } else {
        Write-Host "The server was installed but didn't answer yet. Its log is in $ServerHome\logs (service.log, server.log)." -ForegroundColor Yellow
        Write-Host "If service.log says it couldn't start, an antivirus may be blocking it: allow $ServerDir in it." -ForegroundColor Yellow
    }
}
