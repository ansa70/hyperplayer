# Removes the HyperPlayer server that install-server.ps1 installed: the service, its firewall
# rule and its files, and (when asked) its settings and data in %ProgramData%\HyperPlayer.
# It's in the server's folder: Settings, Apps runs it, and so does install-server.ps1 -Uninstall.
$ErrorActionPreference = 'Stop'
$App = 'HyperPlayer'
$ServerDir = $PSScriptRoot
$ServerHome = Join-Path $env:ProgramData $App

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Settings, Apps starts it without administrator rights.
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit
}

Write-Host 'Removing the HyperPlayer server...'
& (Join-Path $ServerDir 'hyperplayer-service.exe') uninstall
if ($LASTEXITCODE -ne 0) { throw "hyperplayer-service uninstall failed ($LASTEXITCODE)" }
Get-NetFirewallRule -DisplayName 'HyperPlayer server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item -Recurse -Force "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$App server" -ErrorAction SilentlyContinue
# PowerShell has read this script: its folder can go.
Set-Location $env:TEMP
Remove-Item -Recurse -Force $ServerDir
# The installation folder too, unless the player is in it.
$installDir = Split-Path $ServerDir
if (-not (Get-ChildItem -Force $installDir)) { Remove-Item $installDir }

if (Test-Path (Join-Path $ServerHome 'server.env')) {
    $answer = Read-Host "Also delete the server's data (library database, accounts, certificate) and settings in $ServerHome? Keep them to install again later. [y/N]"
    if ($answer.Trim().ToLower() -in 'y', 'yes') { Remove-Item -Recurse -Force $ServerHome }
}
Write-Host 'The HyperPlayer server is removed.'
