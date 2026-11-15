# Packs the player for the Microsoft Store: release/hyperplayer-<version>-windows-x64.msix,
# from the hyperplayer.exe that `packaging/windows/build.sh stage` leaves in release/windows.
#
#   packaging/windows/build-msix.ps1
#
# Runs on Windows: makeappx comes with the Windows SDK. The package is unsigned, as the
# Store wants it: the Store signs it. It has the player's library engine (the server's
# code, which the player runs itself for the music on this PC) from release/windows/server,
# but not the Windows service: that stays in the installer and install-server.ps1.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot/../..").Path
$Version = (Select-String -Path "$Root/apps/client/Cargo.toml" -Pattern '^version = "(.*)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
# Four numbers, the last one 0 (the Store's own): 0.1.1 and 0.1.1-beta.2 are 0.1.1.0.
$PackageVersion = ($Version -replace '-.*$', '') + '.0'
$Stage = "$Root/release/msix"
$Out = "$Root/release/hyperplayer-$Version-windows-x64.msix"

$MakeAppx = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/makeappx.exe" |
    Where-Object { $_.Directory.Parent.Name -match '^\d+(\.\d+)+$' } |
    Sort-Object { [version]$_.Directory.Parent.Name } |
    Select-Object -Last 1
if (-not $MakeAppx) { throw 'makeappx.exe not found: install the Windows SDK' }

Write-Host '==> Store package'
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory $Stage | Out-Null
Copy-Item "$Root/release/windows/hyperplayer.exe" $Stage
# The library engine: everything but the service and its status check.
Copy-Item -Recurse "$Root/release/windows/server" "$Stage/server"
Remove-Item "$Stage/server/hyperplayer-service.exe", "$Stage/server/server-status.mjs"
Copy-Item -Recurse "$PSScriptRoot/msix/Assets" $Stage
(Get-Content -Raw "$PSScriptRoot/msix/AppxManifest.xml") -replace '@VERSION@', $PackageVersion |
    Set-Content -NoNewline -Encoding utf8 "$Stage/AppxManifest.xml"

& $MakeAppx.FullName pack /o /h SHA256 /d $Stage /p $Out
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Write-Host "==> $Out ($((Get-Item $Out).Length) bytes)"
