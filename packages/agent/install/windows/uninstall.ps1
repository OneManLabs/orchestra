param([switch]$Purge, [string]$InstallDir = "$env:ProgramFiles\Fleet Canvas\Agent")
$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir) -or $InstallDir -eq [IO.Path]::GetFullPath($env:ProgramFiles)) { throw 'Unsafe InstallDir.' }
$ServiceExe = Join-Path $InstallDir 'FleetCanvasAgentService.exe'
if (Test-Path $ServiceExe) {
  & $ServiceExe stop 2>$null
  & $ServiceExe uninstall 2>$null
}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
if ($Purge) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramData 'Fleet Canvas\agent') }
Write-Host 'Fleet Agent removed.'
